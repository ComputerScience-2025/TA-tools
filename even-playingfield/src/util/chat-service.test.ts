import { describe, expect, test } from "bun:test";

import { createZenFileSystem } from "../platform/web/zen-vfs.ts";
import { SessionStore } from "./session-store.ts";
import { ChatService } from "./chat-service.ts";
import { messageReasoning, messageText, userMessage } from "./chat-session.ts";
import type { ChatClient } from "./chat-service.ts";
import type { ChatSession } from "./chat-session.ts";
import type { ChatStreamResult } from "./llm.ts";

const METRICS = {
    model: "general_analysis",
    provider: "test",
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    finishReason: "stop",
    latencyMs: 12,
    attempts: 1,
};

function assistantReply(text: string, reasoning = "thinking"): ChatStreamResult {
    return {
        status: "succeeded",
        text,
        reasoning,
        responseMessages: [{
            role: "assistant",
            content: [
                { type: "reasoning", text: reasoning },
                { type: "text", text },
            ],
        }],
        metrics: METRICS,
    };
}

function createClient(script: (messages: readonly unknown[]) => ChatStreamResult): { client: ChatClient; calls: unknown[][] } {
    const calls: unknown[][] = [];
    const client: ChatClient = {
        async chatStream(_log, _warn, _model, _system, messages, handlers) {
            calls.push([...messages]);
            const result = script(messages);
            if (result.text.length > 0) {
                handlers?.onText?.(result.text);
            }
            if (result.reasoning.length > 0) {
                handlers?.onReasoning?.(result.reasoning);
            }
            return result;
        },
    };
    return { client, calls };
}

async function createSession(store: SessionStore): Promise<ChatSession> {
    return await store.create({
        id: "chat-test",
        origin: "web",
        workspace: "/ws",
        workflow: { slug: "analysis", kind: "analysis", run: 1, model: "general_analysis" },
        system_prompt: "You are grading.",
        messages: [
            userMessage("Initial request"),
            { role: "assistant", content: [{ type: "reasoning", text: "initial thought" }, { type: "text", text: "Initial review" }] },
        ],
        meta: [{ at: "2026-10-30T10:00:00.000Z", initial: true }, { at: "2026-10-30T10:00:00.000Z", metrics: METRICS }],
        outputs: [{ filename: "review.md" }],
    });
}

async function build(root: string, client: ChatClient, retainReasoning = true): Promise<{ store: SessionStore; service: ChatService }> {
    const mount = await createZenFileSystem({ persist: false, root });
    const store = new SessionStore(mount.fs, `${root}/sessions`);
    const service = new ChatService(store, client, { log: () => {}, warn: () => {} }, { retainReasoning });
    return { store, service };
}

describe("ChatService", () => {
    test("appends the user message and the assistant reply", async () => {
        const client = createClient(() => assistantReply("Follow-up answer"));
        const { store, service } = await build("/chat-send", client.client);
        const session = await createSession(store);

        const deltas: string[] = [];
        const outcome = await service.send(session, "  What about helper.cs?  ", { onText: (delta) => deltas.push(delta) });

        expect(outcome.status).toBe("succeeded");
        expect(deltas).toEqual(["Follow-up answer"]);
        expect(outcome.session.messages).toHaveLength(4);
        expect(messageText(outcome.session.messages[2]!)).toBe("What about helper.cs?");
        expect(messageText(outcome.session.messages[3]!)).toBe("Follow-up answer");
        expect(messageReasoning(outcome.session.messages[3]!)).toBe("thinking");
        expect(outcome.session.meta[3]!.metrics).toEqual(METRICS);

        const stored = await store.read(session.id);
        expect(stored!.messages).toHaveLength(4);
    });

    test("regenerate replaces the last assistant reply", async () => {
        const client = createClient(() => assistantReply("Second answer"));
        const { store, service } = await build("/chat-regen", client.client);
        const session = await createSession(store);
        const sent = await service.send(session, "question");

        const outcome = await service.regenerate(sent.session);

        expect(outcome.session.messages).toHaveLength(4);
        expect(messageText(outcome.session.messages[3]!)).toBe("Second answer");
        expect(client.calls).toHaveLength(2);
        // The second call receives the history without the old assistant turn.
        expect(client.calls[1]).toHaveLength(3);
    });

    test("edit truncates everything after the edited user message", async () => {
        const client = createClient(() => assistantReply("Edited answer"));
        const { store, service } = await build("/chat-edit", client.client);
        const session = await createSession(store);
        const sent = await service.send(session, "original question");

        const outcome = await service.edit(sent.session, 2, "edited question");

        expect(outcome.session.messages).toHaveLength(4);
        expect(messageText(outcome.session.messages[2]!)).toBe("edited question");
        expect(messageText(outcome.session.messages[3]!)).toBe("Edited answer");
    });

    test("rejects editing an assistant message", async () => {
        const client = createClient(() => assistantReply("x"));
        const { store, service } = await build("/chat-edit-error", client.client);
        const session = await createSession(store);

        await expect(service.edit(session, 1, "nope")).rejects.toThrow("Only user messages can be edited");
    });

    test("keeps partial output and marks the turn failed", async () => {
        const client = createClient(() => ({
            status: "failed",
            text: "half an answer",
            reasoning: "half a thought",
            responseMessages: [],
            metrics: null,
            error: "network reset",
        }));
        const { store, service } = await build("/chat-fail", client.client);
        const session = await createSession(store);

        const outcome = await service.send(session, "question");

        expect(outcome.status).toBe("failed");
        expect(outcome.error).toBe("network reset");
        expect(outcome.session.messages).toHaveLength(4);
        expect(messageText(outcome.session.messages[3]!)).toBe("half an answer");
        expect(outcome.session.meta[3]!.error).toBe("network reset");
    });

    test("keeps the user message when nothing was generated", async () => {
        const client = createClient(() => ({
            status: "failed",
            text: "",
            reasoning: "",
            responseMessages: [],
            metrics: null,
            error: "connection refused",
        }));
        const { store, service } = await build("/chat-empty", client.client);
        const session = await createSession(store);

        const outcome = await service.send(session, "question");

        expect(outcome.status).toBe("failed");
        expect(outcome.session.messages).toHaveLength(3);
        expect((await store.read(session.id))!.messages).toHaveLength(3);
    });

    test("omits reasoning parts when retention is disabled", async () => {
        const client = createClient(() => assistantReply("answer"));
        const { store, service } = await build("/chat-strip", client.client, false);
        const session = await createSession(store);

        const outcome = await service.send(session, "question");

        expect(messageReasoning(outcome.session.messages[3]!)).toBe("");
        expect(messageText(outcome.session.messages[3]!)).toBe("answer");
    });
});

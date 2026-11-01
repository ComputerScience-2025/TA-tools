import { describe, expect, test } from "bun:test";

import { Engine } from "./engine.ts";
import { CURRENT_CONFIG_VERSION, ConfigSchema } from "../util/config-schema.ts";
import { createZenFileSystem } from "../platform/web/zen-vfs.ts";
import { SessionStore } from "../util/session-store.ts";
import { assistantMessage, userMessage } from "../util/chat-session.ts";
import type { ChatClient } from "../util/chat-service.ts";
import type { Config } from "../util/config-schema.ts";
import type { Platform } from "../platform/types.ts";

function buildConfig(): Config {
    return ConfigSchema.parse({
        version: CURRENT_CONFIG_VERSION,
        output_viewing: { mode: "webui", api_port: 0, webui_base_url: "https://example.test" },
        llm: {
            providers: { test: { sdk: "openai", endpoint: "", api_key: "test-key" } },
            models: { general_analysis: { provider: "test", model_name: "test-model" } },
            prompt_replacement: {},
        },
        analysis_workflows: [],
        testing_workflows: [],
    });
}

function fakeChatClient(): ChatClient {
    return {
        async chatStream(_log, _warn, _model, _system, _messages, handlers) {
            handlers?.onText?.("Follow-up answer");
            handlers?.onReasoning?.("reasoned about it");
            return {
                status: "succeeded",
                text: "Follow-up answer",
                reasoning: "reasoned about it",
                responseMessages: [{
                    role: "assistant",
                    content: [
                        { type: "reasoning", text: "reasoned about it" },
                        { type: "text", text: "Follow-up answer" },
                    ],
                }],
                metrics: {
                    model: "general_analysis",
                    provider: "test",
                    promptTokens: 4,
                    completionTokens: 2,
                    totalTokens: 6,
                    finishReason: "stop",
                    latencyMs: 2,
                    attempts: 1,
                },
            };
        },
    };
}

async function buildEngine(root: string): Promise<{ engine: Engine; store: SessionStore; fs: Platform["fs"] }> {
    const mount = await createZenFileSystem({ persist: false, root });
    const platform: Platform = {
        fs: mount.fs,
        env: { get: () => undefined, set: () => {}, all: () => ({}) },
        shell: {
            available: false,
            run: async () => ({ stdout: "", stderr: "", exitCode: 0 }),
        },
        logger: { log: () => {} },
        toml: { parse: () => ({}) },
        homeDir: `${root}/home`,
    };
    const store = new SessionStore(mount.fs, `${root}/home/.even-pf/sessions`, { origin: "web" });
    const engine = new Engine(buildConfig(), platform, undefined, {
        sessionStore: store,
        chatClient: fakeChatClient(),
    });
    return { engine, store, fs: mount.fs };
}

async function createSession(store: SessionStore) {
    const at = "2026-10-30T10:15:00.000Z";
    return await store.create({
        id: "engine-test",
        origin: "cli",
        workspace: "/engine-test",
        workflow: { slug: "analysis", kind: "analysis", run: 1, model: "general_analysis" },
        system_prompt: "You are grading.",
        messages: [userMessage("Initial request"), assistantMessage("Initial review")],
        meta: [{ at, initial: true }, { at }],
        outputs: [],
        created_at: at,
    });
}

describe("Engine chat sessions", () => {
    test("lists, reads, chats and deletes a session", async () => {
        const { engine, store } = await buildEngine("/engine-chat-test");
        const session = await createSession(store);

        const summaries = await engine.listSessions();
        expect(summaries.map((summary) => summary.id)).toEqual([session.id]);
        expect((await engine.readSession(session.id))?.messages).toHaveLength(2);
        expect(await engine.findSessions("engine")).toHaveLength(1);
        expect((await engine.latestSession())?.id).toBe(session.id);

        const events: string[] = [];
        engine.addEventListener((event) => {
            if (event.type === "session-changed") {
                events.push(event.id);
            }
        });

        const deltas: string[] = [];
        const outcome = await engine.chatSession(session.id, "What about Helper.cs?", {
            onText: (delta) => deltas.push(delta),
        });

        expect(outcome.status).toBe("succeeded");
        expect(deltas).toEqual(["Follow-up answer"]);
        expect(outcome.session.messages).toHaveLength(4);
        expect(events).toEqual([session.id]);

        // The persisted copy matches what the outcome reported.
        expect((await engine.readSession(session.id))?.messages).toHaveLength(4);

        expect(await engine.deleteSession(session.id)).toBe(true);
        expect(events).toEqual([session.id, session.id]);
        expect(await engine.readSession(session.id)).toBeNull();
    });

    test("reports a missing session clearly", async () => {
        const { engine } = await buildEngine("/engine-chat-missing");
        await expect(engine.chatSession("does-not-exist", "hello")).rejects.toThrow("Unknown chat session");
    });
});

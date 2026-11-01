/**
 * Chat continuation over a recorded session.
 *
 * Pure orchestration between a {@link SessionStore} and a streaming LLM client:
 * it appends the user's turn, streams the reply, and persists the resulting
 * messages. Hosts only supply callbacks for live output and an abort signal.
 */

import { assistantMessage, stripReasoning, userMessage } from "./chat-session.ts";
import type { ChatSession, SessionMessageMeta } from "./chat-session.ts";
import type { ChatStreamHandlers, ChatStreamResult } from "./llm.ts";
import type { SessionStore } from "./session-store.ts";
import type { LogSink } from "../platform/types.ts";
import type { ModelMessage } from "ai";

/** The slice of `LlmClient` a chat needs. Structural, so tests can fake it. */
export type ChatClient = {
    chatStream(
        log: LogSink,
        warn: LogSink,
        model: string,
        systemPrompt: string,
        messages: ModelMessage[],
        handlers?: ChatStreamHandlers,
        signal?: AbortSignal,
    ): Promise<ChatStreamResult>;
};

export type ChatLogger = {
    log: (message: string, ...data: unknown[]) => void;
    warn: (message: string, ...data: unknown[]) => void;
};

export type ChatOutcome = {
    session: ChatSession;
    status: "succeeded" | "failed";
    error?: string;
};

export type ChatServiceOptions = {
    /** Store reasoning parts so the next turn can replay them (default true). */
    retainReasoning?: boolean;
};

export class ChatService {
    constructor(
        private readonly store: SessionStore,
        private readonly client: ChatClient,
        private readonly logger: ChatLogger,
        private readonly options: ChatServiceOptions = {},
    ) {}

    private get retainReasoning(): boolean {
        return this.options.retainReasoning ?? true;
    }

    /** Append a user message and stream the assistant reply. */
    async send(
        session: ChatSession,
        text: string,
        handlers: ChatStreamHandlers = {},
        signal?: AbortSignal,
    ): Promise<ChatOutcome> {
        const trimmed = text.trim();
        if (trimmed.length === 0) {
            throw new Error("Chat message must not be empty.");
        }
        const working = cloneSession(session);
        working.messages.push(userMessage(trimmed));
        working.meta.push({ at: new Date().toISOString() });
        // Persist the user's turn before the network call, so closing the tab
        // mid-stream keeps what they typed and lets them regenerate.
        await this.store.save(working);
        return await this.complete(working, handlers, signal);
    }

    /** Drop the last assistant reply (if any) and ask the model again. */
    async regenerate(
        session: ChatSession,
        handlers: ChatStreamHandlers = {},
        signal?: AbortSignal,
    ): Promise<ChatOutcome> {
        const index = lastUserIndex(session.messages);
        if (index === -1) {
            throw new Error("This session has no user message to regenerate from.");
        }
        const working = truncateSession(session, index + 1);
        await this.store.save(working);
        return await this.complete(working, handlers, signal);
    }

    /**
     * Replace a user message with new text and regenerate everything after it.
     * Editing is destructive: later turns are dropped, not branched.
     */
    async edit(
        session: ChatSession,
        messageIndex: number,
        text: string,
        handlers: ChatStreamHandlers = {},
        signal?: AbortSignal,
    ): Promise<ChatOutcome> {
        const trimmed = text.trim();
        if (trimmed.length === 0) {
            throw new Error("Chat message must not be empty.");
        }
        const target = session.messages[messageIndex];
        if (target === undefined) {
            throw new Error(`No message at index ${messageIndex}.`);
        }
        if (target.role !== "user") {
            throw new Error("Only user messages can be edited.");
        }

        const working = truncateSession(session, messageIndex + 1);
        working.messages[messageIndex] = userMessage(trimmed);
        working.meta[messageIndex] = {
            ...working.meta[messageIndex],
            at: new Date().toISOString(),
        };
        await this.store.save(working);
        return await this.complete(working, handlers, signal);
    }

    private async complete(
        working: ChatSession,
        handlers: ChatStreamHandlers,
        signal?: AbortSignal,
    ): Promise<ChatOutcome> {
        const result = await this.client.chatStream(
            this.logger.log,
            this.logger.warn,
            working.workflow.model,
            working.system_prompt,
            working.messages,
            handlers,
            signal,
        );

        const at = new Date().toISOString();
        if (result.status === "succeeded" && result.responseMessages.length > 0) {
            const messages = this.retainReasoning
                ? result.responseMessages
                : stripReasoning(result.responseMessages);
            appendAssistantMessages(working, messages, at, result.metrics);
        } else if (result.text.length > 0 || result.reasoning.length > 0) {
            // A failed stream still shows what the model managed to say; the
            // turn is marked so "Regenerate" can replace it.
            working.messages.push(assistantMessage(result.text, result.reasoning));
            working.meta.push({
                at,
                error: result.error ?? "The response was incomplete.",
            });
        } else if (result.status === "failed") {
            // Nothing to show. Keep the user's message so they can retry.
            return {
                session: working,
                status: "failed",
                error: result.error ?? "The model returned no output.",
            };
        }

        await this.store.save(working);
        return { session: working, status: result.status, error: result.error };
    }
}

function appendAssistantMessages(
    session: ChatSession,
    messages: readonly ModelMessage[],
    at: string,
    metrics: ChatStreamResult["metrics"],
): void {
    for (let index = 0; index < messages.length; index += 1) {
        const meta: SessionMessageMeta = { at };
        if (index === 0 && metrics !== null) {
            meta.metrics = metrics;
        }
        session.messages.push(messages[index]!);
        session.meta.push(meta);
    }
}

/** Shallow copy with fresh arrays so callers can mutate safely. */
export function cloneSession(session: ChatSession): ChatSession {
    return {
        ...session,
        workflow: { ...session.workflow },
        messages: [...session.messages],
        meta: [...session.meta],
        outputs: [...session.outputs],
    };
}

/** Keep the first `count` messages (and their metadata). */
export function truncateSession(session: ChatSession, count: number): ChatSession {
    const copy = cloneSession(session);
    copy.messages = copy.messages.slice(0, count);
    copy.meta = copy.meta.slice(0, count);
    return copy;
}

export function lastUserIndex(messages: readonly ModelMessage[]): number {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        if (messages[index]?.role === "user") {
            return index;
        }
    }
    return -1;
}

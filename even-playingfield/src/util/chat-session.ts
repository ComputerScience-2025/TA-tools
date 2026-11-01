/**
 * Chat sessions: the durable record of one analysis run plus every follow-up
 * exchange, so a user can continue the conversation the workflow started.
 *
 * The stored `messages` array is the AI SDK's own `ModelMessage` shape. Keeping
 * it verbatim is what makes provider reasoning reusable: reasoning parts carry
 * provider metadata (for example Anthropic signatures and OpenAI item ids) that
 * the SDK needs in order to send the assistant turn back unchanged.
 *
 * `meta` is parallel to `messages` (exactly one entry each) and holds the data
 * that does not belong in the model-facing transcript: timestamps, token
 * metrics, whether the turn is the initial workflow request, and stream errors.
 */

import { z } from "zod";

import type { ModelMessage } from "ai";
import type { CompletionMetrics } from "./llm.ts";

export const SESSION_VERSION = 1;

export type SessionOrigin = "cli" | "web";

/** Prefix used for the durable session directory inside the home directory. */
export const SESSION_DIRECTORY_NAME = ".even-pf";
export const SESSION_SUBDIRECTORY_NAME = "sessions";

export const SessionIdSchema = z
    .string()
    .min(1)
    .max(160)
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/, "Session id may only contain letters, numbers, dots, dashes and underscores");

// Keep this in sync with `CompletionMetrics` in llm.ts. It is defined here in
// schema form so a stored session can be validated without importing the LLM
// runtime (which pulls in provider SDKs).
export const CompletionMetricsSchema = z.object({
    model: z.string(),
    provider: z.string(),
    promptTokens: z.number(),
    completionTokens: z.number(),
    totalTokens: z.number(),
    finishReason: z.string(),
    latencyMs: z.number(),
    attempts: z.number(),
});

export type SessionMessageMeta = {
    /** ISO timestamp for when this message was added. */
    at: string;
    /** True for the initial workflow request (shown collapsed in the UI). */
    initial?: boolean;
    /** Files that made up the initial request, for display only. */
    files?: string[];
    /** Metrics for an assistant turn. */
    metrics?: CompletionMetrics;
    /** Why a turn is incomplete (stream failure or user abort). */
    error?: string;
};

export const SessionMessageMetaSchema: z.ZodType<SessionMessageMeta> = z.object({
    at: z.string(),
    initial: z.boolean().optional(),
    files: z.array(z.string()).optional(),
    metrics: CompletionMetricsSchema.optional(),
    error: z.string().optional(),
});

export type SessionWorkflow = {
    slug: string;
    kind: "analysis";
    run: number;
    /** Config key of the model, so a chat resolves the same provider settings. */
    model: string;
    /** Provider-reported model id, for display. */
    provider_model?: string;
    output_filename?: string;
};

export const SessionWorkflowSchema: z.ZodType<SessionWorkflow> = z.object({
    slug: z.string(),
    kind: z.literal("analysis"),
    run: z.number().int().min(1),
    model: z.string(),
    provider_model: z.string().optional(),
    output_filename: z.string().optional(),
});

const modelMessageSchema = z.custom<ModelMessage>((value) => {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const record = value as Record<string, unknown>;
    const role = record["role"];
    if (role !== "system" && role !== "user" && role !== "assistant" && role !== "tool") {
        return false;
    }
    const content = record["content"];
    return typeof content === "string" || Array.isArray(content);
}, { message: "Not an AI SDK model message" });

export type ChatSession = {
    version: number;
    id: string;
    created_at: string;
    updated_at: string;
    origin: SessionOrigin;
    /** Workspace (CLI working directory or browser workspace path) the run used. */
    workspace: string;
    workflow: SessionWorkflow;
    /** System prompt after prompt replacement. */
    system_prompt: string;
    messages: ModelMessage[];
    meta: SessionMessageMeta[];
    outputs: { filename: string }[];
};

export const ChatSessionSchema: z.ZodType<ChatSession> = z.object({
    version: z.literal(SESSION_VERSION),
    id: SessionIdSchema,
    created_at: z.string(),
    updated_at: z.string(),
    origin: z.enum(["cli", "web"]),
    workspace: z.string(),
    workflow: SessionWorkflowSchema,
    system_prompt: z.string(),
    messages: z.array(modelMessageSchema),
    meta: z.array(SessionMessageMetaSchema),
    outputs: z.array(z.object({ filename: z.string() })),
}).superRefine((value, ctx) => {
    if (value.meta.length !== value.messages.length) {
        ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: `Session has ${value.messages.length} message(s) but ${value.meta.length} metadata entr(ies)`,
            path: ["meta"],
        });
    }
});

export type ChatSessionSummary = {
    id: string;
    workflow_slug: string;
    kind: "analysis";
    run: number;
    model: string;
    origin: SessionOrigin;
    workspace: string;
    created_at: string;
    updated_at: string;
    /** Number of assistant replies (the initial workflow completion counts). */
    turns: number;
    /** Filenames this run and its chats wrote. */
    outputs: string[];
};

/** Input accepted by {@link SessionStore.create}. */
export type CreateChatSessionInput = {
    /** Suggested id. The store suffixes it when it already exists. */
    id: string;
    origin: SessionOrigin;
    workspace: string;
    workflow: SessionWorkflow;
    system_prompt: string;
    messages: ModelMessage[];
    meta: SessionMessageMeta[];
    outputs: { filename: string }[];
    created_at?: string;
};

/** Make an arbitrary slug safe for a filename. */
export function sanitizeSessionSlug(slug: string): string {
    const cleaned = slug.replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
    return (cleaned.length > 0 ? cleaned : "workflow").slice(0, 60);
}

/** `20261030-101500` in UTC, so ids do not depend on the host's timezone. */
export function sessionTimestamp(date: Date = new Date()): string {
    const iso = date.toISOString();
    return `${iso.slice(0, 4)}${iso.slice(5, 7)}${iso.slice(8, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}`;
}

/** Suggested id for a workflow run: `<timestamp>-<slug>-r<run>`. */
export function createSessionId(slug: string, run: number, date: Date = new Date()): string {
    return `${sessionTimestamp(date)}-${sanitizeSessionSlug(slug)}-r${run}`;
}

// --- Message helpers ---------------------------------------------------------

type MessagePart = { type?: string; text?: string };

function partsOf(message: ModelMessage): MessagePart[] {
    if (typeof message.content === "string") {
        return [{ type: "text", text: message.content }];
    }
    return message.content as MessagePart[];
}

/** Visible text of a message (user text, or an assistant's text parts). */
export function messageText(message: ModelMessage): string {
    return partsOf(message)
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("");
}

/** Reasoning text of an assistant message, or an empty string. */
export function messageReasoning(message: ModelMessage): string {
    return partsOf(message)
        .filter((part) => part.type === "reasoning" && typeof part.text === "string")
        .map((part) => part.text as string)
        .join("");
}

/** Build a user message. */
export function userMessage(text: string): ModelMessage {
    return { role: "user", content: text };
}

/** Build an assistant message from plain text (used for failed/aborted turns). */
export function assistantMessage(text: string, reasoning = ""): ModelMessage {
    const content: Array<{ type: "text"; text: string } | { type: "reasoning"; text: string }> = [];
    if (reasoning.length > 0) {
        content.push({ type: "reasoning", text: reasoning });
    }
    content.push({ type: "text", text });
    return { role: "assistant", content };
}

/**
 * Drop reasoning parts from assistant messages before storing them. Keeps the
 * text (and tool parts) so a chat can still continue where providers reject
 * replayed reasoning.
 */
export function stripReasoning(messages: readonly ModelMessage[]): ModelMessage[] {
    return messages.map((message) => {
        if (message.role !== "assistant" || typeof message.content === "string") {
            return message;
        }
        const content = message.content.filter((part) => part.type !== "reasoning");
        return { ...message, content } as ModelMessage;
    });
}

/** One row per message, e.g. for a transcript view. */
export type TranscriptEntry = {
    index: number;
    role: ModelMessage["role"];
    text: string;
    reasoning: string;
    meta: SessionMessageMeta | undefined;
};

export function buildTranscript(session: ChatSession): TranscriptEntry[] {
    return session.messages.map((message, index) => ({
        index,
        role: message.role,
        text: messageText(message),
        reasoning: messageReasoning(message),
        meta: session.meta[index],
    }));
}

export function summarizeSession(session: ChatSession): ChatSessionSummary {
    return {
        id: session.id,
        workflow_slug: session.workflow.slug,
        kind: session.workflow.kind,
        run: session.workflow.run,
        model: session.workflow.model,
        origin: session.origin,
        workspace: session.workspace,
        created_at: session.created_at,
        updated_at: session.updated_at,
        turns: session.messages.filter((message) => message.role === "assistant").length,
        outputs: session.outputs.map((output) => output.filename),
    };
}

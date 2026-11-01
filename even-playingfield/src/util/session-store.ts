/**
 * Durable chat-session storage.
 *
 * One JSON file per session in a directory under the platform's home directory
 * (`~/.even-pf/sessions` on the CLI, `/epf/home/sessions` in the browser). The
 * directory sits outside the quota-evicted workspace tree, so chat history is
 * kept when a workspace is cleaned up.
 *
 * The store is platform-agnostic: it only uses {@link VirtualFileSystem}, so
 * the same implementation runs under Bun and in the browser.
 */

import { joinPath } from "../platform/path.ts";
import { errorMessage } from "./errors.ts";
import {
    ChatSessionSchema,
    SESSION_DIRECTORY_NAME,
    SESSION_SUBDIRECTORY_NAME,
    SESSION_VERSION,
    SessionIdSchema,
    createSessionId,
    sanitizeSessionSlug,
    summarizeSession,
} from "./chat-session.ts";
import type { ChatSession, ChatSessionSummary, CreateChatSessionInput, SessionOrigin } from "./chat-session.ts";
import type { VirtualFileSystem } from "../platform/types.ts";

export type SessionStoreOptions = {
    /** Recorded on sessions this store creates. */
    origin?: SessionOrigin;
    /** Called for each unreadable session file instead of swallowing it. */
    onWarning?: (message: string) => void;
};

const SESSION_FILE_SUFFIX = ".json";

/** Suggested session directory below a home directory. */
export function sessionDirectory(homeDir: string, subdirectory = SESSION_SUBDIRECTORY_NAME): string {
    return joinPath(homeDir, SESSION_DIRECTORY_NAME, subdirectory);
}

export class SessionStore {
    readonly directory: string;
    readonly origin: SessionOrigin;
    private readonly onWarning: (message: string) => void;

    constructor(
        private readonly fs: VirtualFileSystem,
        directory: string,
        options: SessionStoreOptions = {},
    ) {
        this.directory = directory;
        this.origin = options.origin ?? "cli";
        this.onWarning = options.onWarning ?? (() => {});
    }

    private pathFor(id: string): string {
        const parsed = SessionIdSchema.safeParse(id);
        if (!parsed.success) {
            throw new Error(`Invalid session id "${id}": ${parsed.error.issues[0]?.message ?? "bad format"}`);
        }
        return joinPath(this.directory, `${id}${SESSION_FILE_SUFFIX}`);
    }

    private isSessionFile(name: string): boolean {
        return name.endsWith(SESSION_FILE_SUFFIX) && !name.startsWith(".");
    }

    /** All readable sessions, newest first. Unreadable files are reported. */
    async list(): Promise<ChatSession[]> {
        // The directory does not exist until the first session is written.
        if (!await this.fs.exists(this.directory)) {
            return [];
        }
        const entries = await this.fs.list(this.directory);

        const sessions: ChatSession[] = [];
        for (const entry of entries) {
            if (entry.kind !== "file" || !this.isSessionFile(entry.name)) {
                continue;
            }
            const path = joinPath(this.directory, entry.name);
            try {
                sessions.push(this.parse(await this.fs.readText(path), path));
            } catch (error) {
                const message = errorMessage(error);
                this.onWarning(`Skipping unreadable chat session '${entry.name}': ${message}`);
            }
        }
        sessions.sort((a, b) => b.updated_at.localeCompare(a.updated_at));
        return sessions;
    }

    async listSummaries(): Promise<ChatSessionSummary[]> {
        return (await this.list()).map(summarizeSession);
    }

    async read(id: string): Promise<ChatSession | null> {
        const path = this.pathFor(id);
        if (!await this.fs.exists(path)) {
            return null;
        }
        return this.parse(await this.fs.readText(path), path);
    }

    /**
     * Find a session by exact id or unique prefix. Returns every match so the
     * caller can report an ambiguous reference instead of picking silently.
     */
    async find(query: string, sessions?: readonly ChatSession[]): Promise<ChatSession[]> {
        const needle = query.trim();
        if (needle.length === 0) {
            return [];
        }
        const all = sessions ?? await this.list();
        const exact = all.find((session) => session.id === needle);
        if (exact !== undefined) {
            return [exact];
        }
        return all.filter((session) => session.id.startsWith(needle));
    }

    /** Most recently updated session, or null when none exists. */
    async latest(): Promise<ChatSession | null> {
        const sessions = await this.list();
        return sessions[0] ?? null;
    }

    /** Write a new session, suffixing the suggested id on collision. */
    async create(input: CreateChatSessionInput): Promise<ChatSession> {
        const now = input.created_at ?? new Date().toISOString();
        const id = await this.uniqueId(input.id);
        const session: ChatSession = {
            version: SESSION_VERSION,
            id,
            created_at: now,
            updated_at: now,
            origin: input.origin,
            workspace: input.workspace,
            workflow: input.workflow,
            system_prompt: input.system_prompt,
            messages: input.messages,
            meta: input.meta,
            outputs: input.outputs,
        };
        await this.save(session);
        return session;
    }

    /** Persist a session, refreshing `updated_at` on the given object. */
    async save(session: ChatSession): Promise<void> {
        session.updated_at = new Date().toISOString();
        const validated = ChatSessionSchema.parse(session);
        await this.fs.writeText(this.pathFor(validated.id), `${JSON.stringify(validated, null, 2)}\n`);
    }

    async delete(id: string): Promise<boolean> {
        const path = this.pathFor(id);
        if (!await this.fs.exists(path)) {
            return false;
        }
        await this.fs.remove(path);
        return true;
    }

    /** Delete every session in the directory. Returns the ids removed. */
    async clear(): Promise<string[]> {
        const sessions = await this.list();
        const removed: string[] = [];
        for (const session of sessions) {
            try {
                await this.fs.remove(this.pathFor(session.id));
                removed.push(session.id);
            } catch (error) {
                const message = errorMessage(error);
                this.onWarning(`Could not remove chat session '${session.id}': ${message}`);
            }
        }
        return removed;
    }

    private async uniqueId(suggested: string): Promise<string> {
        const base = suggested.length > 0 ? suggested : createSessionId("session", 1);
        let candidate = base;
        let suffix = 2;
        while (await this.fs.exists(this.pathFor(candidate))) {
            candidate = `${base}-${suffix}`;
            suffix += 1;
            if (suffix > 1000) {
                throw new Error(`Could not find a free session id for "${sanitizeSessionSlug(base)}"`);
            }
        }
        return candidate;
    }

    private parse(text: string, path: string): ChatSession {
        let raw: unknown;
        try {
            raw = JSON.parse(text);
        } catch (error) {
            const message = errorMessage(error);
            throw new Error(`Invalid JSON in ${path}: ${message}`);
        }
        const parsed = ChatSessionSchema.safeParse(raw);
        if (!parsed.success) {
            const issue = parsed.error.issues[0];
            throw new Error(`Invalid session in ${path}: ${issue?.path.join(".") ?? "?"} — ${issue?.message ?? "bad shape"}`);
        }
        return parsed.data;
    }
}

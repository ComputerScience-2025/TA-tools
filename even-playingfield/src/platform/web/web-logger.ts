/**
 * Logger for the browser: a bounded ring buffer that the console pane renders,
 * mirrored to the devtools console.
 */

import type { LogEntry, LogLevel, Logger, LogMeta } from "../types.ts";

export const MAX_LOG_ENTRIES = 2000;
const MAX_DETAIL_CHARS = 2000;

function formatDetail(data: unknown[] | undefined): string | undefined {
    if (!data || data.length === 0) {
        return undefined;
    }
    const parts: string[] = [];
    for (const value of data) {
        const text = typeof value === "string" ? value : safeStringify(value);
        parts.push(text);
    }
    const joined = parts.join(" ").trim();
    if (joined.length === 0) {
        return undefined;
    }
    return joined.length > MAX_DETAIL_CHARS ? `${joined.slice(0, MAX_DETAIL_CHARS)}…` : joined;
}

function safeStringify(value: unknown): string {
    try {
        return JSON.stringify(value) ?? String(value);
    } catch {
        return String(value);
    }
}

export type LogListener = (entry: LogEntry) => void;

export class WebLogBuffer implements Logger {
    private entries: LogEntry[] = [];
    private readonly listeners: Set<LogListener> = new Set();

    log(level: LogLevel, message: string, meta?: LogMeta): void {
        const entry: LogEntry = {
            level,
            message,
            detail: formatDetail(meta?.data),
            slug: meta?.slug,
            time: Date.now(),
        };

        this.entries.push(entry);
        if (this.entries.length > MAX_LOG_ENTRIES) {
            this.entries.splice(0, this.entries.length - MAX_LOG_ENTRIES);
        }

        // Mirror to devtools so browser debugging stays possible.
        const line = entry.slug ? `[${entry.slug}] ${message}${entry.detail ? ` ${entry.detail}` : ""}` : `${message}${entry.detail ? ` ${entry.detail}` : ""}`;
        if (level === "warn") {
            console.warn(line);
        } else if (level === "error") {
            console.error(line);
        } else if (level === "debug") {
            console.debug(line);
        } else {
            console.log(line);
        }

        for (const listener of this.listeners) {
            try {
                listener(entry);
            } catch (error) {
                console.error("log listener failed", error);
            }
        }
    }

    getEntries(): LogEntry[] {
        return [...this.entries];
    }

    clear(): void {
        this.entries = [];
    }

    subscribe(listener: LogListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }
}

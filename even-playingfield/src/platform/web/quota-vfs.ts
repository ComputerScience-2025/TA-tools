/**
 * Storage-cap and cleanup policy for the browser filesystem.
 *
 * Implemented as a decorator around the ZenFS-backed filesystem so the policy
 * can be unit-tested without a browser. Decisions are made per workspace (not
 * per file) to stay predictable:
 *
 *   - a single write larger than `maxFileBytes` is refused with a catchable error;
 *   - unpinned, inactive workspaces older than `sourceTtlDays` are removed on startup;
 *   - when total usage exceeds `maxTotalBytes`, the oldest unpinned, inactive
 *     workspaces are removed until usage drops to 80 % of the cap;
 *   - the active workspace is never removed, so a running analysis cannot lose
 *     its inputs (the UI warns instead).
 */

import type { DirEntry, FileStat, VirtualFileSystem } from "../types.ts";
import type { StorageSettings, WorkspaceState } from "./web-state.ts";

/** Fraction of the cap that eviction tries to reach. */
const EVICTION_TARGET = 0.8;

const MAX_WALK_DEPTH = 32;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

export class FileTooLargeError extends Error {
    constructor(
        readonly path: string,
        readonly size: number,
        readonly limit: number,
    ) {
        super(`File '${path}' is ${formatBytes(size)}, above the ${formatBytes(limit)} per-file limit.`);
        this.name = "FileTooLargeError";
    }
}

export type QuotaEvent =
    | { type: "evicted"; path: string; label: string; bytes: number; reason: "cap" | "ttl" }
    | { type: "over-cap"; usage: number; limit: number }
    | { type: "rejected"; path: string; size: number; limit: number };

export type QuotaContext = {
    settings(): StorageSettings;
    workspaces(): WorkspaceState[];
    activeWorkspace(): string | null;
    /** Delete a workspace from both the filesystem and the workspace index. */
    removeWorkspace(path: string): Promise<void>;
    onEvent?(event: QuotaEvent): void;
};

export function formatBytes(bytes: number): string {
    if (bytes < 1024) {
        return `${bytes} B`;
    }
    const units = ["KB", "MB", "GB", "TB"];
    let value = bytes / 1024;
    let unitIndex = 0;
    while (value >= 1024 && unitIndex < units.length - 1) {
        value /= 1024;
        unitIndex++;
    }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unitIndex]}`;
}

export class QuotaFileSystem implements VirtualFileSystem {
    private cachedUsage: number | null = null;

    constructor(
        private readonly inner: VirtualFileSystem,
        private readonly context: QuotaContext,
    ) {}

    get root(): string {
        return this.inner.root;
    }

    async readText(path: string): Promise<string> {
        return await this.inner.readText(path);
    }

    async readBytes(path: string): Promise<Uint8Array> {
        return await this.inner.readBytes(path);
    }

    async writeText(path: string, content: string): Promise<void> {
        const size = byteLength(content);
        this.checkFileSize(path, size);
        const previous = await this.measureFile(path);
        await this.inner.writeText(path, content);
        this.applyDelta(size - previous);
        await this.enforceBudget();
    }

    async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
        this.checkFileSize(path, bytes.byteLength);
        const previous = await this.measureFile(path);
        await this.inner.writeBytes(path, bytes);
        this.applyDelta(bytes.byteLength - previous);
        await this.enforceBudget();
    }

    async exists(path: string): Promise<boolean> {
        return await this.inner.exists(path);
    }

    async stat(path: string): Promise<FileStat | null> {
        return await this.inner.stat(path);
    }

    async list(path: string): Promise<DirEntry[]> {
        return await this.inner.list(path);
    }

    async mkdir(path: string): Promise<void> {
        await this.inner.mkdir(path);
    }

    async remove(path: string, opts?: { recursive?: boolean }): Promise<void> {
        await this.inner.remove(path, opts);
        // The next usage() re-measures rather than guessing at what was removed.
        this.cachedUsage = null;
    }

    /** Current total bytes, measured from the tree. */
    async usage(): Promise<number> {
        if (this.cachedUsage === null) {
            this.cachedUsage = await this.measure();
        }
        return this.cachedUsage;
    }

    /** Remove workspaces whose TTL has expired. Returns the removal events. */
    async cleanupExpired(now: number = Date.now()): Promise<QuotaEvent[]> {
        const settings = this.context.settings();
        const ttlMs = settings.sourceTtlDays * MS_PER_DAY;
        const active = this.context.activeWorkspace();
        const events: QuotaEvent[] = [];

        for (const workspace of this.context.workspaces()) {
            if (workspace.pinned || workspace.path === active) {
                continue;
            }
            if (now - workspace.lastUsedAt < ttlMs) {
                continue;
            }
            const bytes = await this.measureDirectory(workspace.path);
            await this.context.removeWorkspace(workspace.path);
            this.cachedUsage = null;
            const event: QuotaEvent = {
                type: "evicted",
                path: workspace.path,
                label: workspace.label,
                bytes,
                reason: "ttl",
            };
            events.push(event);
            this.context.onEvent?.(event);
        }

        return events;
    }

    /** Evict oldest workspaces until usage is back under the cap. */
    async enforceBudget(): Promise<void> {
        const settings = this.context.settings();
        let usage = await this.usage();
        if (usage <= settings.maxTotalBytes) {
            return;
        }

        const active = this.context.activeWorkspace();
        const candidates = this.context.workspaces()
            .filter((workspace) => !workspace.pinned && workspace.path !== active)
            .sort((a, b) => a.lastUsedAt - b.lastUsedAt);

        const target = Math.floor(settings.maxTotalBytes * EVICTION_TARGET);
        for (const workspace of candidates) {
            if (usage <= target) {
                break;
            }
            const bytes = await this.measureDirectory(workspace.path);
            await this.context.removeWorkspace(workspace.path);
            usage -= bytes;
            this.cachedUsage = usage;
            const event: QuotaEvent = {
                type: "evicted",
                path: workspace.path,
                label: workspace.label,
                bytes,
                reason: "cap",
            };
            this.context.onEvent?.(event);
        }

        this.cachedUsage = await this.measure();
        if (this.cachedUsage > settings.maxTotalBytes) {
            // Everything removable is gone; the active workspace keeps its files
            // and the UI surfaces the warning instead of deleting user work.
            this.context.onEvent?.({
                type: "over-cap",
                usage: this.cachedUsage,
                limit: settings.maxTotalBytes,
            });
        }
    }

    private checkFileSize(path: string, size: number): void {
        const limit = this.context.settings().maxFileBytes;
        if (size > limit) {
            this.context.onEvent?.({ type: "rejected", path, size, limit });
            throw new FileTooLargeError(path, size, limit);
        }
    }

    /** Current size of a file, or 0 when it does not exist yet (or is unknown). */
    private async measureFile(path: string): Promise<number> {
        const info = await this.inner.stat(path);
        return info !== null && info.kind === "file" ? info.size : 0;
    }

    /**
     * Apply a size change for an overwrite. When usage has not been measured yet
     * it stays unknown, and the next usage() call measures the whole tree.
     */
    private applyDelta(delta: number): void {
        if (this.cachedUsage !== null) {
            this.cachedUsage = Math.max(0, this.cachedUsage + delta);
        }
    }

    /** Sum of file sizes under the workspace root. */
    private async measure(): Promise<number> {
        return await this.measureDirectory(this.inner.root);
    }

    private async measureDirectory(path: string, depth = 1): Promise<number> {
        if (depth > MAX_WALK_DEPTH) {
            return 0;
        }
        let total = 0;
        let entries: DirEntry[];
        try {
            entries = await this.inner.list(path);
        } catch {
            return 0;
        }
        for (const entry of entries) {
            if (entry.kind === "directory") {
                total += await this.measureDirectory(`${path.replace(/\/+$/, "")}/${entry.name}`, depth + 1);
            } else {
                total += entry.size;
            }
        }
        return total;
    }
}

/** Byte length of a string in UTF-8, matching what the store actually keeps. */
function byteLength(value: string): number {
    return new TextEncoder().encode(value).length;
}

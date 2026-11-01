/**
 * `VirtualFileSystem` over @zenfs/core — the browser implementation.
 *
 * ZenFS provides a node-compatible `fs.promises` surface over pluggable
 * backends. The browser mounts the IndexedDB backend so files survive reloads,
 * and falls back to InMemory when IndexedDB is unavailable (private window,
 * blocked storage) so the app still works for the session.
 */

import { configure, fs as zenFs, InMemory } from "@zenfs/core";
import { IndexedDB } from "@zenfs/dom";

import { dirnamePath, joinPath, resolvePath } from "../path.ts";
import { errorMessage } from "../../util/errors.ts";
import type { DirEntry, FileStat, VirtualFileSystem } from "../types.ts";

/** Workspace root inside the ZenFS tree. */
export const WEB_WORKSPACE_ROOT = "/epf";

export type ZenMountOptions = {
    /** Mount IndexedDB for persistence (default true). */
    persist?: boolean;
    storeName?: string;
    root?: string;
    /**
     * Read-only mounts never write to the store, so a second tab can read what
     * the tab holding the write lock produced.
     */
    writeAccess?: boolean;
};

export type ZenMount = {
    fs: ZenFileSystem;
    /** False when the mount had to fall back to memory. */
    persistent: boolean;
    root: string;
    /** Why the IndexedDB mount was not used, when it failed. */
    fallbackReason?: string;
};

/**
 * Configure the process-wide ZenFS mount and wrap it.
 *
 * ZenFS keeps one global context per page, so this is called once per session
 * (and once per test that needs a fresh tree).
 */
export async function createZenFileSystem(options: ZenMountOptions = {}): Promise<ZenMount> {
    const root = options.root ?? WEB_WORKSPACE_ROOT;
    const storeName = options.storeName ?? "epf";
    const wantPersist = options.persist ?? true;
    let persistent = false;
    let fallbackReason: string | undefined;

    if (wantPersist) {
        try {
            await configure({ mounts: { "/": { backend: IndexedDB, storeName } } });
            persistent = true;
        } catch (error) {
            fallbackReason = errorMessage(error);
            await configure({ mounts: { "/": InMemory } });
        }
    } else {
        await configure({ mounts: { "/": InMemory } });
    }

    const fs = new ZenFileSystem(root);
    if (options.writeAccess !== false) {
        await fs.mkdir(root);
    }
    return { fs, persistent, root, fallbackReason };
}

type ZenStats = {
    size: number;
    mtimeMs: number;
    isDirectory(): boolean;
};

type ZenDirent = {
    name: string;
    isDirectory(): boolean;
};

export class ZenFileSystem implements VirtualFileSystem {
    readonly root: string;

    constructor(root: string = WEB_WORKSPACE_ROOT) {
        this.root = root;
    }

    /** Absolute ZenFS path for a VFS path (absolute or root-relative). */
    private resolve(path: string): string {
        return resolvePath(this.root, path);
    }

    async readText(path: string): Promise<string> {
        return await zenFs.promises.readFile(this.resolve(path), "utf8") as string;
    }

    async readBytes(path: string): Promise<Uint8Array> {
        const bytes = await zenFs.promises.readFile(this.resolve(path)) as Uint8Array;
        return new Uint8Array(bytes);
    }

    async writeText(path: string, content: string): Promise<void> {
        const target = this.resolve(path);
        await this.mkdir(dirnamePath(target));
        await zenFs.promises.writeFile(target, content, "utf8");
    }

    async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
        const target = this.resolve(path);
        await this.mkdir(dirnamePath(target));
        await zenFs.promises.writeFile(target, bytes);
    }

    async exists(path: string): Promise<boolean> {
        try {
            await zenFs.promises.access(this.resolve(path));
            return true;
        } catch {
            return false;
        }
    }

    async stat(path: string): Promise<FileStat | null> {
        const info = await this.lstatOrNull(this.resolve(path));
        if (info === null) {
            return null;
        }
        return {
            kind: info.isDirectory() ? "directory" : "file",
            size: Number(info.size),
            mtimeMs: Number(info.mtimeMs),
        };
    }

    async list(path: string): Promise<DirEntry[]> {
        const directory = this.resolve(path);
        const entries = await zenFs.promises.readdir(directory, { withFileTypes: true }) as unknown as ZenDirent[];
        const result: DirEntry[] = [];
        for (const entry of entries) {
            const info = await this.lstatOrNull(joinPath(directory, entry.name));
            if (info === null) {
                continue;
            }
            result.push({
                name: entry.name,
                kind: info.isDirectory() ? "directory" : "file",
                size: Number(info.size),
                mtimeMs: Number(info.mtimeMs),
            });
        }
        return result;
    }

    async mkdir(path: string): Promise<void> {
        await zenFs.promises.mkdir(this.resolve(path), { recursive: true });
    }

    async remove(path: string, opts?: { recursive?: boolean }): Promise<void> {
        await zenFs.promises.rm(this.resolve(path), {
            recursive: opts?.recursive ?? false,
            force: true,
        });
    }

    private async lstatOrNull(path: string): Promise<ZenStats | null> {
        try {
            return await zenFs.promises.lstat(path) as unknown as ZenStats;
        } catch {
            return null;
        }
    }
}

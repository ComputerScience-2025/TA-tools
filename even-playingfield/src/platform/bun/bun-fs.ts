/**
 * `VirtualFileSystem` over node:fs — the CLI / compiled-binary implementation.
 *
 * Relative paths resolve against {@link root}, which defaults to the process
 * working directory, so CLI behaviour is unchanged (node:fs would resolve them
 * the same way).
 */

import { access, lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";

import { dirnamePath, resolvePath, toPosixPath } from "../path.ts";
import type { DirEntry, FileStat, VirtualFileSystem } from "../types.ts";

export class BunFileSystem implements VirtualFileSystem {
    private readonly rootOverride: string | undefined;

    constructor(root?: string) {
        this.rootOverride = root === undefined ? undefined : toPosixPath(root);
    }

    get root(): string {
        return this.rootOverride ?? toPosixPath(process.cwd());
    }

    /** Absolute POSIX path handed to node:fs. */
    private resolve(path: string): string {
        return resolvePath(this.root, path);
    }

    async readText(path: string): Promise<string> {
        return await readFile(this.resolve(path), "utf8");
    }

    async readBytes(path: string): Promise<Uint8Array> {
        return new Uint8Array(await readFile(this.resolve(path)));
    }

    async writeText(path: string, content: string): Promise<void> {
        const target = this.resolve(path);
        await mkdir(dirnamePath(target), { recursive: true });
        await writeFile(target, content, "utf8");
    }

    async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
        const target = this.resolve(path);
        await mkdir(dirnamePath(target), { recursive: true });
        await writeFile(target, bytes);
    }

    async exists(path: string): Promise<boolean> {
        try {
            await access(this.resolve(path));
            return true;
        } catch {
            return false;
        }
    }

    async stat(path: string): Promise<FileStat | null> {
        const info = await lstatOrNull(this.resolve(path));
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
        const entries = await readdir(directory, { withFileTypes: true });
        const result: DirEntry[] = [];
        for (const entry of entries) {
            const info = await lstatOrNull(`${directory.replace(/\/+$/, "")}/${entry.name}`);
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
        await mkdir(this.resolve(path), { recursive: true });
    }

    async remove(path: string, opts?: { recursive?: boolean }): Promise<void> {
        await rm(this.resolve(path), { recursive: opts?.recursive ?? false, force: true });
    }
}

async function lstatOrNull(path: string): Promise<Awaited<ReturnType<typeof lstat>> | null> {
    try {
        return await lstat(path);
    } catch {
        return null;
    }
}

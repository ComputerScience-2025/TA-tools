/**
 * Workspace-scoped view of a filesystem.
 *
 * In the CLI the working directory is the workspace root, so config paths like
 * `search_directory = "src"` and output filenames resolve against it. The
 * browser has one ZenFS tree, so this view rebinds `root` to the active
 * workspace: relative paths resolve inside it, while absolute paths pass
 * through untouched (the host uses those for cross-workspace operations).
 */

import { resolvePath } from "../path.ts";
import type { DirEntry, FileStat, VirtualFileSystem } from "../types.ts";

export class ScopedFileSystem implements VirtualFileSystem {
    constructor(
        private readonly inner: VirtualFileSystem,
        private readonly currentRoot: () => string,
    ) {}

    get root(): string {
        return this.currentRoot();
    }

    private resolve(path: string): string {
        return resolvePath(this.root, path);
    }

    async readText(path: string): Promise<string> {
        return await this.inner.readText(this.resolve(path));
    }

    async readBytes(path: string): Promise<Uint8Array> {
        return await this.inner.readBytes(this.resolve(path));
    }

    async writeText(path: string, content: string): Promise<void> {
        await this.inner.writeText(this.resolve(path), content);
    }

    async writeBytes(path: string, bytes: Uint8Array): Promise<void> {
        await this.inner.writeBytes(this.resolve(path), bytes);
    }

    async exists(path: string): Promise<boolean> {
        return await this.inner.exists(this.resolve(path));
    }

    async stat(path: string): Promise<FileStat | null> {
        return await this.inner.stat(this.resolve(path));
    }

    async list(path: string): Promise<DirEntry[]> {
        return await this.inner.list(this.resolve(path));
    }

    async mkdir(path: string): Promise<void> {
        await this.inner.mkdir(this.resolve(path));
    }

    async remove(path: string, opts?: { recursive?: boolean }): Promise<void> {
        await this.inner.remove(this.resolve(path), opts);
    }
}

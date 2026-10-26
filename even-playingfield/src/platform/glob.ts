/**
 * Glob matching shared by every platform.
 *
 * ZenFS ships its own glob, but it matches dotfiles by default and ignores
 * `{a,b}` braces, which would diverge from the `Bun.Glob` results the CLI has
 * always produced. Walking the tree through {@link VirtualFileSystem} and
 * matching with `picomatch` keeps one implementation for all targets.
 */

import picomatch from "picomatch";

import { joinPath } from "./path.ts";
import type { DirEntry, VirtualFileSystem } from "./types.ts";

/** Guards against pathological trees (and symlink loops, should one appear). */
const DEFAULT_MAX_DEPTH = 32;

export type ScanGlobOptions = {
    /** Include dot-prefixed files and directories (default false, as Bun.Glob). */
    dot?: boolean;
    maxDepth?: number;
};

/**
 * Walk `searchDirectory` and return the paths of matching files, relative to
 * `searchDirectory` — the same shape `Bun.Glob.scan()` returns. Results are
 * sorted so runs are reproducible.
 */
export async function scanGlob(
    fs: VirtualFileSystem,
    pattern: string,
    searchDirectory: string,
    options: ScanGlobOptions = {},
): Promise<string[]> {
    const dot = options.dot ?? false;
    const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;
    const isMatch = picomatch(pattern, { dot });
    const matches: string[] = [];

    const walk = async (directory: string, relative: string, depth: number): Promise<void> => {
        if (depth > maxDepth) {
            return;
        }
        const entries: DirEntry[] = await fs.list(directory);
        for (const entry of entries) {
            if (!dot && entry.name.startsWith(".")) {
                continue;
            }
            const entryRelative = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
            if (entry.kind === "directory") {
                await walk(joinPath(directory, entry.name), entryRelative, depth + 1);
            } else if (isMatch(entryRelative)) {
                matches.push(entryRelative);
            }
        }
    };

    await walk(searchDirectory, "", 1);
    return matches.sort();
}

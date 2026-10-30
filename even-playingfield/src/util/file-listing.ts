/**
 * Workspace file listing behind the `ls` REPL command.
 *
 * Shared by the CLI (whose working directory is the workspace root) and the
 * browser console (whose workspace root is the active workspace). Both walk
 * the platform filesystem, so `ls` shows exactly the tree a workflow's file
 * searches walk — which is what makes it useful when a run reports
 * "No files found for workflow".
 */

import { basenamePath, joinPath } from "../platform/path.ts";
import type { DirEntry, FileKind, FileStat, VirtualFileSystem } from "../platform/types.ts";

/** Deepest directory level the walker descends into (matches `scanGlob`). */
export const LIST_MAX_DEPTH = 32;

/** Entry cap, so `ls` on a large repository stays readable. */
export const LIST_MAX_ENTRIES = 500;

export type ListedEntry = {
    /** POSIX path relative to the listed directory. */
    path: string;
    kind: FileKind;
    size: number;
};

export type FileListing = {
    /** What was listed, as given (relative to the workspace root). */
    path: string;
    entries: ListedEntry[];
    /** True when the entry cap stopped the walk early. */
    truncated: boolean;
};

export type ListTreeOptions = {
    /** Directory (or single file) to list, relative to the workspace root. */
    path?: string;
    maxDepth?: number;
    maxEntries?: number;
};

/**
 * Walk `options.path` and return every file and directory below it.
 *
 * Entries are emitted parent-first so {@link formatFileListing} can render a
 * tree from the paths alone. Dot-prefixed entries are kept: a workflow never
 * matches them, and that is exactly the kind of thing `ls` has to reveal.
 */
export async function listTree(fs: VirtualFileSystem, options: ListTreeOptions = {}): Promise<FileListing> {
    const rootPath = options.path ?? ".";
    const maxDepth = options.maxDepth ?? LIST_MAX_DEPTH;
    const maxEntries = options.maxEntries ?? LIST_MAX_ENTRIES;
    const entries: ListedEntry[] = [];
    let truncated = false;

    const info: FileStat | null = await fs.stat(rootPath);
    if (info !== null && info.kind === "file") {
        return {
            path: rootPath,
            entries: [{ path: basenamePath(rootPath), kind: "file", size: info.size }],
            truncated: false,
        };
    }

    const walk = async (directory: string, relative: string, depth: number): Promise<void> => {
        if (truncated) {
            return;
        }
        // Sorted so the truncation point is deterministic.
        const listing: DirEntry[] = (await fs.list(directory)).sort((a, b) => a.name.localeCompare(b.name));
        for (const entry of listing) {
            if (entries.length >= maxEntries) {
                truncated = true;
                return;
            }
            const childRelative = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
            entries.push({ path: childRelative, kind: entry.kind, size: entry.size });
            if (entry.kind === "directory" && depth < maxDepth) {
                await walk(joinPath(directory, entry.name), childRelative, depth + 1);
            }
        }
    };

    await walk(rootPath, "", 1);
    return { path: rootPath, entries, truncated };
}

/** Render a listing as an indented tree plus a short summary. */
export function formatFileListing(listing: FileListing): string {
    if (listing.entries.length === 0) {
        return "(empty)";
    }

    const lines: string[] = [];
    let files = 0;
    let directories = 0;
    let hasDotEntry = false;

    for (const entry of listing.entries) {
        const segments = entry.path.split("/");
        const depth = segments.length - 1;
        const name = segments[segments.length - 1]!;
        if (name.startsWith(".")) {
            hasDotEntry = true;
        }
        const suffix = entry.kind === "directory" ? "/" : "";
        lines.push(`${"  ".repeat(depth)}${name}${suffix}`);
        if (entry.kind === "directory") {
            directories += 1;
        } else {
            files += 1;
        }
    }

    lines.push("");
    lines.push(`${files} file(s), ${directories} director${directories === 1 ? "y" : "ies"}`);
    if (listing.truncated) {
        lines.push(`Listing cut off at ${listing.entries.length} entries; run 'ls <dir>' to narrow it.`);
    }
    if (hasDotEntry) {
        lines.push("Note: entries starting with '.' are never matched by workflow file searches.");
    }
    return lines.join("\n");
}

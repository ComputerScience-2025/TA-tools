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

/**
 * Collapse brace groups that hold a single alternative: `*.{cs}` becomes
 * `*.cs`.
 *
 * picomatch only expands a brace group when it contains a comma or a range, so
 * `*.{cs}` would otherwise match the literal text `*.{cs}` and find nothing.
 * `Bun.Glob` — what the CLI used before the platform layer — expands it, and
 * configs in the wild write both forms.
 */
export function normalizeBraceGroups(pattern: string): string {
    let result = "";
    let index = 0;

    while (index < pattern.length) {
        const char = pattern[index]!;
        if (char === "\\" && index + 1 < pattern.length) {
            result += pattern.slice(index, index + 2);
            index += 2;
            continue;
        }
        if (char !== "{") {
            result += char;
            index += 1;
            continue;
        }

        const close = findClosingBrace(pattern, index);
        if (close === -1) {
            result += char;
            index += 1;
            continue;
        }

        const body = pattern.slice(index + 1, close);
        // Commas and `..` ranges are left to picomatch; a lone alternative is
        // unwrapped so it behaves like the plain text it stands for.
        const keepsBraces = hasTopLevelComma(body) || body.includes("..");
        result += keepsBraces
            ? `{${normalizeBraceGroups(body)}}`
            : normalizeBraceGroups(body);
        index = close + 1;
    }

    return result;
}

/** Index of the `}` matching the `{` at `open`, or -1 when unclosed. */
function findClosingBrace(pattern: string, open: number): number {
    let depth = 0;
    for (let index = open; index < pattern.length; index += 1) {
        const char = pattern[index];
        if (char === "\\") {
            index += 1;
            continue;
        }
        if (char === "{") {
            depth += 1;
        } else if (char === "}") {
            depth -= 1;
            if (depth === 0) {
                return index;
            }
        }
    }
    return -1;
}

/** True when the group body separates alternatives at its own level. */
function hasTopLevelComma(body: string): boolean {
    let depth = 0;
    for (let index = 0; index < body.length; index += 1) {
        const char = body[index];
        if (char === "\\") {
            index += 1;
            continue;
        }
        if (char === "{") {
            depth += 1;
        } else if (char === "}") {
            depth -= 1;
        } else if (char === "," && depth === 0) {
            return true;
        }
    }
    return false;
}


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
    const isMatch = picomatch(normalizeBraceGroups(pattern), { dot });
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

/**
 * Globbing through the browser's filesystem stack.
 *
 * The reported failure ("No files found for workflow" on a repo whose config
 * used `*.{cs}` in `P2/`) only happened in the browser: the CLI matches with
 * `Bun.Glob`, while the browser walks ZenFS through `ScopedFileSystem` and
 * matches with picomatch. These tests pin the layout from that report so the
 * extra platform layer cannot hide a matching regression again.
 */

import { describe, expect, test } from "bun:test";

import { scanGlob } from "../glob.ts";
import { ScopedFileSystem } from "./scoped-vfs.ts";
import { createZenFileSystem } from "./zen-vfs.ts";

const WORKSPACES_ROOT = "/workspace-glob-test";

async function createWorkspace(): Promise<{ fs: ScopedFileSystem; root: string; cleanup: () => Promise<void> }> {
    const mount = await createZenFileSystem({ persist: false, root: WORKSPACES_ROOT });
    const root = `${WORKSPACES_ROOT}/workspaces/demo`;
    await mount.fs.writeText(`${root}/README.md`, "# Demo");
    await mount.fs.writeText(`${root}/P2/Legion.cs`, "class Legion {}");
    await mount.fs.writeText(`${root}/P2/P2.cs`, "class P2 {}");
    await mount.fs.writeText(`${root}/P2/Player.cs`, "class Player {}");
    await mount.fs.writeText(`${root}/src/main.cpp`, "int main() {}");
    await mount.fs.writeText(`${root}/src/main.h`, "#pragma once");
    return {
        fs: new ScopedFileSystem(mount.fs, () => root),
        root,
        cleanup: async () => {
            await mount.fs.remove(root, { recursive: true });
        },
    };
}

describe("scanGlob over a browser workspace", () => {
    test("matches a single-alternative brace glob in a trailing-slash directory", async () => {
        const { fs, cleanup } = await createWorkspace();
        try {
            expect(await scanGlob(fs, "*.{cs}", "P2/")).toEqual(["Legion.cs", "P2.cs", "Player.cs"]);
        } finally {
            await cleanup();
        }
    });

    test("matches a multi-alternative brace glob", async () => {
        const { fs, cleanup } = await createWorkspace();
        try {
            expect(await scanGlob(fs, "*.{cpp,h}", "src")).toEqual(["main.cpp", "main.h"]);
        } finally {
            await cleanup();
        }
    });

    test("resolves dot-prefixed directories and workspace-wide patterns", async () => {
        const { fs, cleanup } = await createWorkspace();
        try {
            expect(await scanGlob(fs, "*.cs", "./P2")).toEqual(["Legion.cs", "P2.cs", "Player.cs"]);
            expect(await scanGlob(fs, "**/*.{cs,cpp,h}", ".")).toEqual([
                "P2/Legion.cs",
                "P2/P2.cs",
                "P2/Player.cs",
                "src/main.cpp",
                "src/main.h",
            ]);
        } finally {
            await cleanup();
        }
    });

    test("throws when the configured directory is missing", async () => {
        const { fs, cleanup } = await createWorkspace();
        try {
            // The workflow's empty-file path expects a real listing error, not a
            // silent empty result that looks like "no matching files".
            await expect(scanGlob(fs, "*.{cs}", "P3/")).rejects.toThrow();
        } finally {
            await cleanup();
        }
    });
});

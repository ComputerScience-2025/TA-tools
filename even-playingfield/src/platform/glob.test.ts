import { Glob } from "bun";

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { normalizeBraceGroups, scanGlob } from "./glob.ts";
import { toPosixPath } from "./path.ts";
import { BunFileSystem } from "./bun/bun-fs.ts";

const FILES = [
    "src/Program.cs",
    "src/Helper.cs",
    "src/nested/Deep.cs",
    "src/.hidden/Hidden.cs",
    "src/notes.md",
    "src/main.cpp",
    "src/main.h",
    "src/include/util.h",
    "src/data.json",
    "README.md",
    "docs/guide.md",
    ".config/dot.cs",
];

let directory: string;
let fs: BunFileSystem;

beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "epf-glob-"));
    for (const file of FILES) {
        await mkdir(join(directory, dirname(file)), { recursive: true });
        await writeFile(join(directory, file), "x");
    }
    fs = new BunFileSystem(toPosixPath(directory));
});

afterAll(async () => {
    await rm(directory, { recursive: true, force: true });
});

/**
 * `Bun.Glob` as the reference implementation (what the CLI used before).
 * Bun returns native separators on Windows; the walker always yields POSIX
 * separators, so the reference output is normalized before comparing.
 */
async function referenceGlob(pattern: string, searchDirectory: string): Promise<string[]> {
    const glob = new Glob(pattern);
    const matches: string[] = [];
    for await (const file of glob.scan(join(directory, searchDirectory))) {
        matches.push(toPosixPath(file));
    }
    return matches.sort();
}

describe("scanGlob", () => {
    test("matches a single directory, skipping dot-entries", async () => {
        expect(await scanGlob(fs, "*.cs", "src")).toEqual(["Helper.cs", "Program.cs"]);
    });

    test("matches recursively", async () => {
        expect(await scanGlob(fs, "**/*.cs", "src")).toEqual(["Helper.cs", "Program.cs", "nested/Deep.cs"]);
    });

    test("skips dot-directories entirely", async () => {
        const matches = await scanGlob(fs, "**/*.cs", ".");
        expect(matches).not.toContain(".config/dot.cs");
        expect(matches).not.toContain("src/.hidden/Hidden.cs");
    });

    test("supports braces and question marks", async () => {
        expect(await scanGlob(fs, "*{.cs,.cpp}", "src")).toEqual(["Helper.cs", "Program.cs", "main.cpp"]);
        expect(await scanGlob(fs, "*.?s", "src")).toEqual(["Helper.cs", "Program.cs"]);
    });

    test("expands single-alternative braces like Bun.Glob", async () => {
        // picomatch alone reads `{cs}` as literal text, which is how `*.{cs}`
        // silently matched nothing in the browser while the CLI worked.
        expect(await scanGlob(fs, "*.{cs}", "src")).toEqual(["Helper.cs", "Program.cs"]);
        expect(await scanGlob(fs, "*.{cpp}", "src")).toEqual(["main.cpp"]);
        expect(await scanGlob(fs, "src/*.{cs}", ".")).toEqual(["src/Helper.cs", "src/Program.cs"]);
    });

    test("keeps multi-alternative braces working", async () => {
        // The form `epf.example.toml` ships; picomatch expands it natively.
        expect(await scanGlob(fs, "*.{cpp,h}", "src")).toEqual(["main.cpp", "main.h"]);
        expect(await scanGlob(fs, "*.{h,cpp}", "src")).toEqual(["main.cpp", "main.h"]);
        // `*` does not cross directories, nor does a brace change that.
        expect(await scanGlob(fs, "**/*.{cpp,h}", "src")).toEqual(["include/util.h", "main.cpp", "main.h"]);
        expect(await scanGlob(fs, "src/**/*.{cpp,h}", ".")).toEqual(["src/include/util.h", "src/main.cpp", "src/main.h"]);
    });

    test("accepts a trailing slash in search_directory", async () => {
        // Configs are written both ways; the browser's scoped filesystem must
        // resolve them identically (this is the shape the bug report used).
        expect(await scanGlob(fs, "*.{cs}", "src/")).toEqual(["Helper.cs", "Program.cs"]);
        expect(await scanGlob(fs, "*.cs", "src//")).toEqual(["Helper.cs", "Program.cs"]);
        expect(await scanGlob(fs, "*.cs", "./src")).toEqual(["Helper.cs", "Program.cs"]);
    });

    test("normalizes braces without touching ranges or escapes", () => {
        expect(normalizeBraceGroups("*.{cs}")).toBe("*.cs");
        expect(normalizeBraceGroups("*.{cs,cpp}")).toBe("*.{cs,cpp}");
        expect(normalizeBraceGroups("{src,lib}/*.{cs}")).toBe("{src,lib}/*.cs");
        expect(normalizeBraceGroups("a{1..3}.txt")).toBe("a{1..3}.txt");
        expect(normalizeBraceGroups("*.{cs,}")).toBe("*.{cs,}");
        expect(normalizeBraceGroups("*.\\{cs}")).toBe("*.\\{cs}");
        expect(normalizeBraceGroups("*.{cs")).toBe("*.{cs");
        expect(normalizeBraceGroups("*.{cs,cpp}/*.{h}")).toBe("*.{cs,cpp}/*.h");
    });

    test("supports prefix directories in the pattern", async () => {
        expect(await scanGlob(fs, "src/**/*.cs", ".")).toEqual(["src/Helper.cs", "src/Program.cs", "src/nested/Deep.cs"]);
    });

    test("throws when the search directory does not exist", async () => {
        await expect(scanGlob(fs, "*.cs", "nope")).rejects.toThrow();
    });

    test("stops walking past maxDepth", async () => {
        const shallow = await scanGlob(fs, "**/*.cs", "src", { maxDepth: 1 });
        expect(shallow).toEqual(["Helper.cs", "Program.cs"]);
        expect(shallow).not.toContain("nested/Deep.cs");
    });

    test("agrees with Bun.Glob on the patterns used by configs", async () => {
        // One implementation for CLI and browser only holds if these agree: the
        // CLI's original matcher is the reference.
        const cases: [pattern: string, searchDirectory: string][] = [
            ["*.cs", "src"],
            ["*.cpp", "."],
            ["**/*.cs", "src"],
            ["**/*.md", "."],
            ["src/**/*.cs", "."],
            ["**/nested/*.cs", "."],
            ["*.?s", "src"],
            ["*.{cs}", "src"],
            ["src/*.{cs}", "."],
            ["*.{md}", "."],
            ["*.{cpp,h}", "src"],
            ["*.{h,cpp}", "src"],
            ["**/*.{cpp,h}", "src"],
            ["src/**/*.{cpp,h}", "."],
            ["{src,docs}/*.md", "."],
            ["**/{nested,include}/*.{cs,h}", "."],
            ["**/nested/*.{cs}", "."],
        ];
        for (const [pattern, searchDirectory] of cases) {
            expect(
                await scanGlob(fs, pattern, searchDirectory),
                `pattern: ${pattern} in ${searchDirectory}`,
            ).toEqual(await referenceGlob(pattern, searchDirectory));
        }
    });
});

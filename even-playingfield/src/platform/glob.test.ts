import { Glob } from "bun";

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterAll, beforeAll, describe, expect, test } from "bun:test";

import { scanGlob } from "./glob.ts";
import { toPosixPath } from "./path.ts";
import { BunFileSystem } from "./bun/bun-fs.ts";

const FILES = [
    "src/Program.cs",
    "src/Helper.cs",
    "src/nested/Deep.cs",
    "src/.hidden/Hidden.cs",
    "src/notes.md",
    "src/main.cpp",
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

    test("supports prefix directories in the pattern", async () => {
        expect(await scanGlob(fs, "src/**/*.cs", ".")).toEqual(["src/Helper.cs", "src/Program.cs", "src/nested/Deep.cs"]);
    });

    test("throws when the search directory does not exist", async () => {
        await expect(scanGlob(fs, "*.cs", "nope")).rejects.toThrow();
    });

    test("agrees with Bun.Glob on the patterns used by configs", async () => {
        const patterns = [
            "*.cs",
            "*.cpp",
            "**/*.cs",
            "**/*.md",
            "src/**/*.cs",
            "**/nested/*.cs",
            "*.?s",
        ];
        for (const pattern of patterns) {
            expect(await scanGlob(fs, pattern, "."), `pattern: ${pattern}`).toEqual(
                await referenceGlob(pattern, "."),
            );
        }
    });
});

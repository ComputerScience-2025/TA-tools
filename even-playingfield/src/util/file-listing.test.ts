import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { formatFileListing, listTree } from "./file-listing.ts";
import { toPosixPath } from "../platform/path.ts";
import { BunFileSystem } from "../platform/bun/bun-fs.ts";

const FILES = [
    "alpha.txt",
    "beta.txt",
    "src/helper.cs",
    "src/program.cs",
    "src/nested/deep.cs",
];

let directory: string;
let fs: BunFileSystem;

beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), "epf-listing-"));
    for (const file of FILES) {
        await mkdir(join(directory, dirname(file)), { recursive: true });
        await writeFile(join(directory, file), "x");
    }
    fs = new BunFileSystem(toPosixPath(directory));
});

afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
});

describe("listTree", () => {
    test("lists the whole tree parent-first", async () => {
        const listing = await listTree(fs);
        expect(listing.path).toBe(".");
        expect(listing.truncated).toBe(false);
        expect(listing.entries.map((entry) => entry.path)).toEqual([
            "alpha.txt",
            "beta.txt",
            "src",
            "src/helper.cs",
            "src/nested",
            "src/nested/deep.cs",
            "src/program.cs",
        ]);
    });

    test("reports kinds and sizes", async () => {
        const listing = await listTree(fs, { path: "src" });
        const paths = listing.entries.map((entry) => `${entry.kind}:${entry.path}`);
        expect(paths).toEqual([
            "file:helper.cs",
            "directory:nested",
            "file:nested/deep.cs",
            "file:program.cs",
        ]);
        expect(listing.entries[0]?.size).toBe(1);
    });

    test("stops descending at maxDepth", async () => {
        const listing = await listTree(fs, { maxDepth: 1 });
        expect(listing.entries.map((entry) => entry.path)).toEqual(["alpha.txt", "beta.txt", "src"]);
    });

    test("caps entries and reports truncation", async () => {
        const listing = await listTree(fs, { maxEntries: 2 });
        expect(listing.entries.map((entry) => entry.path)).toEqual(["alpha.txt", "beta.txt"]);
        expect(listing.truncated).toBe(true);
    });

    test("lists a single file when given one", async () => {
        const listing = await listTree(fs, { path: "src/program.cs" });
        expect(listing.entries).toEqual([{ path: "program.cs", kind: "file", size: 1 }]);
    });

    test("throws for a missing directory", async () => {
        await expect(listTree(fs, { path: "nope" })).rejects.toThrow();
    });
});

describe("formatFileListing", () => {
    test("renders an indented tree with a summary", async () => {
        const listing = await listTree(fs);
        expect(formatFileListing(listing)).toBe([
            "alpha.txt",
            "beta.txt",
            "src/",
            "  helper.cs",
            "  nested/",
            "    deep.cs",
            "  program.cs",
            "",
            "5 file(s), 2 directories",
        ].join("\n"));
    });

    test("renders an empty directory", async () => {
        await rm(directory, { recursive: true, force: true });
        await mkdir(directory);
        expect(formatFileListing(await listTree(fs))).toBe("(empty)");
    });

    test("explains truncation", async () => {
        const listing = await listTree(fs, { maxEntries: 2 });
        expect(formatFileListing(listing)).toContain("Listing cut off at 2 entries");
    });

    test("notes dot-entries, which workflows never match", async () => {
        await mkdir(join(directory, ".cache"), { recursive: true });
        await writeFile(join(directory, ".cache", "state.json"), "x");
        const listing = await listTree(fs);
        expect(listing.entries.map((entry) => entry.path)).toContain(".cache");
        expect(formatFileListing(listing)).toContain("never matched by workflow file searches");
    });
});

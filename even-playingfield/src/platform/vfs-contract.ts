/**
 * Shared behaviour contract for every {@link VirtualFileSystem} implementation.
 *
 * Both the Bun (node:fs) and the browser (ZenFS) implementations run this, so
 * the core can rely on identical semantics on every platform.
 */

import { describe, expect, test } from "bun:test";

import type { VirtualFileSystem } from "./types.ts";

export type VfsFixture = {
    fs: VirtualFileSystem;
    cleanup: () => Promise<void>;
};

export function describeVfsContract(name: string, createFixture: () => Promise<VfsFixture>): void {
    describe(`${name}: VirtualFileSystem contract`, () => {
        test("writes and reads text, creating parent directories", async () => {
            const { fs, cleanup } = await createFixture();
            try {
                await fs.writeText("nested/deeper/file.txt", "hello world");
                expect(await fs.readText("nested/deeper/file.txt")).toBe("hello world");
                expect((await fs.stat("nested/deeper/file.txt"))?.size).toBe("hello world".length);
            } finally {
                await cleanup();
            }
        });

        test("writes and reads binary bytes", async () => {
            const { fs, cleanup } = await createFixture();
            try {
                const bytes = new Uint8Array([0, 1, 2, 253, 254, 255]);
                await fs.writeBytes("bin/data.bin", bytes);
                expect(Array.from(await fs.readBytes("bin/data.bin"))).toEqual(Array.from(bytes));
            } finally {
                await cleanup();
            }
        });

        test("overwrites existing files", async () => {
            const { fs, cleanup } = await createFixture();
            try {
                await fs.writeText("a.txt", "first");
                await fs.writeText("a.txt", "second");
                expect(await fs.readText("a.txt")).toBe("second");
            } finally {
                await cleanup();
            }
        });

        test("reads throw for missing files", async () => {
            const { fs, cleanup } = await createFixture();
            try {
                await expect(fs.readText("missing.txt")).rejects.toThrow();
                await expect(fs.readBytes("missing.txt")).rejects.toThrow();
            } finally {
                await cleanup();
            }
        });

        test("exists reports presence", async () => {
            const { fs, cleanup } = await createFixture();
            try {
                expect(await fs.exists("missing.txt")).toBe(false);
                await fs.writeText("present.txt", "x");
                expect(await fs.exists("present.txt")).toBe(true);
                await fs.mkdir("adir");
                expect(await fs.exists("adir")).toBe(true);
            } finally {
                await cleanup();
            }
        });

        test("stat describes files and directories, null when missing", async () => {
            const { fs, cleanup } = await createFixture();
            try {
                await fs.writeText("dir/file.txt", "12345");
                const fileStat = await fs.stat("dir/file.txt");
                expect(fileStat?.kind).toBe("file");
                expect(fileStat?.size).toBe(5);
                expect(fileStat?.mtimeMs).toBeGreaterThan(0);

                const dirStat = await fs.stat("dir");
                expect(dirStat?.kind).toBe("directory");

                expect(await fs.stat("dir/nope.txt")).toBeNull();
            } finally {
                await cleanup();
            }
        });

        test("list returns entries with kinds and sizes", async () => {
            const { fs, cleanup } = await createFixture();
            try {
                await fs.writeText("tree/a.txt", "aa");
                await fs.writeText("tree/sub/b.txt", "bbb");
                const entries = await fs.list("tree");
                const byName = new Map(entries.map((entry) => [entry.name, entry]));
                expect(byName.get("a.txt")?.kind).toBe("file");
                expect(byName.get("a.txt")?.size).toBe(2);
                expect(byName.get("sub")?.kind).toBe("directory");
                expect(await fs.list("tree/sub")).toHaveLength(1);
            } finally {
                await cleanup();
            }
        });

        test("list throws for a missing directory", async () => {
            const { fs, cleanup } = await createFixture();
            try {
                await expect(fs.list("ghost")).rejects.toThrow();
            } finally {
                await cleanup();
            }
        });

        test("remove deletes files and directories recursively", async () => {
            const { fs, cleanup } = await createFixture();
            try {
                await fs.writeText("keep/file.txt", "x");
                await fs.remove("keep/file.txt");
                expect(await fs.exists("keep/file.txt")).toBe(false);

                await fs.writeText("drop/sub/deep.txt", "x");
                await fs.remove("drop", { recursive: true });
                expect(await fs.exists("drop")).toBe(false);
                expect(await fs.exists("keep")).toBe(true);

                // Missing paths are not an error.
                await fs.remove("never-existed.txt");
            } finally {
                await cleanup();
            }
        });

        test("absolute paths are accepted alongside relative ones", async () => {
            const { fs, cleanup } = await createFixture();
            try {
                const absolute = `${fs.root.replace(/\/+$/, "")}/abs/file.txt`;
                await fs.writeText(absolute, "absolute");
                expect(await fs.readText("abs/file.txt")).toBe("absolute");
                expect(await fs.exists(absolute)).toBe(true);
            } finally {
                await cleanup();
            }
        });
    });
}

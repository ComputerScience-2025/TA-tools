import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { toPosixPath } from "../platform/path.ts";
import { BunFileSystem } from "../platform/bun/bun-fs.ts";
import { runDownload } from "./runner.ts";
import type { DownloadOptions, DownloadPlan, RemoteFile } from "./types.ts";

const createdDirs: string[] = [];

function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "epf-download-"));
    createdDirs.push(dir);
    return dir;
}

/** Writing goes through the platform filesystem, so the CLI target uses node:fs. */
function optionsFor(dir: string, overrides: Partial<DownloadOptions> = {}): DownloadOptions {
    return {
        outputDir: dir,
        skipExisting: false,
        concurrency: 4,
        fs: new BunFileSystem(toPosixPath(dir)),
        ...overrides,
    };
}

function file(relativePath: string, content: string): RemoteFile {
    return {
        relativePath,
        load: async () => new TextEncoder().encode(content),
    };
}

function planOf(files: RemoteFile[]): DownloadPlan {
    return { rootLabel: "test", files };
}

afterEach(() => {
    while (createdDirs.length > 0) {
        rmSync(createdDirs.pop()!, { recursive: true, force: true });
    }
});

describe("runDownload", () => {
    test("writes nested files, creating parent directories", async () => {
        const dir = makeTempDir();
        const summary = await runDownload(
            planOf([file("a.txt", "alpha"), file("nested/deep/b.txt", "beta")]),
            optionsFor(dir),
        );

        expect(summary.downloaded).toBe(2);
        expect(summary.failed).toBe(0);
        expect(await Bun.file(join(dir, "a.txt")).text()).toBe("alpha");
        expect(await Bun.file(join(dir, "nested/deep/b.txt")).text()).toBe("beta");
    });

    test("overwrites existing files by default", async () => {
        const dir = makeTempDir();
        writeFileSync(join(dir, "a.txt"), "old");

        await runDownload(planOf([file("a.txt", "new")]), optionsFor(dir, { concurrency: 1 }));

        expect(await Bun.file(join(dir, "a.txt")).text()).toBe("new");
    });

    test("skips existing files when skipExisting is set", async () => {
        const dir = makeTempDir();
        writeFileSync(join(dir, "a.txt"), "old");

        const summary = await runDownload(
            planOf([file("a.txt", "new"), file("b.txt", "fresh")]),
            optionsFor(dir, { skipExisting: true, concurrency: 2 }),
        );

        expect(summary.skipped).toBe(1);
        expect(summary.downloaded).toBe(1);
        expect(await Bun.file(join(dir, "a.txt")).text()).toBe("old");
        expect(await Bun.file(join(dir, "b.txt")).text()).toBe("fresh");
    });

    test("reports files above the size cap instead of writing them", async () => {
        const dir = makeTempDir();
        let loaded = 0;
        const declared: RemoteFile = {
            relativePath: "big-declared.txt",
            size: 50,
            load: async () => {
                loaded += 1;
                return new TextEncoder().encode("x");
            },
        };
        const undeclared: RemoteFile = { relativePath: "big-undeclared.txt", load: async () => new TextEncoder().encode("y".repeat(50)) };

        const summary = await runDownload(
            planOf([declared, undeclared, file("small.txt", "ok")]),
            optionsFor(dir, { maxFileBytes: 10, concurrency: 1 }),
        );

        expect(summary.tooLarge).toBe(2);
        expect(summary.downloaded).toBe(1);
        // The declared-oversize file was rejected before its bytes were fetched.
        expect(loaded).toBe(0);
        expect(await Bun.file(join(dir, "big-declared.txt")).exists()).toBe(false);
        expect(await Bun.file(join(dir, "big-undeclared.txt")).exists()).toBe(false);
        expect(await Bun.file(join(dir, "small.txt")).text()).toBe("ok");
    });

    test("isolates per-file failures", async () => {
        const dir = makeTempDir();
        const broken: RemoteFile = {
            relativePath: "broken.txt",
            load: async () => {
                throw new Error("boom");
            },
        };

        const summary = await runDownload(
            planOf([file("ok.txt", "fine"), broken]),
            optionsFor(dir, { concurrency: 2 }),
        );

        expect(summary.downloaded).toBe(1);
        expect(summary.failed).toBe(1);
        expect(summary.outcomes.find((o) => o.relativePath === "broken.txt")?.error).toBe("boom");
        expect(await Bun.file(join(dir, "ok.txt")).exists()).toBe(true);
    });

    test("respects the concurrency limit", async () => {
        const dir = makeTempDir();
        let inFlight = 0;
        let maxInFlight = 0;
        const files: RemoteFile[] = [];
        for (let i = 0; i < 8; i++) {
            files.push({
                relativePath: `f${i}.txt`,
                load: async () => {
                    inFlight += 1;
                    maxInFlight = Math.max(maxInFlight, inFlight);
                    await Bun.sleep(5);
                    inFlight -= 1;
                    return new TextEncoder().encode("x");
                },
            });
        }

        const summary = await runDownload(planOf(files), optionsFor(dir, { concurrency: 3 }));

        expect(summary.downloaded).toBe(8);
        expect(maxInFlight).toBeLessThanOrEqual(3);
        // Sanity check that the pool actually ran in parallel.
        expect(maxInFlight).toBeGreaterThan(1);
    });

    test("creates the output directory when missing", async () => {
        const dir = makeTempDir();
        const nestedOutput = join(dir, "does", "not", "exist");

        const summary = await runDownload(
            planOf([file("a.txt", "hi")]),
            optionsFor(dir, { outputDir: nestedOutput, concurrency: 1 }),
        );

        expect(summary.downloaded).toBe(1);
        expect(await Bun.file(join(nestedOutput, "a.txt")).text()).toBe("hi");
    });
});

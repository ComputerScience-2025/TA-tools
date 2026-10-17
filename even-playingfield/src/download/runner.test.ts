import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runDownload } from "./runner.ts";
import type { DownloadPlan, RemoteFile } from "./types.ts";

const createdDirs: string[] = [];

function makeTempDir(): string {
    const dir = mkdtempSync(join(tmpdir(), "epf-download-"));
    createdDirs.push(dir);
    return dir;
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
            { outputDir: dir, skipExisting: false, concurrency: 4 },
        );

        expect(summary.downloaded).toBe(2);
        expect(summary.failed).toBe(0);
        expect(await Bun.file(join(dir, "a.txt")).text()).toBe("alpha");
        expect(await Bun.file(join(dir, "nested/deep/b.txt")).text()).toBe("beta");
    });

    test("overwrites existing files by default", async () => {
        const dir = makeTempDir();
        writeFileSync(join(dir, "a.txt"), "old");

        await runDownload(planOf([file("a.txt", "new")]), {
            outputDir: dir,
            skipExisting: false,
            concurrency: 1,
        });

        expect(await Bun.file(join(dir, "a.txt")).text()).toBe("new");
    });

    test("skips existing files when skipExisting is set", async () => {
        const dir = makeTempDir();
        writeFileSync(join(dir, "a.txt"), "old");

        const summary = await runDownload(
            planOf([file("a.txt", "new"), file("b.txt", "fresh")]),
            { outputDir: dir, skipExisting: true, concurrency: 2 },
        );

        expect(summary.skipped).toBe(1);
        expect(summary.downloaded).toBe(1);
        expect(await Bun.file(join(dir, "a.txt")).text()).toBe("old");
        expect(await Bun.file(join(dir, "b.txt")).text()).toBe("fresh");
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
            { outputDir: dir, skipExisting: false, concurrency: 2 },
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

        const summary = await runDownload(planOf(files), {
            outputDir: dir,
            skipExisting: false,
            concurrency: 3,
        });

        expect(summary.downloaded).toBe(8);
        expect(maxInFlight).toBeLessThanOrEqual(3);
        // Sanity check that the pool actually ran in parallel.
        expect(maxInFlight).toBeGreaterThan(1);
    });

    test("creates the output directory when missing", async () => {
        const dir = makeTempDir();
        const nestedOutput = join(dir, "does", "not", "exist");

        const summary = await runDownload(planOf([file("a.txt", "hi")]), {
            outputDir: nestedOutput,
            skipExisting: false,
            concurrency: 1,
        });

        expect(summary.downloaded).toBe(1);
        expect(await Bun.file(join(nestedOutput, "a.txt")).text()).toBe("hi");
    });
});

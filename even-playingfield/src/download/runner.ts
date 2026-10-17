/**
 * Generic download runner.
 *
 * Remote-agnostic: takes a resolved {@link DownloadPlan} and writes every file
 * to disk with bounded concurrency, isolating per-file failures so one bad
 * file does not abort the batch. Overwrites by default; skips existing files
 * when {@link DownloadOptions.skipExisting} is set.
 */

import { mkdir } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type {
    DownloadOptions,
    DownloadPlan,
    DownloadSummary,
    FileOutcome,
    RemoteFile,
} from "./types.ts";

/**
 * Run `worker` over `items` with at most `concurrency` in flight at once.
 * Errors thrown by `worker` propagate; callers that need isolation should
 * catch inside the worker (as the file writer below does).
 */
async function runPool<T>(
    items: T[],
    concurrency: number,
    worker: (item: T) => Promise<void>,
): Promise<void> {
    const limit = Math.max(1, Math.min(concurrency, items.length));
    let nextIndex = 0;

    const runners: Promise<void>[] = [];
    for (let i = 0; i < limit; i++) {
        runners.push((async () => {
            while (true) {
                const current = nextIndex;
                nextIndex += 1;
                if (current >= items.length) {
                    return;
                }
                await worker(items[current]!);
            }
        })());
    }

    await Promise.all(runners);
}

async function writeFile(
    file: RemoteFile,
    outputDir: string,
    skipExisting: boolean,
): Promise<FileOutcome> {
    try {
        const targetPath = join(outputDir, file.relativePath);
        if (skipExisting && await Bun.file(targetPath).exists()) {
            return { relativePath: file.relativePath, status: "skipped" };
        }

        const bytes = await file.load();
        await mkdir(dirname(targetPath), { recursive: true });
        await Bun.write(targetPath, bytes);
        return { relativePath: file.relativePath, status: "downloaded" };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { relativePath: file.relativePath, status: "failed", error: message };
    }
}

/**
 * Write every file in `plan` into `options.outputDir`.
 * Never throws for per-file failures; inspect {@link DownloadSummary.failed}.
 */
export async function runDownload(
    plan: DownloadPlan,
    options: DownloadOptions,
): Promise<DownloadSummary> {
    const outputDir = resolve(options.outputDir);
    const outcomes: FileOutcome[] = new Array(plan.files.length);

    let cursor = 0;
    await runPool(
        plan.files,
        options.concurrency,
        async (file) => {
            const index = cursor;
            cursor += 1;
            outcomes[index] = await writeFile(file, outputDir, options.skipExisting);
        },
    );

    // Stable, deterministic ordering for display regardless of completion order.
    outcomes.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

    return {
        outcomes,
        downloaded: outcomes.filter((o) => o.status === "downloaded").length,
        skipped: outcomes.filter((o) => o.status === "skipped").length,
        failed: outcomes.filter((o) => o.status === "failed").length,
    };
}

/**
 * Generic download runner.
 *
 * Remote-agnostic: takes a resolved {@link DownloadPlan} and writes every file
 * through a {@link VirtualFileSystem} with bounded concurrency, isolating
 * per-file failures so one bad file does not abort the batch. Overwrites by
 * default; skips existing files when {@link DownloadOptions.skipExisting} is
 * set, and reports oversized files instead of writing them.
 */

import { joinPath } from "../platform/path.ts";
import { errorMessage } from "../util/errors.ts";
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
    worker: (item: T, index: number) => Promise<void>,
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
                await worker(items[current]!, current);
            }
        })());
    }

    await Promise.all(runners);
}

function tooLargeOutcome(file: RemoteFile, bytes: number, limit: number): FileOutcome {
    return {
        relativePath: file.relativePath,
        status: "too-large",
        error: `${bytes} bytes is above the ${limit} byte per-file limit`,
    };
}

async function writeFile(
    file: RemoteFile,
    options: DownloadOptions,
): Promise<FileOutcome> {
    try {
        const targetPath = joinPath(options.outputDir, file.relativePath);
        if (options.skipExisting && await options.fs.exists(targetPath)) {
            return { relativePath: file.relativePath, status: "skipped" };
        }

        const limit = options.maxFileBytes;
        if (limit !== undefined && file.size !== undefined && file.size > limit) {
            return tooLargeOutcome(file, file.size, limit);
        }

        const bytes = await file.load();
        if (limit !== undefined && bytes.byteLength > limit) {
            return tooLargeOutcome(file, bytes.byteLength, limit);
        }

        await options.fs.writeBytes(targetPath, bytes);
        return { relativePath: file.relativePath, status: "downloaded" };
    } catch (err) {
        const message = errorMessage(err);
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
    const outcomes: FileOutcome[] = new Array(plan.files.length);

    await runPool(
        plan.files,
        options.concurrency,
        async (file, index) => {
            outcomes[index] = await writeFile(file, options);
        },
    );

    // Stable, deterministic ordering for display regardless of completion order.
    outcomes.sort((a, b) => a.relativePath.localeCompare(b.relativePath));

    return {
        outcomes,
        downloaded: outcomes.filter((o) => o.status === "downloaded").length,
        skipped: outcomes.filter((o) => o.status === "skipped").length,
        tooLarge: outcomes.filter((o) => o.status === "too-large").length,
        failed: outcomes.filter((o) => o.status === "failed").length,
    };
}

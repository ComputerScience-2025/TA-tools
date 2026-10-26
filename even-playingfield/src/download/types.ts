/**
 * Shared types for the `epf download` feature.
 *
 * The downloader is a small plugin system: each remote backend implements
 * {@link RemoteSource} and is registered in `registry.ts`. The CLI host, the
 * web host and the generic runner are remote-agnostic — they only know about
 * these types.
 */

import type { VirtualFileSystem } from "../platform/types.ts";

/** Environment variables passed in from the host (process env plus overrides). */
export type EnvVars = Record<string, string | undefined>;

/**
 * A single file to be written. `load` is called lazily by the runner so that
 * bytes are only fetched when a file is actually about to be written.
 */
export type RemoteFile = {
    /** Path relative to the output directory, using forward slashes. */
    relativePath: string;
    /** Size in bytes when the remote knows it, so the runner can skip early. */
    size?: number;
    /** Fetch the file bytes. May throw; the runner isolates per-file failures. */
    load: () => Promise<Uint8Array>;
};

/** A resolved set of files to download, produced by a {@link RemoteSource}. */
export type DownloadPlan = {
    /** Human-readable label for logging, e.g. `user/repo@main:dir`. */
    rootLabel: string;
    files: RemoteFile[];
};

/**
 * Optional diagnostics channel for planning. The CLI leaves it out (notes go to
 * its console); a browser host passes a callback so notes reach the UI.
 */
export type PlanOptions = {
    onNote?: (message: string) => void;
};

/**
 * A pluggable download backend. Register new remotes in `registry.ts`.
 */
export type RemoteSource = {
    /** CLI subcommand id, e.g. `github`. Must be lowercase. */
    readonly name: string;
    /** One-line description shown in help output. */
    readonly description: string;
    /** Env vars the remote reads (informational; listed in help output). */
    readonly envVars: readonly string[];
    /** Env var holding a token, so `--token` can override it. Optional. */
    readonly tokenEnvVar?: string;
    /** Whether this remote recognizes the given URL. */
    matches(url: string): boolean;
    /** Resolve a URL into a plan of files to download. */
    plan(url: string, env: EnvVars, options?: PlanOptions): Promise<DownloadPlan>;
};

/** Options controlling how a {@link DownloadPlan} is written to disk/storage. */
export type DownloadOptions = {
    /** Absolute or relative directory to write into. */
    outputDir: string;
    /** When true, skip files that already exist instead of overwriting. */
    skipExisting: boolean;
    /** Maximum number of files fetched/written concurrently. */
    concurrency: number;
    /** Filesystem to write through (node:fs on the CLI, ZenFS in the browser). */
    fs: VirtualFileSystem;
    /** Single-file size cap; larger files are reported as too-large, not written. */
    maxFileBytes?: number;
};

/** Outcome status for a single file. */
export type FileOutcomeStatus = "downloaded" | "skipped" | "too-large" | "failed";

/** Result of writing a single file. */
export type FileOutcome = {
    relativePath: string;
    status: FileOutcomeStatus;
    error?: string;
};

/** Aggregated result of a download run. */
export type DownloadSummary = {
    outcomes: FileOutcome[];
    downloaded: number;
    skipped: number;
    tooLarge: number;
    failed: number;
};

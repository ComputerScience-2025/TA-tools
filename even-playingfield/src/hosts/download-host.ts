#!/usr/bin/env bun
/**
 * `even-pf download` subcommand entrypoint.
 *
 * A separate CLI surface from the main engine/REPL (`cli-host.ts`), reached
 * via the `download` positional: `even-pf download <remote> <url> [flags]`.
 *
 * This feature is intentionally independent of `epf.toml` — remote credentials
 * are read from environment variables (see each remote's `envVars`).
 *
 * Flags:
 *   -o, --output <dir>     Write into this directory (default: current dir)
 *       --skip-existing    Skip files that already exist (default: overwrite)
 *       --concurrency <n>  Max parallel file downloads (default: 5)
 *       --dry-run          List files without writing anything
 *       --token <value>    Override the remote's token env var
 *   -h, --help             Show this help
 */

import { parseArgs } from "node:util";
import { resolve } from "node:path";

import chalk from "chalk";

import { getRemote, listRemotes } from "../download/registry.ts";
import { runDownload as executeDownload } from "../download/runner.ts";
import { BunFileSystem } from "../platform/bun/bun-fs.ts";
import { errorMessage } from "../util/errors.ts";
import type { DownloadOptions, DownloadPlan, EnvVars, RemoteSource } from "../download/types.ts";

const DEFAULT_CONCURRENCY = 5;

function printUsage(): void {
    console.log(chalk.bold("Usage: even-pf download <remote> <url> [flags]"));
    console.log("");
    console.log("Remotes:");
    for (const remote of listRemotes()) {
        console.log(`  ${chalk.cyan(remote.name)}  ${remote.description}`);
        if (remote.envVars.length > 0) {
            console.log(`      env: ${remote.envVars.join(", ")}`);
        }
    }
    console.log("");
    console.log("Flags:");
    console.log("  -o, --output <dir>     Write into this directory (default: current dir)");
    console.log("      --skip-existing    Skip files that already exist (default: overwrite)");
    console.log(`      --concurrency <n>  Max parallel file downloads (default: ${DEFAULT_CONCURRENCY})`);
    console.log("      --dry-run          List files without writing anything");
    console.log("      --token <value>    Override the remote's token env var");
    console.log("  -h, --help             Show this help");
}

function fail(message: string): never {
    console.error(chalk.red(message));
    process.exit(1);
}

function resolveConcurrency(raw: string): number {
    const parsed = Number.parseInt(raw, 10);
    if (!Number.isFinite(parsed) || parsed < 1) {
        fail(`Invalid --concurrency value: '${raw}' (expected a positive integer).`);
    }
    return parsed;
}

function buildEnv(remote: RemoteSource, token: string | undefined): EnvVars {
    const env: EnvVars = { ...process.env };
    if (token !== undefined && remote.tokenEnvVar !== undefined) {
        env[remote.tokenEnvVar] = token;
    }
    return env;
}

export async function runDownload(argv: string[]): Promise<void> {
    const args = parseArgs({
        args: argv,
        options: {
            output: { type: "string", short: "o", default: "." },
            "skip-existing": { type: "boolean", default: false },
            concurrency: { type: "string", default: String(DEFAULT_CONCURRENCY) },
            "dry-run": { type: "boolean", default: false },
            token: { type: "string" },
            help: { type: "boolean", short: "h", default: false },
        },
        strict: true,
        allowPositionals: true,
    });

    if (args.values.help || args.positionals.length === 0) {
        printUsage();
        return;
    }

    const remoteName = args.positionals[0]!;
    const url = args.positionals[1];
    if (url === undefined) {
        printUsage();
        fail("Missing <url> argument.");
    }

    const remote = getRemote(remoteName);
    if (remote === null) {
        const available = listRemotes().map((r) => r.name).join(", ");
        fail(`Unknown remote '${remoteName}'. Available remotes: ${available}.`);
    }

    if (!remote.matches(url)) {
        fail(`Remote '${remote.name}' does not recognize this URL: ${url}`);
    }

    const options: DownloadOptions = {
        outputDir: args.values.output,
        skipExisting: args.values["skip-existing"],
        concurrency: resolveConcurrency(args.values.concurrency),
        fs: new BunFileSystem(),
    };
    const env = buildEnv(remote, args.values.token);

    let plan: DownloadPlan;
    try {
        plan = await remote.plan(url, env);
    } catch (err) {
        const message = errorMessage(err);
        fail(`Failed to resolve download plan: ${message}`);
    }

    console.log(chalk.cyan(`Source: ${plan.rootLabel}`));
    console.log(`Files to download: ${plan.files.length}`);
    if (plan.files.length === 0) {
        console.warn(chalk.yellow("No files found at the given URL."));
        return;
    }

    if (args.values["dry-run"]) {
        console.log(chalk.gray("--- dry-run: no files written ---"));
        for (const file of plan.files) {
            console.log(`  ${file.relativePath}`);
        }
        return;
    }

    const summary = await executeDownload(plan, options);
    for (const outcome of summary.outcomes) {
        switch (outcome.status) {
            case "downloaded":
                console.log(`${chalk.green("✓")} ${outcome.relativePath}`);
                break;
            case "skipped":
                console.log(`${chalk.gray("=")} ${outcome.relativePath} ${chalk.gray("(skipped)")}`);
                break;
            case "too-large":
                console.warn(`${chalk.yellow("!")} ${outcome.relativePath} ${chalk.gray(`(too large: ${outcome.error ?? "unknown limit"})`)}`);
                break;
            case "failed":
                console.error(`${chalk.red("✗")} ${outcome.relativePath} — ${outcome.error ?? "unknown error"}`);
                break;
        }
    }

    console.log("");
    console.log(
        `Done. Downloaded: ${summary.downloaded}, Skipped: ${summary.skipped}, Too large: ${summary.tooLarge}, Failed: ${summary.failed}`,
    );
    console.log(`Location: ${resolve(options.outputDir)}`);

    if (summary.failed > 0) {
        process.exit(1);
    }
}

#!/usr/bin/env bun

import "../version.ts";

import { parseArgs } from "node:util";
import { createInterface } from "node:readline";

import chalk from "chalk";

import { EPF } from "./local-api-host.ts";
import type { EPFOptions } from "./local-api-host.ts";
import { parseAndExecute, COMMAND_NAMES } from "../command-handler.ts";
import { OutputViewingModeEnum } from "../util/config-schema.ts";
import { runMigrate } from "./migrate-host.ts";


// --- Subcommand dispatch: `even-pf migrate ...` ---
// Pre-scan the first user positional before the strict arg parse below, which
// does not know the migrator's flags (--dry-run / --output / --from) and would
// reject them. When "migrate" is the first user token, hand off to the
// migrator and exit without starting the engine/REPL.
if (Bun.argv[2] === "migrate") {
    // Forward user tokens only (index 3+); runMigrate has its own strict
    // parseArgs for -C/-O/--dry-run/--from + positionals. Unknown flags
    // (e.g. main-host --dir) get a clear "unknown option" error there.
    await runMigrate(Bun.argv.slice(3));
    process.exit(0);
}


// --- Parse CLI arguments (local to this host; no module-level Bun.argv parse) ---
const ARGS = parseArgs({
    args: Bun.argv,
    options: {
        config: {
            type: "string",
            short: "C",
        },
        dir: {
            type: "string",
            short: "D",
            default: ".",
        },
        skip_workflow: {
            type: "string",
            short: "S",
            multiple: true,
        },
        only_workflows: {
            type: "string",
            short: "O",
            multiple: true,
        },
    },
    strict: true,
    allowPositionals: true,
});

const options: EPFOptions = {
    config: ARGS.values.config,
    dir: ARGS.values.dir,
    only_workflows: ARGS.values.only_workflows,
    skip_workflow: ARGS.values.skip_workflow,
};

// --- Build the embeddable EPF core (loads config, creates Engine, starts API server) ---
const epf = await EPF.create(options);
const config = epf.engine.getConfig();

// --- WebUI mode: print the frontend URL ---
if (config.output_viewing.mode === OutputViewingModeEnum.WebUI) {
    console.log(chalk.cyan("Open the following URL to view all outputs:"));
    console.log(epf.getFrontendUrl());
}

// --- Initial workflow run ---
const initialResults = await epf.runInitial();

// Print summary of initial run
const succeeded = initialResults.filter((r) => r.status === "succeeded").length;
const failed = initialResults.filter((r) => r.status === "failed").length;
console.log(`\nInitial run complete. Succeeded: ${succeeded}; Failed: ${failed}`);
if (failed > 0) {
    for (const r of initialResults.filter((r) => r.status === "failed")) {
        console.warn(`  Workflow '${r.slug}' failed: ${r.error ?? "unknown"}`);
    }
}

// In Local mode, print per-file links after initial run
if (config.output_viewing.mode === OutputViewingModeEnum.Local) {
    const files = epf.engine.outputViewer.getFileList();
    if (files.length > 0) {
        console.log("\nClick the following links to view the outputs in your browser:");
        for (const file of files) {
            const record = epf.engine.outputViewer.getFile(file.name);
            if (record) {
                const params = new URLSearchParams();
                params.set("name", file.name);
                params.set("comp", "gzip");
                params.set("data", Bun.gzipSync(record.content).toBase64());
                const url = `${config.output_viewing.webui_base_url}/tools/results-viewer#${params.toString()}`;
                console.log(`${chalk.cyan(file.name)}: ${url}\n`);
            }
        }
    } else {
        console.warn("No files to display.");
    }
}

// --- Tab-completion ---
function completer(line: string): [string[], string] {
    const trimmed = line.trimStart();
    const parts = trimmed.split(/\s+/);

    // Completing the command name (first token)
    if (parts.length <= 1) {
        const hits = COMMAND_NAMES.filter((c) => c.startsWith(trimmed.toLowerCase()));
        return [hits, trimmed];
    }

    // Completing workflow slugs for "run", "rerun", and "clear"
    const command = parts[0]!.toLowerCase();
    if (command === "run" || command === "rerun" || command === "clear") {
        const partial = parts[parts.length - 1]!;
        const workflows = epf.engine.listWorkflows();
        const allSlugs = [...workflows.analysis, ...workflows.testing];
        const hits = allSlugs.filter((s) => s.startsWith(partial));
        return [hits, partial];
    }

    return [[], line];
}

// --- Catch SDK-internal async errors that escape try/catch ---
// The underlying fetch stack can throw network errors (e.g. ECONNRESET) from
// internally-spawned micro-tasks after generateText() has already been awaited.
// These surface as unhandled promise rejections and would crash Bun without
// this handler.
process.on("unhandledRejection", (reason: unknown) => {
    const message = reason instanceof Error ? reason.message : String(reason);
    console.error(chalk.red(`[epf] Unhandled async error (process kept alive): ${message}`));
});

// --- REPL loop ---
const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: chalk.green("epf> "),
    completer,
});

console.log(chalk.gray("\nInteractive mode. Type 'help' for commands, 'exit' to quit.\n"));
rl.prompt();

rl.on("line", async (line: string) => {
    const result = await parseAndExecute(epf.engine, line);

    if (result.kind === "exit") {
        console.log(result.message);
        rl.close();
        return;
    }

    if (result.message.length > 0) {
        if (result.kind === "error") {
            console.error(chalk.red(result.message));
        } else {
            console.log(result.message);
        }
    }

    rl.prompt();
});

rl.on("close", () => {
    console.log(chalk.gray("Goodbye."));
    epf.stop();
    process.exit(0);
});

// Graceful Ctrl+C handling
process.on("SIGINT", () => {
    console.log(chalk.gray("\nReceived SIGINT."));
    rl.close();
});

#!/usr/bin/env bun

import "../version.ts";

import { createInterface } from "node:readline";

import chalk from "chalk";

import { ARGS } from "../util/args.ts";
import { CONFIG } from "../util/config.ts";
import { Engine } from "../engine/index.ts";
import { parseAndExecute, COMMAND_NAMES } from "../command-handler.ts";
import { startApiServer } from "../api-server.ts";
import { OutputViewingModeEnum } from "../util/config-schema.ts";


const engine = new Engine(CONFIG);

// --- Start API server (WebUI mode) or skip (Local mode) ---
let apiServerHandle: { url: string; stop: () => void } | null = null;
let frontendURL = "";

if (CONFIG.output_viewing.mode === OutputViewingModeEnum.WebUI) {
    apiServerHandle = startApiServer(engine, CONFIG.output_viewing.api_port);
    const params = new URLSearchParams();
    params.set("api", apiServerHandle.url);
    frontendURL = `${CONFIG.output_viewing.webui_base_url}/tools/results-viewer#${params.toString()}`;

    console.log(chalk.cyan("Open the following URL to view all outputs:"));
    console.log(frontendURL);
}

// --- Initial workflow run (same as old cli.ts) ---
const onlySlugs: string[] | undefined = ARGS.values.only_workflows;
const skipSlugs: string[] | undefined = ARGS.values.skip_workflow;

const initialResults = await engine.runWorkflows({
    only: onlySlugs,
    skip: skipSlugs,
});

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
if (CONFIG.output_viewing.mode === OutputViewingModeEnum.Local) {
    const files = engine.outputViewer.getFileList();
    if (files.length > 0) {
        console.log("\nClick the following links to view the outputs in your browser:");
        for (const file of files) {
            const record = engine.outputViewer.getFile(file.name);
            if (record) {
                const params = new URLSearchParams();
                params.set("name", file.name);
                params.set("comp", "gzip");
                params.set("data", Bun.gzipSync(record.content).toBase64());
                const url = `${CONFIG.output_viewing.webui_base_url}/tools/results-viewer#${params.toString()}`;
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
        const workflows = engine.listWorkflows();
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
    const result = await parseAndExecute(engine, line);

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
    if (apiServerHandle) {
        apiServerHandle.stop();
    }
    process.exit(0);
});

// Graceful Ctrl+C handling
process.on("SIGINT", () => {
    console.log(chalk.gray("\nReceived SIGINT."));
    rl.close();
});

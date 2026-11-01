#!/usr/bin/env bun

import "../version.ts";

import { parseArgs } from "node:util";
import { createInterface } from "node:readline";

import chalk from "chalk";

import { EPF } from "./local-api-host.ts";
import type { EPFOptions } from "./local-api-host.ts";
import { parseAndExecute, COMMAND_NAMES } from "../command-handler.ts";
import { errorMessage } from "../util/errors.ts";
import { OutputViewingModeEnum } from "../util/config-schema.ts";
import { chatHelpText, formatSessionSummary, parseChatInput } from "../util/chat-repl.ts";
import { messageText } from "../util/chat-session.ts";
import { runMigrate } from "./migrate-host.ts";
import { runDownload } from "./download-host.ts";
import type { ChatOutcome } from "../util/chat-service.ts";
import type { ChatSession } from "../util/chat-session.ts";


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


// --- Subcommand dispatch: `even-pf download ...` ---
// Same pre-scan pattern as `migrate`. The downloader is independent of the
// engine/config and has its own flags (--output / --skip-existing / etc.), so
// hand off before the strict arg parse below and exit.
if (Bun.argv[2] === "download") {
    await runDownload(Bun.argv.slice(3));
    process.exit(0);
}


// --- Subcommand dispatch: `even-pf chat [SESSION]` ---
// Starting in chat skips the initial workflow batch, so opening a conversation
// does not spend API tokens re-running analyses. Exiting chat leaves the normal
// REPL available (the initial run stays skipped; use `run` explicitly).
const IS_CHAT_SUBCOMMAND = Bun.argv[2] === "chat";
const ARG_SOURCE = IS_CHAT_SUBCOMMAND
    ? [Bun.argv[0]!, Bun.argv[1]!, ...Bun.argv.slice(3)]
    : Bun.argv;


// --- Parse CLI arguments (local to this host; no module-level Bun.argv parse) ---
const ARGS = parseArgs({
    args: ARG_SOURCE,
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

/** `even-pf chat [SESSION]` — the first non-flag positional after the script. */
const CHAT_ARGUMENT = IS_CHAT_SUBCOMMAND ? (ARGS.positionals[2] ?? "") : "";

// --- Build the embeddable EPF core (loads config, creates Engine, starts API server) ---
const epf = await EPF.create(options);
const config = epf.engine.getConfig();

// --- WebUI mode: print the frontend URL ---
if (config.output_viewing.mode === OutputViewingModeEnum.WebUI) {
    console.log(chalk.cyan("Open the following URL to view all outputs:"));
    console.log(epf.getFrontendUrl());
}

// --- Initial workflow run + output links (deferred when starting in chat) ---
async function runInitial(): Promise<void> {
    const initialResults = await epf.runInitial();

    const succeeded = initialResults.filter((r) => r.status === "succeeded").length;
    const failed = initialResults.filter((r) => r.status === "failed").length;
    console.log(`\nInitial run complete. Succeeded: ${succeeded}; Failed: ${failed}`);
    if (failed > 0) {
        for (const r of initialResults.filter((r) => r.status === "failed")) {
            console.warn(`  Workflow '${r.slug}' failed: ${r.error ?? "unknown"}`);
        }
    }

    // In Local mode, print per-file links after the run.
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

    await refreshSessionCache();
}

// --- Chat mode ---
type ChatMode = {
    sessionId: string;
    /** Whether reasoning deltas are echoed (off by default). */
    reasoning: boolean;
};

const MAIN_PROMPT = chalk.green("epf> ");
const CHAT_PROMPT = chalk.cyan("epf/chat> ");

let chatMode: ChatMode | null = null;
let rlClosed = false;
/** Session ids for tab completion; refreshed after runs and when entering chat. */
let sessionIds: string[] = [];

/**
 * `rl.prompt()` throws ERR_USE_AFTER_CLOSE when stdin ends before an async
 * command finishes (piped input, for example). Nothing is left to prompt for
 * in that case, so the close handler will exit the process.
 */
function promptUser(): void {
    // Bun exposes `closed` at runtime but Node's type does not declare it.
    const maybeClosed = (rl as unknown as { closed?: boolean }).closed === true;
    if (rlClosed || maybeClosed) {
        return;
    }
    rl.prompt();
}

async function refreshSessionCache(): Promise<void> {
    try {
        sessionIds = (await epf.engine.listSessions()).map((session) => session.id);
    } catch {
        sessionIds = [];
    }
}

function describeSession(session: ChatSession): string {
    const lines = [
        `Chat session ${chalk.cyan(session.id)}`,
        `  workflow: ${session.workflow.slug} (run ${session.workflow.run}) · model ${session.workflow.model}` +
            (session.origin === "web" ? " · created in the browser" : ""),
        `  ${session.messages.length} message(s) · type :help for commands, exit to leave chat`,
    ];
    const lastAssistant = [...session.messages].reverse().find((message) => message.role === "assistant");
    if (lastAssistant !== undefined) {
        const text = messageText(lastAssistant).replace(/\s+/g, " ").trim();
        if (text.length > 0) {
            lines.push(`  last reply: ${text.length > 400 ? `${text.slice(0, 400)}…` : text}`);
        }
    }
    return lines.join("\n");
}

async function enterChat(reference: string): Promise<void> {
    const engine = epf.engine;
    let session: ChatSession | null = null;

    if (reference.length === 0 || reference === "latest" || reference === "last") {
        session = await engine.latestSession();
    } else {
        const matches = await engine.findSessions(reference);
        if (matches.length === 0) {
            console.log(chalk.yellow(`No chat session matches '${reference}'.`));
        } else if (matches.length > 1) {
            console.log(chalk.yellow(`'${reference}' matches ${matches.length} sessions; use a longer prefix:`));
            for (const match of matches) {
                console.log(`  • ${match.id}`);
            }
        } else {
            session = matches[0]!;
        }
    }

    if (session === null) {
        const sessions = await engine.listSessions();
        if (sessions.length === 0) {
            console.log("No chat sessions yet. Run a workflow first.");
        } else {
            console.log("Recent chat sessions:");
            for (const summary of sessions.slice(0, 10)) {
                console.log(formatSessionSummary(summary));
            }
        }
        return;
    }

    chatMode = { sessionId: session.id, reasoning: false };
    await refreshSessionCache();
    console.log(describeSession(session));
    console.log(chalk.gray("(Exiting chat returns to the EPF REPL; the initial workflow run was skipped.)\n"));
    rl.setPrompt(CHAT_PROMPT);
    promptUser();
}

function chatHandlers(mode: ChatMode) {
    return {
        onText: (delta: string) => process.stdout.write(delta),
        onReasoning: mode.reasoning ? (delta: string) => process.stdout.write(chalk.gray(delta)) : undefined,
    };
}

async function runChatAction(action: () => Promise<ChatOutcome>): Promise<void> {
    process.stdout.write("\n");
    try {
        const outcome = await action();
        process.stdout.write("\n");
        if (outcome.status === "failed") {
            console.error(chalk.red(`[chat] ${outcome.error ?? "The reply failed."}`));
            return;
        }
        const metrics = [...outcome.session.meta].reverse().find((meta) => meta.metrics !== undefined)?.metrics;
        if (metrics !== undefined) {
            console.log(chalk.gray(
                `[${metrics.model} · ${metrics.totalTokens} tokens · ${(metrics.latencyMs / 1000).toFixed(1)}s]`,
            ));
        }
    } catch (error) {
        process.stdout.write("\n");
        const message = errorMessage(error);
        console.error(chalk.red(`[chat] ${message}`));
    }
}

async function handleChatLine(line: string, mode: ChatMode): Promise<void> {
    const input = parseChatInput(line);
    switch (input.kind) {
        case "empty":
            return;
        case "exit":
            chatMode = null;
            rl.setPrompt(MAIN_PROMPT);
            console.log(chalk.gray("Left chat mode."));
            return;
        case "help":
            console.log(chatHelpText());
            return;
        case "toggle-reasoning":
            mode.reasoning = !mode.reasoning;
            console.log(`Reasoning display ${mode.reasoning ? "on" : "off"}.`);
            return;
        case "regenerate":
            await runChatAction(() => epf.engine.regenerateSession(mode.sessionId, chatHandlers(mode)));
            return;
        case "message":
            await runChatAction(() => epf.engine.chatSession(mode.sessionId, input.text, chatHandlers(mode)));
            return;
    }
}


// --- Tab-completion ---
function completer(line: string): [string[], string] {
    if (chatMode !== null) {
        return [[], line];
    }

    const trimmed = line.trimStart();
    const parts = trimmed.split(/\s+/);

    // Completing the command name (first token)
    if (parts.length <= 1) {
        const hits = COMMAND_NAMES.filter((c) => c.startsWith(trimmed.toLowerCase()));
        return [hits, trimmed];
    }

    const command = parts[0]!.toLowerCase();
    // Completing workflow slugs for "run", "rerun", and "clear"
    if (command === "run" || command === "rerun" || command === "clear") {
        const partial = parts[parts.length - 1]!;
        const workflows = epf.engine.listWorkflows();
        const allSlugs = [...workflows.analysis, ...workflows.testing];
        const hits = allSlugs.filter((s) => s.startsWith(partial));
        return [hits, partial];
    }

    // Completing session ids for "chat"
    if (command === "chat") {
        const partial = parts[parts.length - 1]!;
        const hits = sessionIds.filter((id) => id.startsWith(partial));
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
    const message = errorMessage(reason);
    console.error(chalk.red(`[epf] Unhandled async error (process kept alive): ${message}`));
});

// --- REPL loop ---
const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: MAIN_PROMPT,
    completer,
});

console.log(chalk.gray("\nInteractive mode. Type 'help' for commands, 'exit' to quit.\n"));

if (IS_CHAT_SUBCOMMAND) {
    await enterChat(CHAT_ARGUMENT);
    if (chatMode === null) {
        promptUser();
    }
} else {
    await runInitial();
    promptUser();
}

rl.on("line", async (line: string) => {
    if (chatMode !== null) {
        await handleChatLine(line, chatMode);
        promptUser();
        return;
    }

    // `chat <reference>` is interactive, so it is handled here rather than in
    // the shared command handler. `chat` and `chat --all` fall through to the
    // listing command.
    const trimmed = line.trim();
    const parts = trimmed.split(/\s+/);
    if (parts[0]?.toLowerCase() === "chat" && parts.length > 1 && !parts[1]!.startsWith("-")) {
        await enterChat(parts[1]!);
        if (chatMode === null) {
            promptUser();
        }
        return;
    }

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

    // `run` / `rerun` may have created sessions; keep completion current.
    const command = parts[0]?.toLowerCase() ?? "";
    if (command === "run" || command === "rerun") {
        await refreshSessionCache();
    }

    promptUser();
});

rl.on("close", () => {
    rlClosed = true;
    console.log(chalk.gray("Goodbye."));
    epf.stop();
    process.exit(0);
});

// Graceful Ctrl+C handling: leave chat first, then shut down.
process.on("SIGINT", () => {
    if (chatMode !== null) {
        chatMode = null;
        rl.setPrompt(MAIN_PROMPT);
        console.log(chalk.gray("\nLeft chat mode."));
        promptUser();
        return;
    }
    console.log(chalk.gray("\nReceived SIGINT."));
    rl.close();
});

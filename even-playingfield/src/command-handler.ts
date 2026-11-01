import { formatFileListing, listTree, LIST_MAX_DEPTH } from "./util/file-listing.ts";
import { configSourceLabel } from "./util/config-loader.ts";
import { formatSessionSummary } from "./util/chat-repl.ts";
import { errorMessage } from "./util/errors.ts";
import { normalizePath } from "./platform/path.ts";
import type { EngineStatus, WorkflowRunResult } from "./engine/engine.ts";
import type { ChatSessionSummary } from "./util/chat-session.ts";
import type { ConfigSource } from "./util/config-loader.ts";
import type { FileStat, VirtualFileSystem } from "./platform/types.ts";

export type CommandResult = {
    kind: "output" | "error" | "exit";
    message: string;
};

/** Host flavour, used only where the CLI and the browser genuinely differ. */
export type CommandHost = "cli" | "web";

/**
 * The engine operations the command layer needs. Declared structurally so
 * hosts (and tests) can supply exactly this much, and so commands do not reach
 * for engine internals.
 */
export type CommandTarget = {
    runWorkflows(filters?: { only?: string[]; skip?: string[] }): Promise<WorkflowRunResult[]>;
    resolveOutputFileNames(knownOutputs: readonly string[], slugs?: string[]): string[];
    clearResultFiles(names: readonly string[]): void;
    getStatus(): EngineStatus;
    listWorkflows(): { analysis: string[]; testing: string[] };
    getFileSystem(): VirtualFileSystem;
    getConfigSource(): ConfigSource | undefined;
    listSessions(): Promise<ChatSessionSummary[]>;
    isSessionRecordingEnabled(): boolean;
    reloadConfig(): Promise<void>;
};

/**
 * Host-specific parts of command execution. Every field is optional so the CLI
 * and the HTTP API keep the plain behaviour; the browser host supplies the
 * workspace-aware variants.
 */
export type CommandContext = {
    /** Host flavour for help text (default "cli"). */
    host?: CommandHost;
    /** Header lines printed above an `ls` listing. */
    lsHeader?: string[];
    /** Output files the host knows about (defaults to the engine's list). */
    knownOutputs?: () => string[] | Promise<string[]>;
    /**
     * Delete exactly these output files and return the names removed. Omitted
     * by hosts that only track outputs in memory (the CLI), where the
     * dispatcher forgets the matching records instead.
     */
    clearOutputs?: (names: readonly string[]) => Promise<string[]>;
    /** Message for `exit`/`quit` (the browser cannot close its own tab). */
    exitMessage?: string;
};

type CommandHelpEntry = {
    /** Command names, including aliases, e.g. `exit / quit`. */
    names: string;
    args: string;
    summary: string;
    /** Replaces `summary` in the browser console. */
    webSummary?: string;
};

const COMMAND_HELP: readonly CommandHelpEntry[] = [
    { names: "run", args: "[slug...]", summary: "Run workflows (all if no slug given)" },
    { names: "rerun", args: "[slug...]", summary: "Clear outputs then re-run workflows (all if no slug given)" },
    { names: "clear", args: "[slug...]", summary: "Clear output files (all if no slug given)" },
    { names: "status", args: "", summary: "Show in-flight workflows and output file count" },
    { names: "list", args: "", summary: "Show all configured workflow slugs" },
    { names: "ls", args: "[dir] [--depth N]", summary: "List workspace files (defaults to the whole tree)" },
    {
        names: "chat",
        args: "[--all]",
        summary: "List recorded chat sessions for this workspace (CLI: 'chat <id>' continues one)",
        webSummary: "List recorded chat sessions (continue them in the Outputs tab)",
    },
    { names: "reload", args: "", summary: "Reload config from the same source as startup" },
    { names: "help", args: "", summary: "Show this help message" },
    {
        names: "exit / quit",
        args: "",
        summary: "Shut down the program",
        webSummary: "Do nothing (close the browser tab to leave)",
    },
];

const HELP_LABEL_WIDTH = 17;
const HELP_WRAP_INDENT = `  ${" ".repeat(HELP_LABEL_WIDTH)}`;

/** All recognized command names — exported for tab-completion. */
export const COMMAND_NAMES: readonly string[] = COMMAND_HELP.flatMap((entry) => entry.names.split(" / "));

/** Help text for a host. The commands are identical; two summaries are not. */
export function helpText(host: CommandHost = "cli"): string {
    const lines = ["Available commands:"];
    for (const entry of COMMAND_HELP) {
        const summary = host === "web" && entry.webSummary !== undefined ? entry.webSummary : entry.summary;
        const label = entry.args.length > 0 ? `${entry.names} ${entry.args}` : entry.names;
        if (label.length > HELP_LABEL_WIDTH) {
            lines.push(`  ${label}`);
            lines.push(`${HELP_WRAP_INDENT}${summary}`);
        } else {
            lines.push(`  ${label.padEnd(HELP_LABEL_WIDTH)}${summary}`);
        }
    }
    return lines.join("\n");
}

/**
 * Parse a raw command string and dispatch to the appropriate Engine method.
 * Returns a structured result that any input channel (CLI REPL, HTTP API,
 * browser console) can format however it likes.
 */
export async function parseAndExecute(
    engine: CommandTarget,
    rawInput: string,
    context: CommandContext = {},
): Promise<CommandResult> {
    const trimmed = rawInput.trim();
    if (trimmed.length === 0) {
        return { kind: "output", message: "" };
    }

    const parts = trimmed.split(/\s+/);
    const command = parts[0]!.toLowerCase();
    const args = parts.slice(1);

    switch (command) {
        case "run":
            return await handleRun(engine, args);
        case "rerun":
            return await handleRerun(engine, args, context);
        case "clear":
            return await handleClear(engine, args, context);
        case "status":
            return await handleStatus(engine, context);
        case "list":
            return handleList(engine);
        case "ls":
            return await handleLs(engine, args, context);
        case "chat":
            return await handleChat(engine, args);
        case "reload":
            return await handleReload(engine);
        case "help":
            return { kind: "output", message: helpText(context.host) };
        case "exit":
        case "quit":
            return {
                kind: "exit",
                message: context.exitMessage ?? "Shutting down...",
            };
        default:
            return { kind: "error", message: `Unknown command: '${command}'. Type 'help' for available commands.` };
    }
}

async function handleRun(engine: CommandTarget, slugs: string[]): Promise<CommandResult> {
    const filters = slugs.length > 0 ? { only: slugs } : undefined;
    const results = await engine.runWorkflows(filters);

    if (results.length === 0) {
        return { kind: "output", message: "No workflows matched the given filter." };
    }

    const lines: string[] = [];
    let hasFailures = false;
    for (const r of results) {
        switch (r.status) {
            case "succeeded":
                lines.push(`  ✓ ${r.slug} (run ${r.runNumber}) — succeeded` +
                    (r.sessionId !== undefined ? ` · chat: ${r.sessionId}` : ""));
                break;
            case "failed":
                lines.push(`  ✗ ${r.slug} (run ${r.runNumber}) — failed: ${r.error ?? "unknown error"}`);
                hasFailures = true;
                break;
            case "rejected":
                lines.push(`  ⊘ ${r.slug} — rejected: ${r.error ?? "already running"}`);
                hasFailures = true;
                break;
        }
    }

    const succeeded = results.filter((r) => r.status === "succeeded").length;
    const failed = results.filter((r) => r.status === "failed").length;
    const rejected = results.filter((r) => r.status === "rejected").length;

    lines.unshift(`Workflow run complete. Succeeded: ${succeeded}, Failed: ${failed}, Rejected: ${rejected}`);
    return { kind: hasFailures ? "error" : "output", message: lines.join("\n") };
}

async function handleClear(
    engine: CommandTarget,
    slugs: string[],
    context: CommandContext,
): Promise<CommandResult> {
    const removed = await clearMatchingOutputs(engine, slugs, context);
    const target = slugs.length > 0 ? slugs.join(", ") : "all";
    return { kind: "output", message: `Cleared results: ${target} (${removed.length} file(s)).` };
}

async function handleRerun(
    engine: CommandTarget,
    slugs: string[],
    context: CommandContext,
): Promise<CommandResult> {
    await clearMatchingOutputs(engine, slugs, context);
    return await handleRun(engine, slugs);
}

/**
 * Resolve the output names a `clear`/`rerun` targets, delete them on hosts that
 * own the files, and drop their records from the engine in every host. Uses the
 * same anchored `output_filename` matching everywhere, so `clear first` never
 * removes `x-result.md-evil.md`.
 */
async function clearMatchingOutputs(
    engine: CommandTarget,
    slugs: string[],
    context: CommandContext,
): Promise<string[]> {
    const known = await knownOutputs(engine, context);
    const filter = slugs.length > 0 ? slugs : undefined;
    const names = engine.resolveOutputFileNames(known, filter);

    if (context.clearOutputs !== undefined) {
        const removed = await context.clearOutputs(names);
        // The host deleted the files; also forget their records so `status`
        // and the results list do not keep pointing at deleted files.
        engine.clearResultFiles(removed);
        return removed;
    }
    engine.clearResultFiles(names);
    return [...names];
}

/** Output files the host knows about: its own list, or the engine's records. */
async function knownOutputs(engine: CommandTarget, context: CommandContext): Promise<string[]> {
    if (context.knownOutputs !== undefined) {
        return [...await context.knownOutputs()];
    }
    return engine.getStatus().completedFiles;
}

async function handleStatus(engine: CommandTarget, context: CommandContext): Promise<CommandResult> {
    const status = engine.getStatus();
    const files = await knownOutputs(engine, context);
    const lines: string[] = [];
    lines.push(`In-flight workflows: ${status.inFlight.length > 0 ? status.inFlight.join(", ") : "(none)"}`);
    lines.push(`Output files: ${files.length}`);
    for (const file of files) {
        lines.push(`  • ${file}`);
    }
    return { kind: "output", message: lines.join("\n") };
}

function handleList(engine: CommandTarget): CommandResult {
    const workflows = engine.listWorkflows();
    const lines: string[] = [];

    if (workflows.analysis.length > 0) {
        lines.push("Analysis workflows:");
        for (const slug of workflows.analysis) {
            lines.push(`  • ${slug}`);
        }
    }
    if (workflows.testing.length > 0) {
        if (lines.length > 0) {
            lines.push("");
        }
        lines.push("Testing workflows:");
        for (const slug of workflows.testing) {
            lines.push(`  • ${slug}`);
        }
    }

    if (lines.length === 0) {
        return { kind: "output", message: "No workflows configured." };
    }
    return { kind: "output", message: lines.join("\n") };
}

/** Context lines printed above an `ls` listing, supplied by the host. */
export type LsContext = {
    header?: string[];
};

type ParsedLsArgs =
    | { kind: "parsed"; path: string; maxDepth: number }
    | { kind: "error"; message: string };

const LS_USAGE = "Usage: ls [dir] [--depth N]";

function parseLsDepth(value: string | undefined): number | null {
    if (value === undefined || !/^\d+$/.test(value)) {
        return null;
    }
    const depth = Number.parseInt(value, 10);
    return depth >= 1 ? depth : null;
}

function parseLsArgs(args: string[]): ParsedLsArgs {
    let path = ".";
    let hasPath = false;
    let maxDepth = LIST_MAX_DEPTH;

    for (let index = 0; index < args.length; index += 1) {
        const arg = args[index]!;
        if (arg === "--depth" || arg === "-d") {
            const depth = parseLsDepth(args[index + 1]);
            if (depth === null) {
                return { kind: "error", message: `--depth needs a positive whole number. ${LS_USAGE}` };
            }
            maxDepth = depth;
            index += 1;
            continue;
        }
        if (arg.startsWith("--depth=")) {
            const depth = parseLsDepth(arg.slice("--depth=".length));
            if (depth === null) {
                return { kind: "error", message: `--depth needs a positive whole number. ${LS_USAGE}` };
            }
            maxDepth = depth;
            continue;
        }
        if (arg.startsWith("-")) {
            return { kind: "error", message: `Unknown option '${arg}'. ${LS_USAGE}` };
        }
        if (hasPath) {
            return { kind: "error", message: `ls lists one directory at a time. ${LS_USAGE}` };
        }
        path = normalizePath(arg);
        hasPath = true;
    }

    return { kind: "parsed", path, maxDepth };
}

/**
 * `ls [dir] [--depth N]` — list the workspace tree a run would search.
 *
 * Takes the filesystem directly (rather than an Engine) so the browser console
 * can use it before — or without — a config being loaded, which is when the
 * "No files found for workflow" question usually comes up.
 */
export async function executeLs(fs: VirtualFileSystem, args: string[], context: LsContext = {}): Promise<CommandResult> {
    const parsed = parseLsArgs(args);
    if (parsed.kind === "error") {
        return { kind: "error", message: parsed.message };
    }

    const target = parsed.path;
    let info: FileStat | null;
    try {
        info = await fs.stat(target);
    } catch (error) {
        const message = errorMessage(error);
        return { kind: "error", message: `Cannot read '${target}': ${message}` };
    }
    if (info === null) {
        return { kind: "error", message: `Not found in the workspace: '${target}'. Run 'ls' to see the root.` };
    }

    try {
        const listing = await listTree(fs, { path: target, maxDepth: parsed.maxDepth });
        const header = context.header !== undefined && context.header.length > 0
            ? [...context.header, ""]
            : [];
        const title = target === "." ? "Listing the workspace root" : `Listing '${target}'`;
        return {
            kind: "output",
            message: [...header, title, "", formatFileListing(listing)].join("\n"),
        };
    } catch (error) {
        const message = errorMessage(error);
        return { kind: "error", message: `Cannot list '${target}': ${message}` };
    }
}

async function handleLs(
    engine: CommandTarget,
    args: string[],
    context: CommandContext,
): Promise<CommandResult> {
    const fs = engine.getFileSystem();
    const source: ConfigSource | undefined = engine.getConfigSource();
    return await executeLs(fs, args, {
        header: context.lsHeader ?? [
            `Working directory: ${fs.root}`,
            `Config: ${source === undefined ? "(none loaded)" : configSourceLabel(source)}`,
        ],
    });
}

/**
 * `chat` lists recorded sessions. Continuing one is interactive, so it lives in
 * the CLI REPL (`chat <id>`); the browser uses the Outputs tab instead.
 */
async function handleChat(engine: CommandTarget, args: string[]): Promise<CommandResult> {
    const showAll = args.includes("--all");
    const sessions = (await engine.listSessions()).filter((session) => showAll || session.workspace === engine.getFileSystem().root);

    if (sessions.length === 0) {
        const scope = showAll ? "" : " for this workspace";
        return {
            kind: "output",
            message: `No chat sessions${scope}.${engine.isSessionRecordingEnabled() ? "" : " Session recording is disabled ([sessions] enabled = false)."}`,
        };
    }

    const lines: string[] = [`Chat sessions (${sessions.length}), newest first:`];
    for (const session of sessions) {
        lines.push(formatSessionSummary(session));
    }
    lines.push("", "Use 'chat <id-or-prefix>' in the CLI REPL, or the Outputs tab in the browser.");
    return { kind: "output", message: lines.join("\n") };
}

async function handleReload(engine: CommandTarget): Promise<CommandResult> {
    try {
        await engine.reloadConfig();
        return { kind: "output", message: "Config reloaded successfully." };
    } catch (error) {
        const message = errorMessage(error);
        return { kind: "error", message: `Failed to reload config: ${message}` };
    }
}

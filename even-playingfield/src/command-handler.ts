import { formatFileListing, listTree, LIST_MAX_DEPTH } from "./util/file-listing.ts";
import { configSourceLabel } from "./util/config-loader.ts";
import { formatSessionSummary } from "./util/chat-repl.ts";
import { normalizePath } from "./platform/path.ts";
import type { Engine } from "./engine/index.ts";
import type { ConfigSource } from "./util/config-loader.ts";
import type { FileStat, VirtualFileSystem } from "./platform/types.ts";

export type CommandResult = {
    kind: "output" | "error" | "exit";
    message: string;
};

/** All recognized command names — exported for tab-completion. */
export const COMMAND_NAMES: readonly string[] = [
    "run",
    "rerun",
    "clear",
    "status",
    "list",
    "ls",
    "chat",
    "reload",
    "help",
    "exit",
    "quit",
] as const;

const HELP_TEXT = `Available commands:
  run [slug...]    Run workflows (all if no slug given)
  rerun [slug...]  Clear outputs then re-run workflows (all if no slug given)
  clear [slug...]  Clear output files (all if no slug given)
  status           Show in-flight workflows and output file count
  list             Show all configured workflow slugs
  ls [dir] [--depth N]
                   List workspace files (defaults to the whole tree)
  chat [--all]     List recorded chat sessions for this workspace
                   (CLI: 'chat <id>' continues one)
  reload           Reload config from the same source as startup
  help             Show this help message
  exit / quit      Shut down the program`;

/**
 * Parse a raw command string and dispatch to the appropriate Engine method.
 * Returns a structured result that any input channel (CLI REPL, HTTP API)
 * can format however it likes.
 */
export async function parseAndExecute(engine: Engine, rawInput: string): Promise<CommandResult> {
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
            return await handleRerun(engine, args);
        case "clear":
            return handleClear(engine, args);
        case "status":
            return handleStatus(engine);
        case "list":
            return handleList(engine);
        case "ls":
            return await handleLs(engine, args);
        case "chat":
            return await handleChat(engine, args);
        case "reload":
            return await handleReload(engine);
        case "help":
            return { kind: "output", message: HELP_TEXT };
        case "exit":
        case "quit":
            return { kind: "exit", message: "Shutting down..." };
        default:
            return { kind: "error", message: `Unknown command: '${command}'. Type 'help' for available commands.` };
    }
}

async function handleRun(engine: Engine, slugs: string[]): Promise<CommandResult> {
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

function handleClear(engine: Engine, slugs: string[]): CommandResult {
    const filter = slugs.length > 0 ? slugs : undefined;
    engine.clearResults(filter);
    const target = filter ? filter.join(", ") : "all";
    return { kind: "output", message: `Cleared results: ${target}` };
}

async function handleRerun(engine: Engine, slugs: string[]): Promise<CommandResult> {
    // Resolve output_filename prefixes from config for the matched workflows so that
    // clearing uses the config-defined filename pattern rather than the raw slug args.
    // This is necessary because output filenames may be abbreviated relative to the slug.
    const onlySlugs = slugs.length > 0 ? slugs : undefined;
    const filePatterns = engine.resolveOutputFilePatterns(onlySlugs);
    engine.clearResults(filePatterns.length > 0 ? filePatterns : undefined);
    return await handleRun(engine, slugs);
}

function handleStatus(engine: Engine): CommandResult {
    const status = engine.getStatus();
    const lines: string[] = [];
    lines.push(`In-flight workflows: ${status.inFlight.length > 0 ? status.inFlight.join(", ") : "(none)"}`);
    lines.push(`Output files: ${status.completedFiles.length}`);
    if (status.completedFiles.length > 0) {
        for (const f of status.completedFiles) {
            lines.push(`  • ${f}`);
        }
    }
    return { kind: "output", message: lines.join("\n") };
}

function handleList(engine: Engine): CommandResult {
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
        const message = error instanceof Error ? error.message : String(error);
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
        const message = error instanceof Error ? error.message : String(error);
        return { kind: "error", message: `Cannot list '${target}': ${message}` };
    }
}

async function handleLs(engine: Engine, args: string[]): Promise<CommandResult> {
    const fs = engine.getFileSystem();
    const source: ConfigSource | undefined = engine.getConfigSource();
    return await executeLs(fs, args, {
        header: [
            `Working directory: ${fs.root}`,
            `Config: ${source === undefined ? "(none loaded)" : configSourceLabel(source)}`,
        ],
    });
}

/**
 * `chat` lists recorded sessions. Continuing one is interactive, so it lives in
 * the CLI REPL (`chat <id>`); the browser uses the Outputs tab instead.
 */
async function handleChat(engine: Engine, args: string[]): Promise<CommandResult> {
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

async function handleReload(engine: Engine): Promise<CommandResult> {
    try {
        await engine.reloadConfig();
        return { kind: "output", message: "Config reloaded successfully." };
    } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { kind: "error", message: `Failed to reload config: ${message}` };
    }
}

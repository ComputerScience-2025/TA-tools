import type { Engine } from "./engine/index.ts";

export type CommandResult = {
    kind: "output" | "error" | "exit";
    message: string;
};

/** All recognized command names — exported for tab-completion. */
export const COMMAND_NAMES: readonly string[] = [
    "run",
    "clear",
    "status",
    "list",
    "help",
    "exit",
    "quit",
] as const;

const HELP_TEXT = `Available commands:
  run [slug...]    Re-run workflows (all if no slug given)
  clear [slug...]  Clear output files (all if no slug given)
  status           Show in-flight workflows and output file count
  list             Show all configured workflow slugs
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
        case "clear":
            return handleClear(engine, args);
        case "status":
            return handleStatus(engine);
        case "list":
            return handleList(engine);
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
                lines.push(`  ✓ ${r.slug} (run ${r.runNumber}) — succeeded`);
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

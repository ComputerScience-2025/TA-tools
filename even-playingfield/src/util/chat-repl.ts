/**
 * Input handling and formatting shared by the CLI chat mode and the `chat`
 * command. Pure functions only, so the interactive loop is testable without
 * readline.
 */

import type { ChatSessionSummary } from "./chat-session.ts";

export type ChatInput =
    | { kind: "message"; text: string }
    | { kind: "exit" }
    | { kind: "regenerate" }
    | { kind: "help" }
    | { kind: "toggle-reasoning" }
    | { kind: "empty" };

export function parseChatInput(line: string): ChatInput {
    const trimmed = line.trim();
    if (trimmed.length === 0) {
        return { kind: "empty" };
    }
    const lower = trimmed.toLowerCase();
    if (lower === "exit" || lower === "quit" || lower === ":q" || lower === ":quit" || lower === ":exit") {
        return { kind: "exit" };
    }
    if (lower === ":regen" || lower === ":regenerate") {
        return { kind: "regenerate" };
    }
    if (lower === ":reasoning") {
        return { kind: "toggle-reasoning" };
    }
    if (lower === "help" || lower === ":help" || lower === ":?") {
        return { kind: "help" };
    }
    return { kind: "message", text: trimmed };
}

export function chatHelpText(): string {
    return `Chat mode:
  <text>        Send a message
  :regen        Regenerate the last reply
  :reasoning    Show or hide the model's reasoning
  :help         Show this help
  exit / :q     Leave chat and return to the EPF REPL`;
}

/** ISO timestamp shortened for a terminal listing. */
export function formatSessionTime(iso: string): string {
    const date = new Date(iso);
    if (Number.isNaN(date.getTime())) {
        return "(unknown time)";
    }
    return `${date.toISOString().replace("T", " ").slice(0, 16)} UTC`;
}

/** One line for a session list. Shared by `chat` and the CLI banner. */
export function formatSessionSummary(session: ChatSessionSummary): string {
    return `  • ${session.id}  [${session.workflow_slug} r${session.run}]  ` +
        `${session.turns} turn(s)  ${session.origin}  ${formatSessionTime(session.updated_at)}`;
}

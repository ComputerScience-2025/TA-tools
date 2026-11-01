import { describe, expect, test } from "bun:test";

import { formatSessionSummary, parseChatInput } from "./chat-repl.ts";
import type { ChatSessionSummary } from "./chat-session.ts";

describe("parseChatInput", () => {
    test("treats plain text as a message", () => {
        expect(parseChatInput("  what about Helper.cs?  ")).toEqual({ kind: "message", text: "what about Helper.cs?" });
        expect(parseChatInput("multi\nline")).toEqual({ kind: "message", text: "multi\nline" });
    });

    test("recognizes exit and quit variants", () => {
        for (const value of ["exit", "quit", ":q", ":quit", ":exit", " EXIT "]) {
            expect(parseChatInput(value)).toEqual({ kind: "exit" });
        }
    });

    test("recognizes chat commands", () => {
        expect(parseChatInput(":regen")).toEqual({ kind: "regenerate" });
        expect(parseChatInput(":regenerate")).toEqual({ kind: "regenerate" });
        expect(parseChatInput(":reasoning")).toEqual({ kind: "toggle-reasoning" });
        expect(parseChatInput(":help")).toEqual({ kind: "help" });
        expect(parseChatInput("help")).toEqual({ kind: "help" });
        expect(parseChatInput("   ")).toEqual({ kind: "empty" });
    });
});

describe("formatSessionSummary", () => {
    test("includes the workflow, run, turn count and origin", () => {
        const summary: ChatSessionSummary = {
            id: "20261030-101500-analysis-r1",
            workflow_slug: "analysis",
            kind: "analysis",
            run: 1,
            model: "general_analysis",
            origin: "cli",
            workspace: "/ws",
            created_at: "2026-10-30T10:15:00.000Z",
            updated_at: "2026-10-30T10:16:30.000Z",
            turns: 2,
            outputs: [],
        };
        const line = formatSessionSummary(summary);
        expect(line).toContain("20261030-101500-analysis-r1");
        expect(line).toContain("[analysis r1]");
        expect(line).toContain("2 turn(s)");
        expect(line).toContain("cli");
        expect(line).toContain("2026-10-30 10:16 UTC");
    });
});

import { describe, expect, test } from "bun:test";

import { createZenFileSystem } from "../platform/web/zen-vfs.ts";
import { SessionStore } from "./session-store.ts";
import { createSessionId, messageReasoning, messageText, stripReasoning, userMessage } from "./chat-session.ts";
import type { CreateChatSessionInput } from "./chat-session.ts";

const META = { at: "2026-10-30T10:15:00.000Z" };

async function createStore(root: string): Promise<{ store: SessionStore; fs: Awaited<ReturnType<typeof createZenFileSystem>>["fs"]; warnings: string[] }> {
    const mount = await createZenFileSystem({ persist: false, root });
    const warnings: string[] = [];
    const store = new SessionStore(mount.fs, `${root}/sessions`, {
        onWarning: (message) => warnings.push(message),
    });
    return { store, fs: mount.fs, warnings };
}

function sessionInput(id = createSessionId("analysis", 1, new Date("2026-10-30T10:15:00.000Z"))): CreateChatSessionInput {
    return {
        id,
        origin: "cli",
        workspace: "/workspace",
        workflow: { slug: "analysis", kind: "analysis", run: 1, model: "general_analysis" },
        system_prompt: "You are grading.",
        messages: [
            userMessage("Initial request"),
            {
                role: "assistant",
                content: [
                    { type: "reasoning", text: "thinking" },
                    { type: "text", text: "## Review\n\nLooks fine." },
                ],
            },
        ],
        meta: [META, { ...META, metrics: undefined }],
        outputs: [{ filename: "analysis.md" }],
    };
}

describe("SessionStore", () => {
    test("creates, lists and reads a session", async () => {
        const { store } = await createStore("/store-test");
        const created = await store.create(sessionInput());

        expect(created.id).toBe("20261030-101500-analysis-r1");
        expect(created.version).toBe(1);

        const summaries = await store.listSummaries();
        expect(summaries).toHaveLength(1);
        expect(summaries[0]!.workflow_slug).toBe("analysis");
        expect(summaries[0]!.turns).toBe(1);

        const read = await store.read(created.id);
        expect(read).not.toBeNull();
        expect(messageText(read!.messages[1]!)).toContain("Looks fine");
        expect(messageReasoning(read!.messages[1]!)).toBe("thinking");
    });

    test("suffixes a colliding id instead of overwriting", async () => {
        const { store } = await createStore("/store-collision");
        const first = await store.create(sessionInput("same"));
        const second = await store.create(sessionInput("same"));

        expect(first.id).toBe("same");
        expect(second.id).toBe("same-2");
    });

    test("finds exact ids and unique prefixes, and reports ambiguity", async () => {
        const { store } = await createStore("/store-find");
        await store.create(sessionInput("alpha-1"));
        await store.create(sessionInput("alpha-2"));

        expect((await store.find("alpha-1")).map((session) => session.id)).toEqual(["alpha-1"]);
        expect((await store.find("alpha-")).map((session) => session.id).sort()).toEqual(["alpha-1", "alpha-2"]);
        expect(await store.find("missing")).toEqual([]);
    });

    test("returns null for an unknown id and rejects path traversal", async () => {
        const { store } = await createStore("/store-missing");
        expect(await store.read("nope")).toBeNull();
        await expect(store.read("../escape")).rejects.toThrow("Invalid session id");
    });

    test("skips corrupt files and reports them", async () => {
        const { store, fs, warnings } = await createStore("/store-corrupt");
        await store.create(sessionInput("good"));
        await fs.writeText("/store-corrupt/sessions/broken.json", "{not json");
        await fs.writeText("/store-corrupt/sessions/invalid.json", JSON.stringify({ version: 1 }));

        const sessions = await store.list();
        expect(sessions.map((session) => session.id)).toEqual(["good"]);
        expect(warnings).toHaveLength(2);
    });

    test("deletes and clears sessions", async () => {
        const { store } = await createStore("/store-delete");
        await store.create(sessionInput("one"));
        await store.create(sessionInput("two"));

        expect(await store.delete("one")).toBe(true);
        expect(await store.delete("one")).toBe(false);
        expect((await store.list()).map((session) => session.id)).toEqual(["two"]);
        expect(await store.clear()).toEqual(["two"]);
        expect(await store.list()).toEqual([]);
    });
});

describe("session helpers", () => {
    test("stripReasoning keeps text but drops reasoning parts", () => {
        const stripped = stripReasoning(sessionInput().messages.slice(1));
        expect(messageText(stripped[0]!)).toContain("Looks fine");
        expect(messageReasoning(stripped[0]!)).toBe("");
    });
});

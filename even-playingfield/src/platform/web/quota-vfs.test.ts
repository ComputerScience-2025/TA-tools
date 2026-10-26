import { describe, expect, test } from "bun:test";

import { FileTooLargeError, QuotaFileSystem } from "./quota-vfs.ts";
import { createZenFileSystem } from "./zen-vfs.ts";
import type { QuotaEvent } from "./quota-vfs.ts";
import type { QuotaContext } from "./quota-vfs.ts";
import type { StorageSettings, WorkspaceState } from "./web-state.ts";
import type { VirtualFileSystem } from "../types.ts";

type Harness = {
    quota: QuotaFileSystem;
    fs: VirtualFileSystem;
    events: QuotaEvent[];
    workspaces: WorkspaceState[];
    setActive: (path: string | null) => void;
    setSettings: (settings: Partial<StorageSettings>) => void;
    removed: string[];
};

async function createHarness(workspaces: WorkspaceState[], settings?: Partial<StorageSettings>): Promise<Harness> {
    const mount = await createZenFileSystem({ persist: false, root: "/quota-test" });
    const fs = mount.fs;
    const state = {
        settings: { maxFileBytes: 1000, maxTotalBytes: 1000, sourceTtlDays: 7, ...settings } as StorageSettings,
        active: null as string | null,
    };
    const events: QuotaEvent[] = [];
    const removed: string[] = [];
    const list = [...workspaces];

    const context: QuotaContext = {
        settings: () => state.settings,
        workspaces: () => list,
        activeWorkspace: () => state.active,
        removeWorkspace: async (path: string) => {
            removed.push(path);
            await fs.remove(path, { recursive: true });
            const index = list.findIndex((workspace) => workspace.path === path);
            if (index !== -1) {
                list.splice(index, 1);
            }
        },
        onEvent: (event) => {
            events.push(event);
        },
    };

    const quota = new QuotaFileSystem(fs, context);
    await quota.mkdir(quota.root);
    return {
        quota,
        fs,
        events,
        workspaces: list,
        setActive: (path) => {
            state.active = path;
        },
        setSettings: (next) => {
            state.settings = { ...state.settings, ...next };
        },
        removed,
    };
}

function workspace(path: string, lastUsedAt: number, pinned = false): WorkspaceState {
    return { path, label: path, origin: "upload", createdAt: lastUsedAt, lastUsedAt, pinned };
}

describe("QuotaFileSystem", () => {
    test("refuses files above the per-file limit", async () => {
        const h = await createHarness([workspace("/quota-test/ws-1", 1)], { maxFileBytes: 10 });
        await expect(h.quota.writeText("ws-1/big.txt", "x".repeat(11))).rejects.toBeInstanceOf(FileTooLargeError);
        expect(h.events).toEqual([{ type: "rejected", path: "ws-1/big.txt", size: 11, limit: 10 }]);
        // The rejected file was not written.
        expect(await h.fs.exists("ws-1/big.txt")).toBe(false);
    });

    test("counts usage and evicts the oldest unpinned workspace over the cap", async () => {
        const h = await createHarness([
            workspace("/quota-test/ws-old", 1_000),
            workspace("/quota-test/ws-new", 2_000),
        ], { maxFileBytes: 10_000, maxTotalBytes: 1_000 });
        h.setActive("/quota-test/ws-new");

        await h.quota.writeText("ws-old/a.txt", "a".repeat(400));
        await h.quota.writeText("ws-new/b.txt", "b".repeat(400));
        expect(await h.quota.usage()).toBe(800);

        await h.quota.writeText("ws-new/c.txt", "c".repeat(400));

        expect(h.removed).toEqual(["/quota-test/ws-old"]);
        expect(h.events.some((event) => event.type === "evicted" && event.reason === "cap")).toBe(true);
        expect(h.workspaces.map((w) => w.path)).toEqual(["/quota-test/ws-new"]);
        expect(await h.fs.exists("ws-old/a.txt")).toBe(false);
        expect(await h.fs.exists("ws-new/c.txt")).toBe(true);
    });

    test("never evicts the active or a pinned workspace; warns when over the cap", async () => {
        const h = await createHarness([
            workspace("/quota-test/active", 1_000),
            workspace("/quota-test/pinned", 1_000, true),
        ], { maxFileBytes: 10_000, maxTotalBytes: 500 });
        h.setActive("/quota-test/active");

        await h.quota.writeText("active/a.txt", "a".repeat(300));
        await h.quota.writeText("pinned/b.txt", "b".repeat(300));

        expect(h.removed).toEqual([]);
        const overCap = h.events.filter((event) => event.type === "over-cap");
        expect(overCap).toHaveLength(1);
        expect(overCap[0]).toMatchObject({ usage: 600, limit: 500 });
        expect(await h.fs.exists("active/a.txt")).toBe(true);
        expect(await h.fs.exists("pinned/b.txt")).toBe(true);
    });

    test("cleanupExpired removes only stale, unpinned, inactive workspaces", async () => {
        const day = 24 * 60 * 60 * 1000;
        const now = 10 * day;
        const h = await createHarness([
            { ...workspace("/quota-test/stale", now - 8 * day) },
            { ...workspace("/quota-test/fresh", now - 1 * day) },
            { ...workspace("/quota-test/stale-pinned", now - 8 * day, true) },
            { ...workspace("/quota-test/stale-active", now - 8 * day) },
        ]);
        h.setActive("/quota-test/stale-active");

        const events = await h.quota.cleanupExpired(now);

        expect(h.removed).toEqual(["/quota-test/stale"]);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ type: "evicted", reason: "ttl", bytes: 0 });
        expect(h.workspaces.map((w) => w.path)).toEqual([
            "/quota-test/fresh",
            "/quota-test/stale-pinned",
            "/quota-test/stale-active",
        ]);
    });

    test("remove() forces a re-measure on the next usage() call", async () => {
        const h = await createHarness([workspace("/quota-test/ws", 1)]);
        await h.quota.writeText("ws/a.txt", "a".repeat(100));
        expect(await h.quota.usage()).toBe(100);
        await h.quota.remove("ws/a.txt");
        expect(await h.quota.usage()).toBe(0);
    });

    test("overwriting a file counts its size once", async () => {
        const h = await createHarness([workspace("/quota-test/ws", 1)]);
        await h.quota.writeText("ws/a.txt", "a".repeat(300));
        expect(await h.quota.usage()).toBe(300);

        await h.quota.writeText("ws/a.txt", "b".repeat(300));
        await h.quota.writeText("ws/a.txt", "c".repeat(300));
        expect(await h.quota.usage()).toBe(300);

        // Shrinking the file must free the bytes it no longer occupies.
        await h.quota.writeText("ws/a.txt", "d".repeat(100));
        expect(await h.quota.usage()).toBe(100);
        expect(await h.quota.usage()).toBe(100);
    });

    test("a workspace under the cap survives repeated overwrites", async () => {
        const h = await createHarness([
            workspace("/quota-test/ws-old", 1_000),
            workspace("/quota-test/ws-new", 2_000),
        ], { maxFileBytes: 10_000, maxTotalBytes: 1_000 });
        h.setActive("/quota-test/ws-new");

        await h.quota.writeText("ws-old/a.txt", "a".repeat(300));
        await h.quota.writeText("ws-old/a.txt", "b".repeat(300));
        await h.quota.writeText("ws-old/a.txt", "c".repeat(300));

        expect(await h.quota.usage()).toBe(300);
        expect(h.removed).toEqual([]);
        expect(await h.fs.exists("ws-old/a.txt")).toBe(true);
    });
});

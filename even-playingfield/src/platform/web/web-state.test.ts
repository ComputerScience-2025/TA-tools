import { describe, expect, test } from "bun:test";

import { DEFAULT_STORAGE_SETTINGS, WEB_STATE_KEY, WebStateStore, createMemoryStorage } from "./web-state.ts";

describe("WebStateStore", () => {
    test("starts from defaults when nothing is stored", () => {
        const store = new WebStateStore(createMemoryStorage());
        expect(store.get().activeWorkspace).toBeNull();
        expect(store.listWorkspaces()).toEqual([]);
        expect(store.getStorageSettings()).toEqual(DEFAULT_STORAGE_SETTINGS);
    });

    test("round-trips through storage", () => {
        const storage = createMemoryStorage();
        const first = new WebStateStore(storage);
        first.upsertWorkspace({
            path: "/epf/workspaces/ws-1",
            label: "owner/repo@main",
            origin: "github",
            createdAt: 1,
            lastUsedAt: 2,
            pinned: false,
        });
        first.setActiveWorkspace("/epf/workspaces/ws-1");
        first.setStorageSettings({ maxTotalBytes: 4096 });
        first.appendConsoleHistory("list");
        first.saveNow();

        const second = new WebStateStore(storage);
        expect(second.get().activeWorkspace).toBe("/epf/workspaces/ws-1");
        expect(second.listWorkspaces()).toHaveLength(1);
        expect(second.getStorageSettings().maxTotalBytes).toBe(4096);
        expect(second.getConsoleHistory()).toEqual(["list"]);
    });

    test("keeps defaults when the stored blob is corrupt or partial", () => {
        const corrupt = new WebStateStore(createMemoryStorage({ [WEB_STATE_KEY]: "{not json" }));
        expect(corrupt.getStorageSettings()).toEqual(DEFAULT_STORAGE_SETTINGS);

        const partial = new WebStateStore(createMemoryStorage({
            [WEB_STATE_KEY]: JSON.stringify({ version: 1, workspaces: [{ path: "/w", label: "w" }] }),
        }));
        expect(partial.listWorkspaces()[0]?.origin).toBe("empty");
        expect(partial.getStorageSettings().maxFileBytes).toBe(DEFAULT_STORAGE_SETTINGS.maxFileBytes);
    });

    test("pinning, touching and removal update the workspace index", () => {
        const store = new WebStateStore(createMemoryStorage());
        store.upsertWorkspace({
            path: "/w/one",
            label: "one",
            origin: "upload",
            createdAt: 1,
            lastUsedAt: 1,
            pinned: false,
        });
        store.upsertWorkspace({
            path: "/w/two",
            label: "two",
            origin: "upload",
            createdAt: 2,
            lastUsedAt: 2,
            pinned: false,
        });

        store.setPinned("/w/one", true);
        expect(store.getWorkspace("/w/one")?.pinned).toBe(true);

        store.setActiveWorkspace("/w/two");
        store.touchWorkspace("/w/two");
        expect(store.get().workspaces.find((w) => w.path === "/w/two")?.lastUsedAt).toBeGreaterThanOrEqual(2);

        store.removeWorkspace("/w/two");
        expect(store.listWorkspaces().map((w) => w.path)).toEqual(["/w/one"]);
        // Removing the active workspace falls back to a remaining one.
        expect(store.get().activeWorkspace).toBe("/w/one");
    });

    test("console history is capped and de-duplicated", () => {
        const store = new WebStateStore(createMemoryStorage());
        store.appendConsoleHistory("run");
        store.appendConsoleHistory("list");
        store.appendConsoleHistory("run");
        expect(store.getConsoleHistory()).toEqual(["list", "run"]);

        for (let i = 0; i < 150; i++) {
            store.appendConsoleHistory(`command-${i}`);
        }
        expect(store.getConsoleHistory()).toHaveLength(100);
    });
});

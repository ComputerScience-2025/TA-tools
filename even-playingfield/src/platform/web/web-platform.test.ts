import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryStorage } from "./web-state.ts";
import { createWebPlatform } from "./web-platform.ts";

async function createTestPlatform() {
    return await createWebPlatform({
        persist: false,
        skipSessionLock: true,
        storage: createMemoryStorage(),
        root: "/platform-test",
    });
}

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

/** Replace `navigator.locks` so `ifAvailable` locks can be made to fail. */
function stubLocks(available: boolean): void {
    const locks = {
        request: async (
            _name: string,
            _options: unknown,
            callback: (lock: unknown) => Promise<void>,
        ): Promise<unknown> => {
            void callback(available ? {} : null);
            return undefined;
        },
    };
    Object.defineProperty(globalThis, "navigator", { value: { locks }, configurable: true, writable: true });
}

afterEach(() => {
    if (originalNavigator !== undefined) {
        Object.defineProperty(globalThis, "navigator", originalNavigator);
    }
});

describe("createWebPlatform", () => {
    test("assembles a working filesystem, env, logger and TOML parser", async () => {
        const web = await createTestPlatform();

        expect(web.persistent).toBe(false);
        expect(web.soleOwner).toBe(true);
        expect(web.platform.fs).toBe(web.fs);
        expect(web.platform.homeDir).toBeUndefined();

        await web.fs.writeText("workspaces/ws-1/src/a.cs", "class A {}");
        expect(await web.fs.readText("workspaces/ws-1/src/a.cs")).toBe("class A {}");
        expect(await web.fs.exists("/platform-test/workspaces/ws-1/src/a.cs")).toBe(true);

        web.env.set("EPF_DOWNLOAD_GITHUB_PAT", "token");
        expect(web.platform.env.get("EPF_DOWNLOAD_GITHUB_PAT")).toBe("token");

        const parsed = web.platform.toml.parse('version = 5\n[llm]\nproviders = {}\n');
        expect(parsed).toEqual({ version: 5, llm: { providers: {} } });
    });

    test("logs to the buffer and keeps a bounded history", async () => {
        const web = await createTestPlatform();
        const seen: string[] = [];
        const unsubscribe = web.logs.subscribe((entry) => {
            seen.push(entry.message);
        });

        web.platform.logger.log("info", "first", { slug: "s1", data: ["extra"] });
        web.platform.logger.log("warn", "second");

        const entries = web.logs.getEntries();
        expect(entries.map((entry) => entry.message)).toEqual(["first", "second"]);
        expect(entries[0]?.slug).toBe("s1");
        expect(entries[0]?.detail).toBe("extra");
        expect(seen).toEqual(["first", "second"]);

        unsubscribe();
        web.logs.clear();
        expect(web.logs.getEntries()).toEqual([]);
    });

    test("reports the browser shell as unavailable", async () => {
        const web = await createTestPlatform();
        expect(web.platform.shell.available).toBe(false);
        await expect(web.platform.shell.run("echo hi", { cwd: "." })).rejects.toThrow(/not available/);
    });

    test("quota enforcement uses the state's storage settings", async () => {
        const web = await createTestPlatform();
        web.state.setStorageSettings({ maxFileBytes: 5 });
        web.state.saveNow();

        await expect(web.fs.writeText("workspaces/ws/big.txt", "123456")).rejects.toThrow(/per-file limit/);
        expect(web.logs.getEntries().some((entry) => entry.message.includes("per-file limit"))).toBe(true);
    });

    test("a tab that cannot take the storage lock neither persists nor writes", async () => {
        // No IndexedDB is available under test, so an unowned mount can only be
        // memory; the point is that the second tab is kept off the shared store.
        const storage = createMemoryStorage();
        stubLocks(false);
        const web = await createWebPlatform({ storage, root: "/lock-test" });

        expect(web.soleOwner).toBe(false);
        expect(web.persistent).toBe(false);
        expect(web.logs.getEntries().some((entry) => entry.message.includes("Another EPF tab"))).toBe(true);

        web.state.saveNow();
        web.env.set("EPF_DOWNLOAD_GITHUB_PAT", "session-only", { persist: true });
        expect(storage.getItem("epf.platform")).toBeNull();
        expect(storage.getItem("epf.env")).toBeNull();
    });

    test("a read-only session reads the layout but leaves storage alone", async () => {
        const storage = createMemoryStorage();
        const writer = await createWebPlatform({
            persist: false,
            skipSessionLock: true,
            storage,
            root: "/ro-test",
        });
        writer.state.setActiveWorkspace("/ro-test/workspaces/ws-a");
        const writtenBlob = storage.getItem("epf.platform");
        expect(writtenBlob).toContain("/ro-test/workspaces/ws-a");

        const viewer = await createWebPlatform({
            persist: false,
            skipSessionLock: true,
            storage,
            root: "/ro-test",
            access: "read-only",
        });

        expect(viewer.readOnly).toBe(true);
        expect(viewer.state.get().activeWorkspace).toBe("/ro-test/workspaces/ws-a");
        viewer.state.update((state) => {
            state.activeWorkspace = "/ro-test/workspaces/hacked";
        }, { immediate: true });
        viewer.state.saveNow();
        viewer.env.set("EPF_DOWNLOAD_GITHUB_PAT", "session-secret", { persist: true });

        expect(storage.getItem("epf.platform")).toBe(writtenBlob);
        expect(storage.getItem("epf.env")).toBeNull();
        // The value is still usable for this tab, matching the session-only default.
        expect(viewer.env.get("EPF_DOWNLOAD_GITHUB_PAT")).toBe("session-secret");
    });
});

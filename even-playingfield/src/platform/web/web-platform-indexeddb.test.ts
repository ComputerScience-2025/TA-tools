/**
 * The multi-tab contract, exercised against the real IndexedDB backend.
 *
 * A tab that cannot take the storage lock must still mount the persisted store
 * read-only: replacing it with an empty in-memory filesystem made every saved
 * file (configs, outputs, chat transcripts) look deleted, and the reads failed
 * with ENOENT instead of an explanation.
 */

import "fake-indexeddb/auto";

import { afterEach, describe, expect, test } from "bun:test";

import { createMemoryStorage } from "./web-state.ts";
import { createWebPlatform } from "./web-platform.ts";

const originalNavigator = Object.getOwnPropertyDescriptor(globalThis, "navigator");

/** Replace `navigator.locks` so `ifAvailable` locks can be made to fail. */
function stubLocks(available: boolean): void {
    Object.defineProperty(globalThis, "navigator", {
        value: {
            locks: {
                request: async (
                    _name: string,
                    _options: unknown,
                    callback: (lock: unknown) => Promise<void>,
                ): Promise<unknown> => {
                    void callback(available ? {} : null);
                    return undefined;
                },
            },
        },
        configurable: true,
        writable: true,
    });
}

function restoreNavigator(): void {
    if (originalNavigator !== undefined) {
        Object.defineProperty(globalThis, "navigator", originalNavigator);
    }
}

afterEach(restoreNavigator);

describe("createWebPlatform with IndexedDB", () => {
    test("a tab without the storage lock reads the saved files but cannot write", async () => {
        const storeName = `epf-locks-${Date.now()}`;
        const storage = createMemoryStorage();
        const root = "/lock-idb";

        const owner = await createWebPlatform({ persist: true, skipSessionLock: true, storage, root, storeName });
        expect(owner.soleOwner).toBe(true);
        expect(owner.writeBlockedBy).toBeNull();
        await owner.fs.writeText("workspaces/ws/src/a.cs", "class A {}");
        await owner.fs.writeText("/lock-idb/home/P3.toml", "# config\n");

        stubLocks(false);
        const second = await createWebPlatform({ persist: true, storage, root, storeName });
        restoreNavigator();

        // The saved data is visible instead of an empty memory filesystem.
        expect(second.soleOwner).toBe(false);
        expect(second.readOnly).toBe(true);
        expect(second.writeBlockedBy).toBe("another-tab");
        expect(second.persistent).toBe(true);
        expect(await second.fs.readText("workspaces/ws/src/a.cs")).toBe("class A {}");
        expect(await second.fs.readText("/lock-idb/home/P3.toml")).toBe("# config\n");

        // Nothing in this tab may change the shared store.
        await expect(second.fs.writeText("workspaces/ws/src/a.cs", "class B {}")).rejects.toThrow(/read-only/);
        await expect(second.fs.remove("workspaces/ws", { recursive: true })).rejects.toThrow(/read-only/);
        expect(await owner.fs.readText("workspaces/ws/src/a.cs")).toBe("class A {}");
    });
});

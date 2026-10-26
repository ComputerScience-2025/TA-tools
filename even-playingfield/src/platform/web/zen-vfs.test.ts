import { describe, expect, test } from "bun:test";

import { describeVfsContract } from "../vfs-contract.ts";
import { createZenFileSystem } from "./zen-vfs.ts";

describeVfsContract("ZenFileSystem (InMemory)", async () => {
    // Re-configuring the mount gives every test a fresh tree.
    const mount = await createZenFileSystem({ persist: false, root: "/contract" });
    return {
        fs: mount.fs,
        cleanup: async () => {
            // Nothing to do: the next fixture starts from a new InMemory store.
        },
    };
});

describe("ZenFileSystem mount options", () => {
    test("reports memory-only when persistence is not requested", async () => {
        const mount = await createZenFileSystem({ persist: false, root: "/memory-only" });
        expect(mount.persistent).toBe(false);
        expect(mount.root).toBe("/memory-only");
    });

    test("keeps files inside the configured root", async () => {
        const mount = await createZenFileSystem({ persist: false, root: "/scoped" });
        await mount.fs.writeText("inside.txt", "x");
        expect(await mount.fs.exists("/scoped/inside.txt")).toBe(true);
    });
});

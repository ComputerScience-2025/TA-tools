/**
 * Exercised against the real IndexedDB backend using `fake-indexeddb`, which
 * implements the parts of the IDB API ZenFS relies on. Keeping this in its own
 * file avoids leaking the fake `indexedDB` global into the other web tests.
 */

import "fake-indexeddb/auto";

import { describe, expect, test } from "bun:test";

import { createZenFileSystem } from "./zen-vfs.ts";

describe("ZenFileSystem with the IndexedDB backend", () => {
    test("reports persistence and survives a remount", async () => {
        const storeName = `epf-test-${Date.now()}`;

        const first = await createZenFileSystem({ persist: true, root: "/persist", storeName });
        expect(first.persistent).toBe(true);
        await first.fs.writeText("src/a.cs", "class A {}");
        await first.fs.writeText("src/nested/b.cs", "class B {}");
        const written = await first.fs.stat("src/a.cs");
        expect(written?.size).toBe("class A {}".length);

        // A second mount over the same store (a page reload in the browser)
        // must see the files written by the first one.
        const second = await createZenFileSystem({ persist: true, root: "/persist", storeName });
        expect(await second.fs.readText("src/a.cs")).toBe("class A {}");
        expect(await second.fs.readText("src/nested/b.cs")).toBe("class B {}");

        await second.fs.remove("src", { recursive: true });
        expect(await second.fs.exists("src/a.cs")).toBe(false);
    });
});

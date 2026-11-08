import { describe, expect, test } from "bun:test";

import { WebEnvProvider } from "./web-env.ts";
import { createMemoryStorage } from "./web-state.ts";

describe("WebEnvProvider", () => {
    test("values round-trip through storage", () => {
        const storage = createMemoryStorage();
        const first = new WebEnvProvider(storage);
        first.set("EPF_DOWNLOAD_GITHUB_PAT", "token-value");
        expect(first.get("EPF_DOWNLOAD_GITHUB_PAT")).toBe("token-value");

        const second = new WebEnvProvider(storage);
        expect(second.get("EPF_DOWNLOAD_GITHUB_PAT")).toBe("token-value");
    });

    test("clear removes the value and all() lists the rest", () => {
        const storage = createMemoryStorage();
        const env = new WebEnvProvider(storage);
        env.set("A", "1");
        env.set("B", "2");
        expect(env.all()).toEqual({ A: "1", B: "2" });

        env.clear("A");
        expect(env.get("A")).toBeUndefined();
        expect(env.all()).toEqual({ B: "2" });
    });

    test("an empty value removes the key", () => {
        const storage = createMemoryStorage();
        const env = new WebEnvProvider(storage);
        env.set("A", "1");
        env.set("A", "");
        expect(env.get("A")).toBeUndefined();
        expect(storage.getItem("epf.env")).toBe("{}");
    });

    test("survives a corrupt stored blob", () => {
        const env = new WebEnvProvider(createMemoryStorage({ "epf.env": "not json" }));
        expect(env.all()).toEqual({});
        env.set("A", "1");
        expect(env.get("A")).toBe("1");
    });

    test("a read-only provider keeps values for the session without storing them", () => {
        const storage = createMemoryStorage({ "epf.env": "{}" });
        const env = new WebEnvProvider(storage, "epf.env", { persist: false });
        env.set("EPF_DOWNLOAD_GITHUB_PAT", "session-only");
        expect(env.get("EPF_DOWNLOAD_GITHUB_PAT")).toBe("session-only");
        expect(storage.getItem("epf.env")).toBe("{}");
    });
});

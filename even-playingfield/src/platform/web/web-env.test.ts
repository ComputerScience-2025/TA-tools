import { describe, expect, test } from "bun:test";

import { WebEnvProvider } from "./web-env.ts";
import { createMemoryStorage } from "./web-state.ts";

describe("WebEnvProvider", () => {
    test("session values are not written to storage", () => {
        const storage = createMemoryStorage();
        const env = new WebEnvProvider(storage);
        env.set("EPF_DOWNLOAD_GITHUB_PAT", "secret-value");
        expect(env.get("EPF_DOWNLOAD_GITHUB_PAT")).toBe("secret-value");
        expect(storage.getItem("epf.env")).toBe("{}");
        expect(env.persistedNames()).toEqual([]);
    });

    test("remembered values round-trip; unremembered values win for the session", () => {
        const storage = createMemoryStorage();
        const first = new WebEnvProvider(storage);
        first.set("EPF_CONFIG_URL", "https://example.test/epf.toml", { persist: true });
        expect(first.persistedNames()).toEqual(["EPF_CONFIG_URL"]);

        const second = new WebEnvProvider(storage);
        expect(second.get("EPF_CONFIG_URL")).toBe("https://example.test/epf.toml");

        // Switching a value to session-only removes the stored copy.
        second.set("EPF_CONFIG_URL", "https://session.test/epf.toml", { persist: false });
        expect(second.get("EPF_CONFIG_URL")).toBe("https://session.test/epf.toml");
        const third = new WebEnvProvider(storage);
        expect(third.get("EPF_CONFIG_URL")).toBeUndefined();
    });

    test("clear removes both copies and all() merges the layers", () => {
        const storage = createMemoryStorage();
        const env = new WebEnvProvider(storage);
        env.set("A", "persisted", { persist: true });
        env.set("B", "session");
        expect(env.all()).toEqual({ A: "persisted", B: "session" });
        env.clear("A");
        expect(env.get("A")).toBeUndefined();
        expect(env.all()).toEqual({ B: "session" });
    });

    test("survives a corrupt stored blob", () => {
        const env = new WebEnvProvider(createMemoryStorage({ "epf.env": "not json" }));
        expect(env.all()).toEqual({});
        env.set("A", "1");
        expect(env.get("A")).toBe("1");
    });

    test("clearPersisted forgets stored secrets but keeps them for the session", () => {
        const storage = createMemoryStorage();
        const env = new WebEnvProvider(storage);
        env.set("EPF_DOWNLOAD_GITHUB_PAT", "ghp_secret", { persist: true });
        env.set("EPF_CONFIG_URL", "https://example.test/epf.toml", { persist: true });

        env.clearPersisted(["EPF_DOWNLOAD_GITHUB_PAT"]);

        expect(env.persistedNames()).toEqual(["EPF_CONFIG_URL"]);
        expect(storage.getItem("epf.env")).not.toContain("ghp_secret");
        expect(env.get("EPF_DOWNLOAD_GITHUB_PAT")).toBe("ghp_secret");

        // Without names, everything remembered is forgotten.
        env.clearPersisted();
        expect(env.persistedNames()).toEqual([]);
        expect(storage.getItem("epf.env")).toBe("{}");
    });

    test("a read-only provider keeps values for the session without storing them", () => {
        const storage = createMemoryStorage({ "epf.env": "{}" });
        const env = new WebEnvProvider(storage, "epf.env", { persist: false });
        env.set("EPF_DOWNLOAD_GITHUB_PAT", "session-only", { persist: true });
        expect(env.get("EPF_DOWNLOAD_GITHUB_PAT")).toBe("session-only");
        expect(storage.getItem("epf.env")).toBe("{}");
    });
});

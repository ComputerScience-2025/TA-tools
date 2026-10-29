import { describe, expect, test } from "bun:test";

import { parse as parseToml } from "smol-toml";

import {
    addRecordEntry,
    appendArrayItem,
    canonicalizeConfigDocument,
    createDefaultDocument,
    deleteArrayItem,
    deleteRecordEntry,
    getAtPath,
    getRecordAt,
    hasAtPath,
    migrateConfigDocument,
    modelKeyReferences,
    moveArrayItem,
    moveRecordEntry,
    parseConfigDocument,
    providerKeyReferences,
    renameModelKey,
    renameProviderKey,
    renameRecordEntry,
    serializeConfigDocument,
    setAtPath,
    uniqueKey,
    validateConfigDocument,
    deleteAtPath,
} from "./config-object.ts";
import type { TomlCodec } from "../platform/types.ts";

const TOML: TomlCodec = {
    parse(text: string): Record<string, unknown> {
        return parseToml(text) as Record<string, unknown>;
    },
};

const V4_CONFIG = `[vendors.openrouter]
api_key = "test-key"

[output_viewing]
mode = "webui"
api_port = 0
webui_base_url = "https://example.test"

[llm.models.general_analysis]
sdk = "openrouter"
model_name = "mock-model"

[llm.prompt_replacement]
role = "grader"

[[analysis_workflows]]
slug = "demo"
model = "general_analysis"
output_filename = "[slug].epf.md"
prompt = "Review it."
`;

describe("config documents", () => {
    test("parses current-version TOML without validating it", () => {
        const result = parseConfigDocument("version = 5\n", TOML);
        expect(result.ok).toBe(true);
        if (result.ok) {
            expect(result.document.version).toBe(5);
            expect(result.document.raw["version"]).toBe(5);
        }
    });

    test("reports TOML syntax errors", () => {
        const result = parseConfigDocument("this is not toml", TOML);
        expect(result.ok).toBe(false);
    });

    test("migrates v4 providers and model references", () => {
        const parsed = parseConfigDocument(V4_CONFIG, TOML);
        expect(parsed.ok).toBe(true);
        if (!parsed.ok) {
            return;
        }
        const migrated = migrateConfigDocument(parsed.document.raw);
        expect(migrated.fromVersion).toBe(4);
        expect(migrated.steps.map((step) => step.to)).toEqual([5]);
        expect(getAtPath(migrated.raw, ["version"])).toBe(5);
        expect(getAtPath(migrated.raw, ["llm", "providers", "openrouter", "api_key"])).toBe("test-key");
        expect(getAtPath(migrated.raw, ["llm", "models", "general_analysis", "provider"])).toBe("openrouter");
        expect(validateConfigDocument(migrated.raw, "migrated").ok).toBe(true);
    });

    test("serializes in a stable field order and keeps multiline prompts", () => {
        const raw = createDefaultDocument();
        setAtPath(raw, ["analysis_workflows", 0, "prompt"], "line one\nline two");
        const text = serializeConfigDocument(raw);
        expect(text.startsWith("version = 5\n")).toBe(true);
        expect(text).toContain('prompt = """line one\nline two"""');
        expect(text.indexOf("[output_viewing]")).toBeLessThan(text.indexOf("[llm.providers"));
    });

    test("preserves unknown fields", () => {
        const raw = createDefaultDocument();
        raw["future_section"] = { enabled: true };
        const canonical = canonicalizeConfigDocument(raw);
        expect(canonical["future_section"]).toEqual({ enabled: true });
        expect(serializeConfigDocument(raw)).toContain("[future_section]");
    });

    test("creates a valid default document without a seed", () => {
        const raw = createDefaultDocument();
        expect(validateConfigDocument(raw, "default").ok).toBe(true);
        const model = getRecordAt(raw, ["llm", "models", "general_analysis"]);
        expect(model).not.toBeNull();
        expect(model?.["seed"]).toBeUndefined();
    });
});

describe("path operations", () => {
    test("sets, checks and deletes nested values", () => {
        const raw = createDefaultDocument();
        setAtPath(raw, ["output_viewing", "api_port"], 1234);
        expect(hasAtPath(raw, ["output_viewing", "api_port"])).toBe(true);
        expect(getAtPath(raw, ["output_viewing", "api_port"])).toBe(1234);
        deleteAtPath(raw, ["output_viewing", "api_port"]);
        expect(hasAtPath(raw, ["output_viewing", "api_port"])).toBe(false);
    });

    test("creates missing parent objects when setting a field", () => {
        const raw: Record<string, unknown> = {};
        setAtPath(raw, ["llm", "models", "demo", "temperature"], 0.2);
        expect(getAtPath(raw, ["llm", "models", "demo", "temperature"])).toBe(0.2);
    });

    test("adds, moves and deletes array items", () => {
        const raw = createDefaultDocument();
        appendArrayItem(raw, ["analysis_workflows"], { slug: "second" });
        expect((getAtPath(raw, ["analysis_workflows"]) as unknown[]).length).toBe(2);
        moveArrayItem(raw, ["analysis_workflows"], 1, 0);
        expect(getAtPath(raw, ["analysis_workflows", 0, "slug"])).toBe("second");
        deleteArrayItem(raw, ["analysis_workflows"], 0);
        expect((getAtPath(raw, ["analysis_workflows"]) as unknown[]).length).toBe(1);
    });

    test("adds, reorders and renames record entries", () => {
        const raw = createDefaultDocument();
        addRecordEntry(raw, ["llm", "providers"], "test", { sdk: "openai" });
        moveRecordEntry(raw, ["llm", "providers"], "test", -1);
        const keys = Object.keys(getRecordAt(raw, ["llm", "providers"]) ?? {});
        expect(keys.indexOf("test")).toBeLessThan(keys.indexOf("google"));
        renameRecordEntry(raw, ["llm", "providers"], "test", "renamed");
        expect(getRecordAt(raw, ["llm", "providers"])?.["renamed"]).toEqual({ sdk: "openai" });
        deleteRecordEntry(raw, ["llm", "providers"], "renamed");
        expect(getRecordAt(raw, ["llm", "providers"])?.["renamed"]).toBeUndefined();
    });

    test("builds unique keys", () => {
        expect(uniqueKey(["demo"], "demo")).toBe("demo_2");
        expect(uniqueKey(["demo", "demo_2"], "demo")).toBe("demo_3");
        expect(uniqueKey([], "demo")).toBe("demo");
    });
});

describe("reference-aware renames", () => {
    test("renaming a provider updates model references", () => {
        const raw = createDefaultDocument();
        expect(providerKeyReferences(raw, "openrouter")).toEqual(["general_analysis", "output_comparison"]);
        renameProviderKey(raw, "openrouter", "router");
        expect(getAtPath(raw, ["llm", "providers", "router"])).toBeDefined();
        expect(getAtPath(raw, ["llm", "providers", "openrouter"])).toBeUndefined();
        expect(getAtPath(raw, ["llm", "models", "general_analysis", "provider"])).toBe("router");
        expect(validateConfigDocument(raw, "renamed").ok).toBe(true);
    });

    test("renaming a model updates workflow references", () => {
        const raw = createDefaultDocument();
        expect(modelKeyReferences(raw, "general_analysis").length).toBe(2);
        renameModelKey(raw, "general_analysis", "analysis");
        expect(getAtPath(raw, ["llm", "models", "analysis"])).toBeDefined();
        expect(getAtPath(raw, ["analysis_workflows", 0, "model"])).toBe("analysis");
        expect(getAtPath(raw, ["testing_workflows", 0, "model"])).toBe("analysis");
        expect(validateConfigDocument(raw, "renamed").ok).toBe(true);
    });
});

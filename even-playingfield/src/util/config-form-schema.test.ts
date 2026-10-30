import { describe, expect, test } from "bun:test";

import {
    buildConfigFormDescriptor,
    collectUnknownConfigPaths,
    createValueForDescriptor,
    findDescriptor,
} from "./config-form-schema.ts";
import { createDefaultDocument, getAtPath, setAtPath } from "./config-object.ts";
import type { ConfigFieldDescriptor } from "./config-form-schema.ts";

function root(): ConfigFieldDescriptor {
    const result = buildConfigFormDescriptor();
    expect(result.ok).toBe(true);
    if (!result.ok) {
        throw new Error(result.message);
    }
    return result.descriptor;
}

describe("config form descriptors", () => {
    test("covers every top-level config section", () => {
        const descriptor = root();
        const keys = descriptor.properties?.map((property) => property.key);
        expect(keys).toEqual(["version", "output_viewing", "llm", "analysis_workflows", "testing_workflows"]);
        expect(findDescriptor(descriptor, ["version"])?.hidden).toBe(true);
    });

    test("marks reference, textarea, password and seed widgets", () => {
        const descriptor = root();
        expect(findDescriptor(descriptor, ["llm", "providers", "openrouter", "api_key"])?.widget).toBe("password");
        expect(findDescriptor(descriptor, ["llm", "models", "demo", "provider"])?.widget).toBe("provider-reference");
        expect(findDescriptor(descriptor, ["analysis_workflows", 0, "model"])?.widget).toBe("model-reference");
        expect(findDescriptor(descriptor, ["analysis_workflows", 0, "prompt"])?.widget).toBe("textarea");
        expect(findDescriptor(descriptor, ["llm", "prompt_replacement", "base_role"])?.widget).toBe("textarea");
        const seed = findDescriptor(descriptor, ["llm", "models", "demo", "seed"]);
        expect(seed?.widget).toBe("seed");
        expect(seed?.hasDefault).toBe(false);
    });

    test("describes records and nested arrays", () => {
        const descriptor = root();
        const providers = findDescriptor(descriptor, ["llm", "providers"]);
        expect(providers?.kind).toBe("record");
        expect(providers?.additional?.kind).toBe("object");
        const testCases = findDescriptor(descriptor, ["testing_workflows", 0, "test_cases"]);
        expect(testCases?.kind).toBe("array");
        expect(testCases?.items?.kind).toBe("object");
        const expected = findDescriptor(
            descriptor,
            ["testing_workflows", 0, "test_cases", 0, "single_run_expected_output"],
        );
        expect(expected?.properties?.map((property) => property.key)).toContain("llm_judge_prompt");
    });

    test("creates complete values for new entries", () => {
        const descriptor = root();
        const provider = createValueForDescriptor(findDescriptor(descriptor, ["llm", "providers", "x"])!);
        expect(provider).toMatchObject({ sdk: "openai", endpoint: "", api_key: "", headers: {} });
        const workflow = createValueForDescriptor(
            findDescriptor(descriptor, ["analysis_workflows", 0])!,
        ) as Record<string, unknown>;
        expect(workflow["slug"]).toBe("");
        expect(workflow["model"]).toBe("general_analysis");
        expect(workflow["runs"]).toBe(1);
        expect(Array.isArray(workflow["input_files_searches"])).toBe(true);
    });

    test("reports unknown paths without dropping them", () => {
        const descriptor = root();
        const raw = createDefaultDocument();
        setAtPath(raw, ["future_flag"], true);
        setAtPath(raw, ["llm", "models", "general_analysis", "future_model_field"], 42);
        expect(getAtPath(raw, ["future_flag"])).toBe(true);
        const unknown = collectUnknownConfigPaths(raw, descriptor);
        expect(unknown).toContain("future_flag");
        expect(unknown).toContain("llm.models.general_analysis.future_model_field");
    });
});

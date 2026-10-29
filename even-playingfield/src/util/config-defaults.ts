/**
 * Default config values shared by the CLI's `config-gen` script and the
 * browser's interactive config editor.
 *
 * Keeping the defaults here means `epf.example.toml` and a config created in
 * the dashboard cannot drift apart. `seed` is deliberately omitted from new
 * models: a config that leaves it out gets a fresh timestamp on every run
 * (see `ModelConfigSchema`).
 */

import { getDefaultsForSchema } from "zod-defaults";
import type { z } from "zod";

import {
    AnalysisWorkflowEntrySchema,
    CURRENT_CONFIG_VERSION,
    FileSearchEntrySchema,
    ModelConfigSchema,
    OutputViewingConfigSchema,
    ProviderConfigSchema,
    ProviderSDKEnum,
    TestCaseSchema,
    TestingWorkflowEntrySchema,
} from "./config-schema.ts";
import type {
    AnalysisWorkflow,
    ModelConfig,
    OutputViewingConfig,
    ProviderConfig,
    TestingWorkflow,
} from "./config-schema.ts";

export type DefaultModelConfig = Omit<ModelConfig, "seed"> & { seed?: number };
export type ConfigDocumentObject = Record<string, unknown>;
export type FileSearchEntryConfig = z.infer<typeof FileSearchEntrySchema>;
export type TestCaseConfig = z.infer<typeof TestCaseSchema>;

/** Provider defaults, with the SDK/endpoint chosen by the caller. */
export function createDefaultProvider(sdk: ProviderSDKEnum, endpoint = ""): ProviderConfig {
    const provider = getDefaultsForSchema(ProviderConfigSchema) as ProviderConfig;
    provider.sdk = sdk;
    provider.endpoint = endpoint;
    provider.api_key = "";
    provider.headers = {};
    return provider;
}

/** Model defaults. `seed` is intentionally absent. */
export function createDefaultModel(provider = "openrouter"): DefaultModelConfig {
    const model = getDefaultsForSchema(ModelConfigSchema) as DefaultModelConfig;
    delete model.seed;
    model.provider = provider;
    return model;
}

/** A file search entry that is valid for a typical source-code submission. */
export function createDefaultFileSearch(): FileSearchEntryConfig {
    const search = getDefaultsForSchema(FileSearchEntrySchema) as FileSearchEntryConfig;
    search.file_glob = "*.{cpp,h}";
    search.search_directory = ".";
    search.excluded_files = [];
    return search;
}

export function createDefaultExpectedOutput(): TestCaseConfig["single_run_expected_output"] {
    const testCase = getDefaultsForSchema(TestCaseSchema) as TestCaseConfig;
    return testCase.single_run_expected_output;
}

export function createDefaultTestCase(): TestCaseConfig {
    const testCase = getDefaultsForSchema(TestCaseSchema) as TestCaseConfig;
    testCase.name = "Test Case 1";
    testCase.work_directory = ".";
    testCase.single_run_command = "";
    testCase.single_run_expected_output = createDefaultExpectedOutput();
    testCase.interactive_steps = [];
    return testCase;
}

export function createDefaultAnalysisWorkflow(): AnalysisWorkflow {
    const workflow = getDefaultsForSchema(AnalysisWorkflowEntrySchema) as AnalysisWorkflow;
    workflow.slug = "EPF-general-analysis-example";
    workflow.model = "general_analysis";
    workflow.runs = 1;
    workflow.output_filename = "general-analysis-example-[seed]-[model].epf.md";
    workflow.input_files_searches = [createDefaultFileSearch()];
    workflow.prompt =
        "Count how many functions and classes are defined in the codebase. \n" +
        "Provide a summary of the number of functions and classes, and list their names.\n";
    return workflow;
}

export function createDefaultTestingWorkflow(): TestingWorkflow {
    const workflow = getDefaultsForSchema(TestingWorkflowEntrySchema) as TestingWorkflow;
    workflow.slug = "EPF-testing-example";
    workflow.model = "general_analysis";
    workflow.runs = 1;
    workflow.output_filename = "testing-example-[seed]-[model].epf.md";
    workflow.setup_commands = [];
    workflow.cleanup_commands = [];
    workflow.test_cases = [createDefaultTestCase()];
    return workflow;
}

export function createDefaultOutputViewing(): OutputViewingConfig {
    return getDefaultsForSchema(OutputViewingConfigSchema) as OutputViewingConfig;
}

/**
 * A complete, valid starting config. Used by `config-gen` and by the editor's
 * "New config" action.
 */
export function createDefaultConfigDocument(): ConfigDocumentObject {
    return {
        version: CURRENT_CONFIG_VERSION,
        output_viewing: createDefaultOutputViewing(),
        llm: {
            providers: {
                openrouter: createDefaultProvider(ProviderSDKEnum.OpenAI, "https://openrouter.ai/api/v1"),
                openai: createDefaultProvider(ProviderSDKEnum.OpenAI),
                anthropic: createDefaultProvider(ProviderSDKEnum.Anthropic),
                google: createDefaultProvider(ProviderSDKEnum.Google),
            },
            models: {
                general_analysis: createDefaultModel("openrouter"),
                output_comparison: { ...createDefaultModel("openrouter"), temperature: 0 },
            },
            prompt_replacement: {
                role: "role_placeholder",
            },
        },
        analysis_workflows: [createDefaultAnalysisWorkflow()],
        testing_workflows: [createDefaultTestingWorkflow()],
    };
}

import { z } from "zod";

export enum OutputViewingModeEnum {
    Local = "local",
    WebUI = "webui",
}

export enum ProviderSDKEnum {
    OpenAI = "openai",
    Anthropic = "anthropic",
    Google = "google",
}

export const OutputViewingConfigSchema = z.object({
    mode: z.enum(OutputViewingModeEnum).default(OutputViewingModeEnum.WebUI),
    api_port: z.number().min(0).max(65535).default(0), // 0 means random available port
    webui_base_url: z.string().default("https://ta-tools-dashboard.vercel.app"),
});

export type OutputViewingConfig = z.infer<typeof OutputViewingConfigSchema>;

export const ProviderConfigSchema = z.object({
    sdk: z.enum(ProviderSDKEnum).default(ProviderSDKEnum.OpenAI),
    endpoint: z.string().default(""),
    // Intentionally required. We pass this explicitly to the Vercel AI SDK
    // so it does not fall back to OPENAI_API_KEY / ANTHROPIC_API_KEY / etc.
    api_key: z.string(),
});

export type ProviderConfig = z.infer<typeof ProviderConfigSchema>;

export const ModelConfigSchema = z.object({
    provider: z.string().default("openrouter"),
    model_name: z.string().default(""),
    seed: z.number().default(() => Math.floor(Date.now() / 1000)),
    max_completion_tokens: z.number().min(1).default(20000),
    temperature: z.number().min(0).max(1).default(0.9),
    top_p: z.number().min(0).max(1).default(1),
    frequency_penalty: z.number().min(-2).max(2).default(0),
    presence_penalty: z.number().min(-2).max(2).default(0),
    reasoning_effort: z.enum(["low", "medium", "high", "xhigh"]).default("high"),
    max_retries: z.number().min(0).default(1),  // 0 for no retry
    retry_delay_ms: z.number().min(0).default(1000),
});

export type ModelConfig = z.infer<typeof ModelConfigSchema>;

export const LLMConfigSchema = z.object({
    providers: z.record(z.string(), ProviderConfigSchema),
    models: z.record(z.string(), ModelConfigSchema),
    prompt_replacement: z.record(z.string(), z.string()),
}).superRefine((data, ctx) => {
    for (const [modelName, model] of Object.entries(data.models)) {
        if (!data.providers[model.provider]) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Model "${modelName}" references unknown provider "${model.provider}"`,
                path: ["models", modelName, "provider"],
            });
        }
    }
});

export type LLMConfig = z.infer<typeof LLMConfigSchema>;

export const FileSearchEntrySchema = z.object({
    file_glob: z.string().min(1),
    search_directory: z.string().default("."),
    excluded_files: z.array(z.string()).default([]),
});

export const BaseWorkflowEntrySchema = z.object({
    slug: z.string(),
    model: z.string().default("general_analysis"),
    runs: z.number().min(1).default(1),
    input_files_searches: z.array(FileSearchEntrySchema).default([]),
    output_filename: z.string().min(1),
});

export const AnalysisWorkflowEntrySchema = BaseWorkflowEntrySchema.extend({
    prompt: z.string(),
})

export type AnalysisWorkflow = z.infer<typeof AnalysisWorkflowEntrySchema>;

export enum LLMJudgeInputModeEnum {
    None = "NONE",
    Diff = "DIFF",
    Full = "FULL",
}
const LLMJudgeInputModeSchema = z.enum(LLMJudgeInputModeEnum);

const ExpectedOutputSchema = z.object({
    prefix_strip_string: z.string().min(0),
    postfix_strip_string: z.string().min(0),
    substring: z.string().min(0),
    llm_judge_input_mode: LLMJudgeInputModeSchema.default(LLMJudgeInputModeEnum.None),
    llm_judge_prompt: z.string().min(0),
});

export const TestCaseSchema = z.object({
    name: z.string(),
    work_directory: z.string().default("."),
    single_run_command: z.string(),
    single_run_expected_output: ExpectedOutputSchema,
    interactive_steps: z.array(z.object({
        input: z.string(),
        expected_output: ExpectedOutputSchema,
    })),
});

export const TestingWorkflowEntrySchema = BaseWorkflowEntrySchema.extend({
    setup_commands: z.array(z.string()).default([]),
    test_cases: z.array(TestCaseSchema).default([]),
    cleanup_commands: z.array(z.string()).default([]),
}).omit({
    input_files_searches: true,
});

export type TestingWorkflow = z.infer<typeof TestingWorkflowEntrySchema>;

export const ConfigSchema = z.object({
    output_viewing: OutputViewingConfigSchema,
    llm: LLMConfigSchema,
    analysis_workflows: z.array(AnalysisWorkflowEntrySchema).default([]),
    testing_workflows: z.array(TestingWorkflowEntrySchema).default([]),
}).superRefine((data, ctx) => {
    for (const [index, workflow] of data.analysis_workflows.entries()) {
        if (!data.llm.models[workflow.model]) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Analysis workflow references unknown model "${workflow.model}"`,
                path: ["analysis_workflows", index, "model"],
            });
        }
    }
    for (const [index, workflow] of data.testing_workflows.entries()) {
        if (!data.llm.models[workflow.model]) {
            ctx.addIssue({
                code: z.ZodIssueCode.custom,
                message: `Testing workflow references unknown model "${workflow.model}"`,
                path: ["testing_workflows", index, "model"],
            });
        }
    }
});

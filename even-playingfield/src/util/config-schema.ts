import {z} from "zod";

export const FileSearchEntrySchema = z.object({
    file_glob: z.string().min(1),
    search_directory: z.string().default("."),
    excluded_files: z.array(z.string()).default([]),
});

export const BaseWorkflowEntrySchema = z.object({
    slug: z.string(),
    runs: z.number().min(1).default(1),
    input_files_searches: z.array(FileSearchEntrySchema).default([]),
    output_filename: z.string().min(1),
});

export const AnalysisWorkflowEntrySchema = BaseWorkflowEntrySchema.extend({
    prompt: z.string(),
})

export enum LLMJudgeInputModeEnum{
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

export const ConfigSchema = z.object({
    openrouter: z.object({
        api_key: z.string(),
        model: z.string(),
    }),
    hyperparameters: z.object({
        max_completion_tokens: z.number().min(1).default(20000),
        temperature: z.number().min(0).max(1).default(0.9),
        top_p: z.number().min(0).max(1).default(1),
        frequency_penalty: z.number().min(-2).max(2).default(0),
        presence_penalty: z.number().min(-2).max(2).default(0),
        reasoning_effort: z.enum(["low", "medium", "high"]).default("high"),
    }),
    analysis_workflows: z.array(AnalysisWorkflowEntrySchema),
    testing_workflows: z.array(TestingWorkflowEntrySchema),
});

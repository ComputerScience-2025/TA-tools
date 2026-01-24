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

export const LLMWorkflowEntrySchema = BaseWorkflowEntrySchema.extend({
    prompt: z.string(),
})

export const TestingWorkflowEntrySchema = BaseWorkflowEntrySchema.extend({

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
    basic_workflows: z.array(LLMWorkflowEntrySchema),
});

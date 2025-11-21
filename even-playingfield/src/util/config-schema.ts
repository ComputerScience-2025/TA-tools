import {z} from "zod";

export const ConfigWorkflowEntrySchema = z.object({
    slug: z.string(),
    search_directory: z.string(),
    file_glob: z.string(),
    excluded_files: z.array(z.string()).default([]),
    prompt: z.string(),
    output_filename: z.string(),
});

export const ConfigSchema = z.object({
    openrouter: z.object({
        api_key: z.string(),
        model: z.string(),
    }),
    hyperparameters: z.object({
        max_completion_tokens: z.number().min(1).max(32000).default(20000),
        temperature: z.number().min(0).max(1).default(0.9),
        top_p: z.number().min(0).max(1).default(1),
        frequency_penalty: z.number().min(-2).max(2).default(0),
        presence_penalty: z.number().min(-2).max(2).default(0),
        reasoning_effort: z.enum(["low", "medium", "high"]).default("high"),
    }),
    basic_workflows: z.array(ConfigWorkflowEntrySchema),
});

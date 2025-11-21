import os from "node:os";
import { readFileSync, existsSync } from "node:fs";

import {z} from "zod";

const homeDir: string = os.homedir();
const configFileName = "epf.toml";

const ConfigSchema = z.object({
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
    prompt: z.object({
        existence_checker: z.string(),
    }),
    basic_workflows: z.array(z.object({
        slug: z.string(),
        search_directory: z.string(),
        file_glob: z.string(),
        excluded_files: z.array(z.string()).default([]),
        prompt: z.string(),
        output_filename: z.string(),
    })),
});
type Config = z.infer<typeof ConfigSchema>;

function getConfig() {
    console.log(`Loading config`);
    let configFilePath;
    if (existsSync(configFileName)) {
        configFilePath = configFileName;
    }
    else if (existsSync(`${homeDir}/${configFileName}`)) {
        configFilePath = `${homeDir}/${configFileName}`;
    }
    else {
        throw new Error(`Config file ${configFileName} not found`);
    }
    
    const configFileContents = readFileSync(configFilePath).toString();
    let obj =  Bun.TOML.parse(configFileContents);
    const parsedConfig = ConfigSchema.safeParse(obj);
    if (!parsedConfig.success) {
        console.error("Config file is invalid:", parsedConfig.error.format());
        throw new Error("Config file is invalid");
    }
    console.log(`Config loaded from ${configFilePath}`);
    return parsedConfig.data as Config;
}

export const CONFIG = getConfig();



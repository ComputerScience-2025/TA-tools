import os from "node:os";
import { readFileSync, existsSync } from "node:fs";

import {z} from "zod";

import {ConfigSchema} from "./config-schema.ts";


const homeDir: string = os.homedir();
const defaultConfigFileName = "epf.toml";
const configURLEnvVar = "EPF_CONFIG_URL";

export type Config = z.infer<typeof ConfigSchema>;

export type ResolvedConfig = {
    config: Config;
    // The path or URL that the config was loaded from, so callers can
    // reload from the same source on subsequent calls.
    path: string;
};

/**
 * Load and validate the config. Resolution order:
 *   1. `configPathOverride` (explicit --config / prior resolved path)
 *   2. `EPF_CONFIG_URL` environment variable
 *   3. `epf.toml` in the current working directory
 *   4. `epf.toml` in the user's home directory
 *
 * Returns the parsed config together with the path it was loaded from.
 * Callers that want to reload from the same source should capture the
 * returned `path` and pass it back in as `configPathOverride`.
 */
export async function readConfig(configPathOverride?: string): Promise<ResolvedConfig> {
    console.log(`Loading config`);

    let configFilePath: string;
    if (configPathOverride && configPathOverride.trim().length > 0) {
        configFilePath = configPathOverride.trim();
        console.log(`Found config from provided path: ${configFilePath}`);
    }
    else if (process.env[configURLEnvVar]) {
        configFilePath = process.env[configURLEnvVar]!;
        console.log(`Found config from environment variable ${configURLEnvVar}`);
    }
    else {
        if (existsSync(defaultConfigFileName)) {
            configFilePath = defaultConfigFileName;
            console.log(`Found config from current directory`);
        }
        else if (existsSync(`${homeDir}/${defaultConfigFileName}`)) {
            configFilePath = `${homeDir}/${defaultConfigFileName}`;
            console.log(`Found config from home directory`);
        }
        else {
            throw new Error(`Config file ${defaultConfigFileName} not found`);
        }
    }
    
    let configFileContents: string;
    if (/^https?:\/\//.test(configFilePath)) {
        console.log(`Fetching config from URL: ${configFilePath}`);
        const configResponse = await fetch(configFilePath);
        if (!configResponse.ok) {
            throw new Error(`Failed to fetch config from URL: ${configFilePath}, status: ${configResponse.status}`);
        }
        configFileContents = await configResponse.text();
    } else {
        console.log(`Loading config from local file: ${configFilePath}`);
        configFileContents = readFileSync(configFilePath).toString();
    }
    
    console.assert(configFileContents.trim().length > 0, "Config file is empty");
    
    let obj =  Bun.TOML.parse(configFileContents);
    const parsedConfig = ConfigSchema.safeParse(obj);
    if (!parsedConfig.success) {
        console.error("Config file is invalid:", parsedConfig.error.format());
        console.log(`Config file contents:\n${configFileContents}`);
        console.log(parsedConfig);
        throw new Error("Config file is invalid");
    }
    console.log(`Config loaded from ${configFilePath}`);
    return { config: parsedConfig.data as Config, path: configFilePath };
}

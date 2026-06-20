import os from "node:os";
import { readFileSync, existsSync } from "node:fs";

import {z} from "zod";

import {ConfigSchema} from "./config-schema.ts";


const homeDir: string = os.homedir();
const defaultConfigFileName = "epf.toml";
const configURLEnvVar = "EPF_CONFIG_URL";

export type Config = z.infer<typeof ConfigSchema>;

// Set exclusively by the host (cli-host / local-api-host) via setConfig()
// after readConfig() resolves the config path. Not auto-initialized so that
// config.ts no longer implicitly depends on CLI args at module-load time.
export let CONFIG: Config;

// Remembers the resolved config path so that subsequent no-arg calls to
// readConfig() (e.g. Engine.reloadConfig) reload from the same source.
let activeConfigPath: string | undefined;

export function setConfig(newConfig: Config): void {
    CONFIG = newConfig;
}

export async function readConfig(configPathOverride?: string) {
    console.log(`Loading config`);

    let configFilePath: string;
    if (configPathOverride && configPathOverride.trim().length > 0) {
        configFilePath = configPathOverride.trim();
        console.log(`Found config from provided path: ${configFilePath}`);
    }
    else if (activeConfigPath) {
        configFilePath = activeConfigPath;
        console.log(`Reloading config from previous path: ${configFilePath}`);
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
    activeConfigPath = configFilePath;
    return parsedConfig.data as Config;
}

import os from "node:os";
import { readFileSync, existsSync } from "node:fs";

import {z} from "zod";

import {ConfigSchema} from "./config-schema.ts";


const homeDir: string = os.homedir();
const defaultConfigFileName = "epf.toml";
const configURLEnvVar = "EPF_CONFIG_URL";

type Config = z.infer<typeof ConfigSchema>;

async function readConfig() {
    console.log(`Loading config`);
    
    let configFilePath: string;
    if (process.argv.length >= 3) {
        configFilePath = process.argv[2]!;
        console.log(`Found config from command line argument: ${configFilePath}`);
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
        console.log(`Loading config from file: ${configFilePath}`);
        configFileContents = readFileSync(configFilePath).toString();
    }

    let obj =  Bun.TOML.parse(configFileContents);
    const parsedConfig = ConfigSchema.safeParse(obj);
    if (!parsedConfig.success) {
        console.error("Config file is invalid:", parsedConfig.error.format());
        throw new Error("Config file is invalid");
    }
    console.log(`Config loaded from ${configFilePath}`);
    return parsedConfig.data as Config;
}

export const CONFIG = await readConfig();

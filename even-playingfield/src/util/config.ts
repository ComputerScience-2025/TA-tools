import os from "node:os";
import { readFileSync, existsSync } from "node:fs";

import {z} from "zod";

import {ConfigSchema} from "./config-schema.ts";


const homeDir: string = os.homedir();
const configFileName = "epf.toml";
const configURLEnvVar = "EPF_CONFIG_URL";

type Config = z.infer<typeof ConfigSchema>;

async function readConfig() {
    console.log(`Loading config`);

    let configFileContents: string;
    let configFilePath: string;
    if (process.env[configURLEnvVar]) {
        const configURL = process.env[configURLEnvVar]!;
        console.log(`Fetching config from URL: ${configURL}`);
        const configResponse = await fetch(configURL);
        if (!configResponse.ok) {
            throw new Error(`Failed to fetch config from URL: ${configURL}, status: ${configResponse.status}`);
        }
        configFileContents = await configResponse.text();
        configFilePath = configURL;
    }
    else {
        if (existsSync(configFileName)) {
            configFilePath = configFileName;
        }
        else if (existsSync(`${homeDir}/${configFileName}`)) {
            configFilePath = `${homeDir}/${configFileName}`;
        }
        else {
            throw new Error(`Config file ${configFileName} not found`);
        }
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

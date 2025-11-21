import os from "node:os";
import { readFileSync, existsSync } from "node:fs";

import {z} from "zod";

import {ConfigSchema} from "./config-schema.ts";


const homeDir: string = os.homedir();
const configFileName = "epf.toml";

type Config = z.infer<typeof ConfigSchema>;

function readConfig() {
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

export const CONFIG = readConfig();

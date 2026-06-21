import os from "node:os";
import { readFileSync, existsSync } from "node:fs";

import {z} from "zod";

import {ConfigSchema, CURRENT_CONFIG_VERSION} from "./config-schema.ts";
import {detectConfigVersion} from "./config-migrations.ts";


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
 * Resolve the config file path. Resolution order:
 *   1. `configPathOverride` (explicit --config / prior resolved path)
 *   2. `EPF_CONFIG_URL` environment variable
 *   3. `epf.toml` in the current working directory
 *   4. `epf.toml` in the user's home directory
 *
 * Throws if no config can be found. Shared between {@link readConfig} and the
 * `migrate` subcommand so both honor the same lookup rules.
 */
export function resolveConfigPath(configPathOverride?: string): string {
    if (configPathOverride && configPathOverride.trim().length > 0) {
        const path = configPathOverride.trim();
        console.log(`Found config from provided path: ${path}`);
        return path;
    }
    if (process.env[configURLEnvVar]) {
        console.log(`Found config from environment variable ${configURLEnvVar}`);
        return process.env[configURLEnvVar]!;
    }
    if (existsSync(defaultConfigFileName)) {
        console.log(`Found config from current directory`);
        return defaultConfigFileName;
    }
    if (existsSync(`${homeDir}/${defaultConfigFileName}`)) {
        console.log(`Found config from home directory`);
        return `${homeDir}/${defaultConfigFileName}`;
    }
    throw new Error(`Config file ${defaultConfigFileName} not found`);
}

/**
 * Read a config file (local path or HTTP(S) URL) and parse it as TOML.
 * Returns the raw parsed object plus the original text. No schema validation
 * or version checking is performed here — callers decide what to do with the
 * raw object (validate, migrate, etc.).
 */
export async function loadRawConfig(configFilePath: string): Promise<{
    obj: Record<string, unknown>;
    contents: string;
    path: string;
}> {
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

    const obj = Bun.TOML.parse(configFileContents) as Record<string, unknown>;
    return { obj, contents: configFileContents, path: configFilePath };
}

/**
 * Load and validate the config. Uses {@link resolveConfigPath} for lookup,
 * then enforces a **version gate**: the config's `version` must exactly match
 * {@link CURRENT_CONFIG_VERSION}. Outdated configs are rejected with an
 * instruction to run `even-pf migrate`; newer configs are rejected as
 * requiring a binary upgrade. No automatic migration is performed at runtime.
 *
 * Returns the parsed config together with the path it was loaded from.
 * Callers that want to reload from the same source should capture the
 * returned `path` and pass it back in as `configPathOverride`.
 */
export async function readConfig(configPathOverride?: string): Promise<ResolvedConfig> {
    console.log(`Loading config`);

    const configFilePath = resolveConfigPath(configPathOverride);
    const { obj, contents } = await loadRawConfig(configFilePath);

    const version = detectConfigVersion(obj);
    if (version < CURRENT_CONFIG_VERSION) {
        throw new Error(
            `Config version ${version} is outdated (current is ${CURRENT_CONFIG_VERSION}). ` +
            `Run: even-pf migrate -C ${configFilePath}`,
        );
    }
    if (version > CURRENT_CONFIG_VERSION) {
        throw new Error(
            `Config version ${version} is newer than this binary supports (${CURRENT_CONFIG_VERSION}). ` +
            `Upgrade even-pf.`,
        );
    }

    const parsedConfig = ConfigSchema.safeParse(obj);
    if (!parsedConfig.success) {
        console.error("Config file is invalid:", parsedConfig.error.format());
        console.log(`Config file contents:\n${contents}`);
        console.log(parsedConfig);
        throw new Error("Config file is invalid");
    }
    console.log(`Config loaded from ${configFilePath}`);
    return { config: parsedConfig.data as Config, path: configFilePath };
}

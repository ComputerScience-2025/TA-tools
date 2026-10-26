/** Bun (CLI / compiled binary) platform wiring. */

import os from "node:os";

import { BunEnvProvider } from "./bun-env.ts";
import { BunFileSystem } from "./bun-fs.ts";
import { BunLogger } from "./bun-logger.ts";
import { BunShellRunner } from "./bun-shell.ts";
import type { Platform, TomlCodec } from "../types.ts";

/**
 * `Bun.TOML.parse` is kept for the CLI so existing configs parse exactly as
 * they did before the platform split. The browser gets smol-toml instead
 * (`createWebPlatform`).
 */
const BUN_TOML: TomlCodec = {
    parse(text: string): Record<string, unknown> {
        return Bun.TOML.parse(text) as Record<string, unknown>;
    },
};

export function createBunPlatform(): Platform {
    return {
        fs: new BunFileSystem(),
        env: new BunEnvProvider(),
        shell: new BunShellRunner(),
        logger: new BunLogger(),
        toml: BUN_TOML,
        homeDir: os.homedir(),
    };
}

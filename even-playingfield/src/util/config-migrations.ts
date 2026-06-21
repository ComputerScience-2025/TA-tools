/**
 * Config migration registry.
 *
 * Each migration transforms the raw parsed TOML object (a plain
 * `Record<string, unknown>`) from one schema version to the next. Migrations
 * run *before* Zod validation and must be robust to partial configs: only
 * touch keys that are present.
 *
 * When the schema changes:
 *   1. Bump `CURRENT_CONFIG_VERSION` in `config-schema.ts`.
 *   2. Add a migration here: `MIGRATIONS[oldVersion] = { to: newVersion, migrate }`.
 *   3. The new migration must stamp the new `version` (handled by
 *      {@link migrateToCurrent}, which sets `version = step.to` after each step).
 */

import { CURRENT_CONFIG_VERSION } from "./config-schema.ts";


type RawConfig = Record<string, unknown>;

export type Migration = {
    to: number;
    migrate: (obj: RawConfig) => RawConfig;
};

function isRecord(value: unknown): value is RawConfig {
    return typeof value === "object" && value !== null && !Array.isArray(value);
}

function ensureRecord(obj: RawConfig, key: string): RawConfig {
    const existing = obj[key];
    if (!isRecord(existing)) {
        obj[key] = {};
    }
    return obj[key] as RawConfig;
}

/**
 * v4 -> v5
 *
 * Schema changes (commit 4e854a7 and follow-ups):
 *   - Top-level `[vendors.openrouter] api_key` is replaced by named providers
 *     under `[llm.providers.*]`. The single OpenRouter vendor becomes
 *     `llm.providers.openrouter = { sdk = "openai", endpoint = "...", api_key }`.
 *   - Each `llm.models.<name>.sdk` (an enum limited to "openrouter") becomes
 *     `provider`, a string referencing a key under `llm.providers`.
 *   - `seed` is added to models (left to Zod's default — no value to carry over).
 *   - `reasoning_effort` gains "xhigh" (no migration action needed; existing
 *     values remain valid).
 */
function migrateV4ToV5(obj: RawConfig): RawConfig {
    // 1. vendors.openrouter.api_key -> llm.providers.openrouter
    const vendors = obj["vendors"];
    if (isRecord(vendors)) {
        const openrouter = vendors["openrouter"];
        if (isRecord(openrouter) && typeof openrouter["api_key"] === "string") {
            const llm = ensureRecord(obj, "llm");
            const providers = ensureRecord(llm, "providers");
            providers["openrouter"] = {
                sdk: "openai",
                endpoint: "https://openrouter.ai/api/v1",
                api_key: openrouter["api_key"],
            };
        }
        delete obj["vendors"];
    }

    // 2. models: sdk -> provider
    const llm = obj["llm"];
    if (isRecord(llm)) {
        const models = llm["models"];
        if (isRecord(models)) {
            for (const model of Object.values(models)) {
                if (isRecord(model)) {
                    if (typeof model["sdk"] === "string" && model["provider"] === undefined) {
                        model["provider"] = model["sdk"];
                    }
                    delete model["sdk"];
                }
            }
        }
    }

    return obj;
}

export const MIGRATIONS: Record<number, Migration> = {
    4: { to: 5, migrate: migrateV4ToV5 },
};

/**
 * Determine the schema version of a raw parsed config. Config files produced
 * before versioning was introduced (i.e. v4 and earlier) carry no `version`
 * field, so absence is treated as 4 — the last formally published version.
 */
export function detectConfigVersion(obj: RawConfig): number {
    const v = obj["version"];
    return typeof v === "number" && Number.isInteger(v) ? v : 4;
}

/**
 * Apply migrations sequentially from the auto-detected version up to
 * {@link CURRENT_CONFIG_VERSION}. Throws if a required step is missing. The
 * returned object has `version` hoisted to the front for readable TOML output.
 */
export function migrateToCurrent(obj: RawConfig): RawConfig {
    let current = detectConfigVersion(obj);
    let result = obj;

    while (current < CURRENT_CONFIG_VERSION) {
        const step = MIGRATIONS[current];
        if (!step) {
            throw new Error(`No migration registered from config version ${current}`);
        }
        result = step.migrate(result);
        result["version"] = step.to;
        current = step.to;
    }

    // Hoist `version` to the front for readable output.
    const version = result["version"];
    delete result["version"];
    return { version, ...result };
}

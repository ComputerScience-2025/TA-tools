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

import { createDefaultOutputViewing } from "./config-defaults.ts";
import { CURRENT_CONFIG_VERSION } from "./config-schema.ts";


type RawConfig = Record<string, unknown>;

export type Migration = {
    to: number;
    /** Shown by the browser editor and the CLI before/after migrating. */
    description: string;
    migrate: (obj: RawConfig) => RawConfig;
};

export type MigrationStep = {
    from: number;
    to: number;
    description: string;
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
 *   - `[output_viewing]` is required by the schema and every field has a
 *     default, so a config that predates the block gets the defaults written in.
 *     `detectConfigVersion` reports *any* unversioned file as v4, so configs
 *     older than v4 reach this step too and must end up complete.
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

    // 3. output_viewing: required by the schema, all-defaulted, and absent from
    // configs written before the block existed. Only fill it in when missing so
    // an explicit block (even a partial one) is never overwritten.
    if (obj["output_viewing"] === undefined) {
        obj["output_viewing"] = createDefaultOutputViewing();
    }

    return obj;
}

export const MIGRATIONS: Record<number, Migration> = {
    4: {
        to: 5,
        description:
            "Moves vendors.openrouter.api_key to llm.providers.openrouter, renames each model's " +
            "sdk field to provider, and fills in a default [output_viewing] block when the config " +
            "predates it.",
        migrate: migrateV4ToV5,
    },
};

/**
 * Human-readable migration path from `from` to `to` (defaults to the current
 * schema version). Throws when a step is missing, exactly like
 * {@link migrateToCurrent}.
 */
export function migrationSteps(from: number, to: number = CURRENT_CONFIG_VERSION): MigrationStep[] {
    const steps: MigrationStep[] = [];
    let current = from;
    while (current < to) {
        const step = MIGRATIONS[current];
        if (!step) {
            throw new Error(`No migration registered from config version ${current}`);
        }
        steps.push({ from: current, to: step.to, description: step.description });
        current = step.to;
    }
    return steps;
}

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

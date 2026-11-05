/**
 * Config loading, driven by the platform abstraction.
 *
 * Source resolution order (unchanged from the original CLI implementation):
 *   1. an explicit source (CLI `--config`, or the web UI's chosen source)
 *   2. `EPF_CONFIG_URL` from the platform environment
 *   3. `epf.toml` in the workspace root (the CLI's working directory)
 *   4. `epf.toml` in the home directory (skipped when the platform has none)
 *
 * The version gate and Zod validation also live here, so the CLI and the
 * browser reject configs for exactly the same reasons.
 */

import type { ZodError } from "zod";

import { detectConfigVersion } from "./config-migrations.ts";
import { ConfigSchema, CURRENT_CONFIG_VERSION } from "./config-schema.ts";
import { CONFIG_URL_ENV_VAR } from "./env-vars.ts";
import { errorMessage } from "./errors.ts";
import { joinPath } from "../platform/path.ts";
import type { Config } from "./config-schema.ts";
import type { Platform } from "../platform/types.ts";

export type { Config };
export { CONFIG_URL_ENV_VAR };

export const DEFAULT_CONFIG_FILE_NAME = "epf.toml";

/** Where a config came from. `inline` is text supplied directly (web UI). */
export type ConfigSource =
    | { kind: "path"; path: string }
    | { kind: "url"; url: string }
    | { kind: "inline"; text: string; label: string };

export type ResolvedConfig = {
    config: Config;
    /** Kept so `reload` can re-read from the same place. */
    source: ConfigSource;
    /** Exact text that was validated. Cached so the editor does not refetch. */
    contents: string;
    /** Response ETag for URL sources, when the host exposes it. */
    etag?: string;
};

export type RawConfig = {
    obj: Record<string, unknown>;
    contents: string;
    source: ConfigSource;
    /** Response ETag for URL sources, when the host exposes it. */
    etag?: string;
};

export function configSourceLabel(source: ConfigSource): string {
    switch (source.kind) {
        case "path":
            return source.path;
        case "url":
            return source.url;
        case "inline":
            return source.label;
    }
}

function isHttpUrl(value: string): boolean {
    return /^https?:\/\//.test(value);
}

const CONFIG_FETCH_TIMEOUT_MS = 15_000;

async function fetchConfigText(url: string): Promise<{ contents: string; etag?: string }> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), CONFIG_FETCH_TIMEOUT_MS);
    try {
        let response: Response;
        try {
            // Use the normal HTTP cache: the browser and a CDN handle
            // Cache-Control / ETag revalidation better than a cache buster.
            response = await fetch(url, {
                redirect: "follow",
                signal: controller.signal,
                headers: { Accept: "application/toml, text/plain, */*" },
            });
        } catch (error) {
            if (controller.signal.aborted) {
                throw new Error(
                    `Timed out after ${CONFIG_FETCH_TIMEOUT_MS / 1000}s fetching the config from URL: ${url}`,
                );
            }
            throw new Error(
                `Failed to fetch the config from URL: ${url}. Check that the URL is reachable and that ` +
                `CORS is properly configured for this host. (${errorMessage(error)})`,
            );
        }
        if (!response.ok) {
            throw new Error(
                `Failed to fetch the config from URL: ${url}, status: ${response.status} ${response.statusText}`.trim(),
            );
        }
        const contents = await response.text();
        const etag = response.headers.get("etag") ?? undefined;
        return { contents, etag };
    } finally {
        clearTimeout(timeout);
    }
}

/** Normalize a string (`--config` value, env var) into a {@link ConfigSource}. */
export function toConfigSource(value: string | ConfigSource): ConfigSource {
    if (typeof value !== "string") {
        return value;
    }
    const trimmed = value.trim();
    if (isHttpUrl(trimmed)) {
        return { kind: "url", url: trimmed };
    }
    return { kind: "path", path: trimmed };
}

/**
 * One validation problem. `path` is the Zod issue path, so the interactive
 * editor can attach the message to the field that caused it.
 */
export type ConfigIssue = {
    path: (string | number)[];
    message: string;
};

/** Validation problems as readable `path: message` lines. */
export function formatConfigIssues(error: ZodError): string[] {
    return error.issues.map((issue) => {
        const path = issue.path.join(".");
        return path.length > 0 ? `${path}: ${issue.message}` : issue.message;
    });
}

export type ConfigValidation =
    | { ok: true; config: Config }
    | { ok: false; message: string; issues: string[]; structuredIssues: ConfigIssue[] };

function structuredIssuesFromZod(error: ZodError): ConfigIssue[] {
    return error.issues.map((issue) => ({
        path: issue.path.map((segment) => (typeof segment === "number" ? segment : String(segment))),
        message: issue.message,
    }));
}

/**
 * Version gate plus schema validation for an already-parsed config object.
 * Shared by the loader and by the web UI's editor so both report the same
 * problems.
 */
export function validateConfigObject(obj: Record<string, unknown>, label: string): ConfigValidation {
    const version = detectConfigVersion(obj);
    if (version < CURRENT_CONFIG_VERSION) {
        const message = `Config version ${version} is outdated; run 'even-pf migrate -C ${label}'.`;
        return {
            ok: false,
            message: `Config version ${version} is outdated (current is ${CURRENT_CONFIG_VERSION}). ` +
                `Run: even-pf migrate -C ${label}`,
            issues: [message],
            structuredIssues: [{ path: [], message }],
        };
    }
    if (version > CURRENT_CONFIG_VERSION) {
        const message = `Config version ${version} is newer than this build supports (${CURRENT_CONFIG_VERSION}).`;
        return {
            ok: false,
            message: `Config version ${version} is newer than this binary supports (${CURRENT_CONFIG_VERSION}). ` +
                `Upgrade even-pf.`,
            issues: [message],
            structuredIssues: [{ path: [], message }],
        };
    }

    const parsed = ConfigSchema.safeParse(obj);
    if (!parsed.success) {
        return {
            ok: false,
            message: `Config file is invalid: ${label}`,
            issues: formatConfigIssues(parsed.error),
            structuredIssues: structuredIssuesFromZod(parsed.error),
        };
    }
    return { ok: true, config: parsed.data as Config };
}

/** Parse and validate config text without loading or keeping it. */
export function validateConfigText(platform: Platform, text: string, label = "config"): ConfigValidation {
    let obj: Record<string, unknown>;
    try {
        obj = platform.toml.parse(text);
    } catch (error) {
        const message = errorMessage(error);
        return {
            ok: false,
            message: `TOML parse error in ${label}: ${message}`,
            issues: [message],
            structuredIssues: [{ path: [], message }],
        };
    }
    return validateConfigObject(obj, label);
}

/** Name of the config file looked up in the platform's home directory. */
export function homeConfigFileName(platform: Platform): string {
    const configured = platform.homeConfigName;
    return configured !== undefined && configured.trim().length > 0
        ? configured.trim()
        : DEFAULT_CONFIG_FILE_NAME;
}

/**
 * The home-directory config, when the platform has a home directory and the
 * file exists. The web platform points this at its durable config library.
 */
export async function findHomeConfigSource(platform: Platform): Promise<ConfigSource | null> {
    if (platform.homeDir === undefined) {
        return null;
    }
    const path = joinPath(platform.homeDir, homeConfigFileName(platform));
    if (await platform.fs.exists(path)) {
        return { kind: "path", path };
    }
    return null;
}

export async function resolveConfigSource(
    platform: Platform,
    override?: string | ConfigSource,
): Promise<ConfigSource> {
    if (override !== undefined) {
        const source = toConfigSource(override);
        platform.logger.log("info", `Found config from provided source: ${configSourceLabel(source)}`);
        return source;
    }

    const fromEnv = platform.env.get(CONFIG_URL_ENV_VAR);
    if (fromEnv !== undefined && fromEnv.trim().length > 0) {
        platform.logger.log("info", `Found config from environment variable ${CONFIG_URL_ENV_VAR}`);
        return toConfigSource(fromEnv.trim());
    }

    const workspaceCandidate = joinPath(platform.fs.root, DEFAULT_CONFIG_FILE_NAME);
    if (await platform.fs.exists(workspaceCandidate)) {
        platform.logger.log("info", "Found config from current directory");
        return { kind: "path", path: workspaceCandidate };
    }

    const home = await findHomeConfigSource(platform);
    if (home !== null) {
        platform.logger.log("info", "Found config from home directory");
        return home;
    }

    throw new Error(`Config file ${DEFAULT_CONFIG_FILE_NAME} not found`);
}

/** Read a config source and parse it as TOML. No validation happens here. */
export async function loadRawConfig(platform: Platform, source: ConfigSource): Promise<RawConfig> {
    let contents: string;
    let etag: string | undefined;

    switch (source.kind) {
        case "url": {
            platform.logger.log("info", `Fetching config from URL: ${source.url}`);
            const fetched = await fetchConfigText(source.url);
            contents = fetched.contents;
            etag = fetched.etag;
            break;
        }
        case "inline":
            contents = source.text;
            break;
        case "path": {
            if (isHttpUrl(source.path)) {
                return await loadRawConfig(platform, { kind: "url", url: source.path });
            }
            platform.logger.log("info", `Loading config from local file: ${source.path}`);
            contents = await platform.fs.readText(source.path);
            break;
        }
    }

    if (contents.trim().length === 0) {
        throw new Error(`Config is empty: ${configSourceLabel(source)}`);
    }

    return { obj: platform.toml.parse(contents), contents, source, etag };
}

/**
 * Load and validate a config. Enforces a version gate: outdated configs are
 * rejected with an instruction to run `even-pf migrate`, newer ones as
 * requiring a binary upgrade. No automatic migration happens at runtime.
 */
export async function loadConfig(
    platform: Platform,
    override?: string | ConfigSource,
): Promise<ResolvedConfig> {
    platform.logger.log("info", "Loading config");

    const source = await resolveConfigSource(platform, override);
    const { obj, contents, etag } = await loadRawConfig(platform, source);

    const validation = validateConfigObject(obj, configSourceLabel(source));
    if (!validation.ok) {
        for (const issue of validation.issues) {
            platform.logger.log("error", issue);
        }
        platform.logger.log("debug", `Config file contents:\n${contents}`);
        throw new Error(validation.message);
    }

    platform.logger.log("info", `Config loaded from ${configSourceLabel(source)}`);
    return { config: validation.config, source, contents, etag };
}

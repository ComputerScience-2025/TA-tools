/**
 * Browser host: the embeddable EPF core for a web page.
 *
 * Mirrors `hosts/local-api-host.ts` (the Bun host) but replaces the CLI's
 * working-directory concept with browser workspaces and sources its files from
 * uploads or GitHub instead of the local disk.
 *
 * Everything it uses comes from the platform abstraction, so it runs in a page
 * context with no Bun/Node APIs.
 */

import { Engine } from "../engine/index.ts";
import { executeLs, helpText, parseAndExecute } from "../command-handler.ts";
import {
    DEFAULT_CONFIG_FILE_NAME,
    configSourceLabel,
    loadConfig,
    loadRawConfig,
    toConfigSource,
    validateConfigObject,
    validateConfigText,
} from "../util/config-loader.ts";
import { detectConfigVersion } from "../util/config-migrations.ts";
import {
    isTomlFileName,
    normalizeConfigFileName,
    normalizeConfigRelativePath,
} from "../util/config-files.ts";
import {
    coerceEditorDraftFile,
    createEmptyEditorDraftFile,
    editorDraftKey,
    hashText,
    pruneEditorDrafts,
} from "../util/editor-draft.ts";
import {
    headS3Object,
    joinS3Key,
    publicS3ObjectUrl,
    putS3Object,
    resolveS3Settings,
    s3ObjectUrl,
} from "../util/s3.ts";
import { planGithubDownload, githubRemote, parseGithubUrl } from "../download/github.ts";
import { runDownload } from "../download/runner.ts";
import { SessionStore } from "../util/session-store.ts";
import { createWebPlatform, storageEstimate } from "../platform/web/web-platform.ts";
import { basenamePath, dirnamePath, isWithinPath, joinPath, resolvePath } from "../platform/path.ts";
import {
    CONFIG_URL_ENV_VAR,
    GITHUB_PAT_ENV_VAR,
    S3_PUBLIC_BASE_URL_ENV_VAR,
} from "../util/env-vars.ts";
import { errorMessage } from "../util/errors.ts";
import type { CommandResult } from "../command-handler.ts";
import type { Config, ConfigSource, ConfigValidation, RawConfig } from "../util/config-loader.ts";
import type { DownloadPlan, DownloadSummary, EnvVars } from "../download/types.ts";
import type { EngineEvent } from "../engine/engine.ts";
import type { BrowserStorageEstimate, WebPlatform, WebPlatformOptions } from "../platform/web/web-platform.ts";
import type { WorkspaceOrigin, WorkspaceState } from "../platform/web/web-state.ts";
import type { WorkflowRunResult } from "../engine/index.ts";
import type { ChatSession, ChatSessionSummary } from "../util/chat-session.ts";
import type { ChatStreamHandlers } from "../util/llm.ts";
import type { ChatClient, ChatOutcome } from "../util/chat-service.ts";
import type { EditorDraft, EditorDraftFile } from "../util/editor-draft.ts";
import type { S3AddressingStyle, S3Settings, S3SettingsResult } from "../util/s3.ts";

const MAX_WORKSPACE_WALK_DEPTH = 32;
const DOWNLOAD_CONCURRENCY = 5;

/** Config file names looked for inside a fetched workspace, in priority order. */
export const CONFIG_CANDIDATE_NAMES: readonly string[] = [
    DEFAULT_CONFIG_FILE_NAME,
    "eval/epf.toml",
];

const BROWSER_HELP_SUFFIX = `\n\nNo config is loaded yet: 'ls' still lists the workspace; run, list, status, clear and reload need a config from the Config panel.`;

export type WebEPFOptions = WebPlatformOptions & {
    /** Skip the automatic config lookup at startup. */
    configSource?: ConfigSource;
    /** Test seam: replace the streaming chat client. */
    chatClient?: ChatClient;
};

export type WorkspaceFile = {
    /** Path relative to the workspace root. */
    path: string;
    size: number;
    mtimeMs: number;
};

export type UploadedFile = {
    /** Name (may include subdirectories) relative to the target directory. */
    name: string;
    bytes: Uint8Array;
};

export type FetchSourceRequest =
    | { kind: "url"; url: string; workspacePath?: string; label?: string; token?: string }
    | {
        kind: "repo";
        owner: string;
        repo: string;
        ref?: string;
        directory?: string;
        mode?: "tree" | "blob";
        workspacePath?: string;
        label?: string;
        token?: string;
    };

export type FetchSourceSummary = {
    workspace: WorkspaceState;
    plan: DownloadPlan;
    summary: DownloadSummary;
    /** Workspace-relative config paths found in the fetched tree. */
    configCandidates: string[];
    /** Config adopted automatically. */
    configLoaded: string | null;
    /** Why an available config was not adopted, if loading it failed. */
    configError: string | null;
};

export type UploadSummary = {
    workspace: WorkspaceState;
    written: number;
    bytes: number;
};

/** One file in the durable config library. */
export type HomeConfigFile = {
    name: string;
    size: number;
    mtimeMs: number;
};

/**
 * A config read for editing. No schema validation has happened: the editor
 * must be able to open outdated or invalid configs so the user can fix them.
 */
export type OpenedConfigDocument = {
    source: ConfigSource;
    text: string;
    raw: Record<string, unknown>;
    /** ETag from a URL response, when the host exposes it. */
    etag?: string;
    version: number;
};

export type SaveConfigOptions = {
    /** Replace an existing file instead of reporting a conflict. */
    overwrite?: boolean;
    /**
     * Load the written file into the engine (default true). Library actions
     * such as Duplicate set this false so they do not change the active config.
     */
    activate?: boolean;
};

export type SaveHomeConfigOptions = SaveConfigOptions & {
    /** Make this the library file used by workspaces without a config. */
    makeDefault?: boolean;
};

export type SaveConfigToS3Options = {
    /** Key relative to the configured prefix. Defaults to `epf.toml`. */
    key?: string;
    /** Replace an existing object. */
    overwrite?: boolean;
    /** Overwrite without the ETag conflict check after the user confirmed it. */
    force?: boolean;
};

export type SavedS3Config = {
    bucket: string;
    key: string;
    etag: string | null;
    /** S3 API URL. May require credentials; use {@link publicURL} for sharing. */
    url: string;
    /** Public URL when `EPF_S3_PUBLIC_BASE_URL` is configured. */
    publicURL: string | null;
    /**
     * True when a concurrency guard was evaluated before the write. False only
     * for a forced overwrite, which skips the check entirely.
     */
    checked: boolean;
};

export type S3ConnectionTestResult =
    | {
        ok: true;
        bucket: string;
        endpoint: string;
        addressingStyle: S3AddressingStyle;
        /** Object key that was probed. */
        key: string;
    }
    | { ok: false; message: string };

/** Freshness of the config loaded from a URL. */
export type RemoteConfigStatus = {
    source: { kind: "url"; url: string };
    /** Last successful fetch, or null when it has never succeeded. */
    fetchedAt: number | null;
    /** Last fetch that changed the config text. */
    changedAt: number | null;
    /** Why the most recent refresh failed. */
    error: string | null;
};

export type StorageUsage = {
    /**
     * Logical bytes of everything EPF keeps in browser storage: workspaces,
     * the config library, drafts and chat sessions.
     */
    used: number;
    /** Configured cap for those bytes (`maxTotalBytes`). */
    cap: number;
};

/** Re-exported for the dashboard: the browser's whole-site storage figure. */
export type { BrowserStorageEstimate };

export class WebEPF {
    readonly web: WebPlatform;
    private readonly options: WebEPFOptions;
    private engine: Engine | null = null;
    private configSource: ConfigSource | null = null;
    /** Source the last load/open attempt targeted, even when it failed. */
    private attemptedSource: ConfigSource | null = null;
    private configError: string | null = null;
    private readonly engineListeners: Set<(engine: Engine | null) => void> = new Set();
    private unsubscribeEngineEvents: (() => void) | null = null;
    /** Cached text of the current config source, so refreshes do not refetch URLs. */
    private configTextCache: { source: ConfigSource; text: string } | null = null;
    /** Freshness of the current URL config. Null for file and inline sources. */
    private remoteStatus: RemoteConfigStatus | null = null;
    /** Hash of the last URL text that was applied, to detect remote changes. */
    private remoteTextHash: string | null = null;
    /** S3 ETag for a public config URL, keyed by URL, for `If-Match` writes. */
    private readonly s3ETags: Map<string, string> = new Map();
    /** Durable chat history, outside the quota-evicted workspace tree. */
    private readonly sessionStore: SessionStore;

    private constructor(options: WebEPFOptions, web: WebPlatform) {
        this.options = options;
        this.web = web;
        this.sessionStore = new SessionStore(
            web.storageFs,
            joinPath(web.homeDir, "sessions"),
            {
                origin: "web",
                onWarning: (message) => web.logs.log("warn", message),
            },
        );
    }

    /**
     * Build the platform, ensure a workspace exists and adopt a config when one
     * is reachable. A missing config is not an error here: the UI asks the user
     * for one (see {@link hasConfig}).
     */
    static async create(options: WebEPFOptions = {}): Promise<WebEPF> {
        const web = await createWebPlatform(options);
        const epf = new WebEPF(options, web);
        await epf.bootstrap();
        return epf;
    }

    private async bootstrap(): Promise<void> {
        const readOnly = this.web.readOnly;
        const active = this.web.state.get().activeWorkspace;
        const activeExists = active !== null && this.web.state.getWorkspace(active) !== null;
        if (!activeExists) {
            const existing = this.web.state.listWorkspaces();
            if (existing.length > 0) {
                this.web.state.setActiveWorkspace(existing[0]!.path);
            } else if (!readOnly) {
                await this.createWorkspace("workspace", "empty");
            }
        }

        const source = this.options.configSource ?? await this.findConfigSource();
        if (source !== null) {
            const normalized = this.normalizeSource(source);
            this.attemptedSource = normalized;
            if (readOnly) {
                // A read-only tab cannot build an engine, but the editor can still
                // open (and show) this file; do not report it as a load failure.
                return;
            }
            try {
                await this.loadConfigSource(normalized);
            } catch (error) {
                this.configError = errorMessage(error);
                this.web.logs.log("warn", `Could not load the config automatically: ${this.configError}`);
            }
        }
    }

    /** Guard for actions that need write access (viewer sessions have none). */
    private assertWritable(action: string): void {
        const reason = this.web.writeBlockedBy;
        if (reason === null) {
            return;
        }
        if (reason === "another-tab") {
            throw new Error(
                `${action} needs write access, but another tab owns browser storage. ` +
                "Close that tab and use 'Take over storage' here, or reload this tab.",
            );
        }
        throw new Error(`${action} needs write access; this view is read-only. Open the EPF page to make changes.`);
    }

    /**
     * Refuse actions that would move or delete the filesystem root while a run
     * is in flight. The engine resolves files through the active workspace, so
     * switching it mid-run would write outputs into the wrong place.
     */
    private assertIdle(action: string): void {
        if (this.engine !== null && this.engine.getStatus().inFlight.length > 0) {
            throw new Error(`${action} while workflows are running. Wait for the current run to finish.`);
        }
    }

    // --- Introspection ---

    getEngine(): Engine | null {
        return this.engine;
    }

    /**
     * Called whenever the engine is (re)created — loading a new config builds a
     * fresh Engine, so hosts subscribe here to re-attach their event listeners.
     */
    onEngineChange(listener: (engine: Engine | null) => void): () => void {
        this.engineListeners.add(listener);
        return () => {
            this.engineListeners.delete(listener);
        };
    }

    private setEngine(engine: Engine | null): void {
        this.unsubscribeEngineEvents?.();
        this.unsubscribeEngineEvents = null;
        this.engine = engine;
        if (engine !== null) {
            this.unsubscribeEngineEvents = engine.addEventListener((event) => this.handleEngineEvent(event));
        }
        for (const listener of this.engineListeners) {
            try {
                listener(engine);
            } catch (error) {
                const message = errorMessage(error);
                this.web.logs.log("error", `Engine listener failed: ${message}`);
            }
        }
    }

    /**
     * Record what every finished run wrote. This is the list "clear outputs"
     * deletes, so results can be cleared without touching the workspace's own
     * sources — including after a reload.
     */
    private handleEngineEvent(event: EngineEvent): void {
        if (event.type === "config-reloaded") {
            // `reload` re-reads the source inside the engine. Keep the host's
            // text cache in step so the panel does not fetch the URL twice.
            this.configTextCache = { source: event.source, text: event.contents };
            if (event.source.kind === "url") {
                const nextHash = hashText(event.contents);
                const changed = this.remoteTextHash !== null && this.remoteTextHash !== nextHash;
                this.remoteTextHash = nextHash;
                this.remoteStatus = {
                    source: event.source,
                    fetchedAt: Date.now(),
                    changedAt: changed ? Date.now() : this.remoteStatus?.changedAt ?? null,
                    error: null,
                };
            }
            return;
        }
        if (event.type !== "run-finished") {
            return;
        }
        const workspace = this.getActiveWorkspace();
        const outputs = event.result.outputs;
        if (workspace === null || outputs === undefined || outputs.length === 0) {
            return;
        }
        this.web.state.recordWorkspaceOutputs(workspace.path, outputs.map((output) => output.filename));
    }

    getConfig(): Config | null {
        return this.engine?.getConfig() ?? null;
    }

    hasConfig(): boolean {
        return this.engine !== null;
    }

    getConfigSource(): ConfigSource | null {
        return this.configSource;
    }

    /**
     * The source the last load attempt targeted. Unlike {@link getConfigSource}
     * this is set even when validation failed, so the editor can offer to open
     * an invalid config and let the user fix it.
     */
    getAttemptedConfigSource(): ConfigSource | null {
        return this.attemptedSource;
    }

    getConfigError(): string | null {
        return this.configError;
    }

    /** Active workspace, or null when the session has none (a viewer tab). */
    getActiveWorkspace(): WorkspaceState | null {
        const path = this.web.state.get().activeWorkspace;
        return path === null ? null : this.web.state.getWorkspace(path);
    }

    /** Like {@link getActiveWorkspace}, for actions that need a workspace. */
    requireActiveWorkspace(): WorkspaceState {
        const workspace = this.getActiveWorkspace();
        if (workspace === null) {
            throw new Error("No active workspace. Create one before running EPF.");
        }
        return workspace;
    }

    /**
     * Workspace a read-only view should read: the active one, or the first
     * persisted workspace when a viewer tab has no active selection.
     */
    getViewWorkspace(): WorkspaceState | null {
        return this.getActiveWorkspace() ?? this.listWorkspaces()[0] ?? null;
    }

    listWorkspaces(): WorkspaceState[] {
        return this.web.state.listWorkspaces();
    }

    // --- Config ---

    /**
     * Resolve a relative path against the active workspace and turn a path
     * that is really an HTTP URL into a URL source.
     */
    private normalizeSource(source: ConfigSource): ConfigSource {
        if (source.kind !== "path") {
            return source;
        }
        if (/^https?:\/\//.test(source.path)) {
            return { kind: "url", url: source.path };
        }
        return { kind: "path", path: resolvePath(this.web.platform.fs.root, source.path) };
    }

    /** Load a config from a source and make it the active one. Throws when invalid. */
    async loadConfigSource(source: ConfigSource): Promise<Config> {
        this.assertWritable("Loading a config");
        this.assertIdle("Loading a config");
        const normalized = this.normalizeSource(source);
        this.attemptedSource = normalized;
        const resolved = await loadConfig(this.web.platform, normalized);
        // Pin relative file sources to the workspace they were read from, so a
        // later reload does not silently resolve against a different workspace.
        const resolvedSource = this.normalizeSource(resolved.source);
        this.configSource = resolvedSource;
        this.configError = null;
        this.configTextCache = { source: resolvedSource, text: resolved.contents };
        if (resolvedSource.kind === "url") {
            this.remoteTextHash = hashText(resolved.contents);
            this.remoteStatus = {
                source: resolvedSource,
                fetchedAt: Date.now(),
                changedAt: null,
                error: null,
            };
        } else {
            this.remoteTextHash = null;
            this.remoteStatus = null;
        }
        this.rememberConfigSource(resolvedSource);
        this.setEngine(new Engine(resolved.config, this.web.platform, resolvedSource, {
            sessionStore: this.sessionStore,
            chatClient: this.options.chatClient,
        }));
        if (resolvedSource.kind === "url") {
            await this.captureS3ETagForURL(resolvedSource.url);
        }
        const workspace = this.getActiveWorkspace();
        if (workspace !== null) {
            this.web.state.touchWorkspace(workspace.path);
        }
        return resolved.config;
    }

    /**
     * Re-fetch the current URL config and apply it when the remote text changed.
     * A failed refresh keeps the last loaded config: the caller can show the
     * returned status and decide whether to run anyway.
     */
    async refreshRemoteConfig(): Promise<RemoteConfigStatus | null> {
        const source = this.configSource ?? this.attemptedSource;
        if (source === null || source.kind !== "url") {
            return this.remoteStatus;
        }
        const normalized = this.normalizeSource(source);
        if (normalized.kind !== "url") {
            return this.remoteStatus;
        }
        if (this.engine !== null && this.engine.getStatus().inFlight.length > 0) {
            const message = "A workflow is running, so the remote config was not refreshed.";
            this.remoteStatus = {
                source: normalized,
                fetchedAt: this.remoteStatus?.fetchedAt ?? null,
                changedAt: this.remoteStatus?.changedAt ?? null,
                error: message,
            };
            this.web.logs.log("debug", message);
            return this.remoteStatus;
        }

        try {
            const raw = await loadRawConfig(this.web.platform, normalized);
            const validation = validateConfigObject(raw.obj, configSourceLabel(normalized));
            if (!validation.ok) {
                throw new Error(validation.message);
            }
            const nextHash = hashText(raw.contents);
            const changed = this.remoteTextHash !== null && this.remoteTextHash !== nextHash;
            const now = Date.now();
            this.configTextCache = { source: normalized, text: raw.contents };
            this.remoteTextHash = nextHash;
            this.remoteStatus = {
                source: normalized,
                fetchedAt: now,
                changedAt: changed ? now : this.remoteStatus?.changedAt ?? null,
                error: null,
            };

            if (this.web.readOnly) {
                return this.remoteStatus;
            }
            if (changed || this.engine === null) {
                this.configSource = normalized;
                this.attemptedSource = normalized;
                this.configError = null;
                this.rememberConfigSource(normalized);
                if (this.engine === null) {
                    this.setEngine(new Engine(validation.config, this.web.platform, normalized, {
                        sessionStore: this.sessionStore,
                        chatClient: this.options.chatClient,
                    }));
                } else {
                    this.engine.applyConfig(validation.config, normalized);
                }
                if (changed) {
                    this.web.logs.log("info", `Remote config changed; reloaded from ${normalized.url}.`);
                }
            }
            if (changed) {
                // A public URL may expose a CDN ETag, which is not necessarily
                // the object's S3 ETag. Read the authoritative one instead.
                await this.captureS3ETagForURL(normalized.url);
            }
            return this.remoteStatus;
        } catch (error) {
            const message = errorMessage(error);
            this.remoteStatus = {
                source: normalized,
                fetchedAt: this.remoteStatus?.fetchedAt ?? null,
                changedAt: this.remoteStatus?.changedAt ?? null,
                error: message,
            };
            if (this.engine === null) {
                this.configError = message;
            }
            this.web.logs.log("warn", `Could not refresh the remote config: ${message}`);
            return this.remoteStatus;
        }
    }

    getRemoteConfigStatus(): RemoteConfigStatus | null {
        return this.remoteStatus;
    }

    /**
     * Read a config for editing without validating it. Parse errors still
     * throw, but an outdated schema or missing fields are left for the editor
     * (and the backend validator) to report.
     */
    async openConfigDocument(source: ConfigSource): Promise<OpenedConfigDocument> {
        const normalized = this.normalizeSource(source);
        if (normalized.kind === "path") {
            const info = await this.web.platform.fs.stat(normalized.path);
            if (info === null || info.kind !== "file") {
                throw new Error(this.describeMissingPath(normalized.path));
            }
        }
        let raw: RawConfig;
        try {
            raw = await loadRawConfig(this.web.platform, normalized);
        } catch (error) {
            // The file vanished between the check and the read: report what it
            // means for the user instead of surfacing a raw ENOENT.
            if (normalized.kind === "path" && !await this.web.platform.fs.exists(normalized.path)) {
                throw new Error(this.describeMissingPath(normalized.path, error));
            }
            throw error;
        }
        if (normalized.kind === "url") {
            await this.captureS3ETagForURL(normalized.url);
        }
        return {
            source: normalized,
            text: raw.contents,
            raw: raw.obj,
            etag: raw.etag,
            version: detectConfigVersion(raw.obj),
        };
    }

    /**
     * Message for a path the session index knows about but the filesystem does
     * not have. A read-only tab (another tab owns storage, or the results
     * viewer) explains why it cannot see the owning tab's files.
     */
    private describeMissingPath(path: string, error?: unknown): string {
        const detail = error === undefined ? "" : ` (${errorMessage(error)})`;
        if (this.web.writeBlockedBy === "another-tab") {
            return `'${path}' is not visible in this tab because another tab owns browser storage. ` +
                `Close that tab and take over storage, or reload this tab.${detail}`;
        }
        return `'${path}' is not in browser storage. It may have been removed or cleaned up.${detail}`;
    }

    /**
     * Map a public config URL back to its S3 object and remember the object's
     * real ETag. A CDN may add its own ETag, which cannot be used in If-Match.
     */
    private async captureS3ETagForURL(url: string): Promise<void> {
        const resolved = resolveS3Settings(this.web.env);
        if (!resolved.ok) {
            return;
        }
        const base = this.web.env.get(S3_PUBLIC_BASE_URL_ENV_VAR)?.trim() ?? "";
        if (base.length === 0) {
            return;
        }
        const prefix = base.replace(/\/+$/, "");
        if (!url.startsWith(`${prefix}/`)) {
            return;
        }
        const rawKey = url.slice(prefix.length + 1).split(/[?#]/)[0] ?? "";
        if (rawKey.length === 0) {
            return;
        }
        let key: string;
        try {
            key = normalizeConfigRelativePath(decodeURIComponent(rawKey));
        } catch {
            return;
        }
        try {
            const info = await headS3Object(resolved.settings, key);
            if (info.exists) {
                this.rememberSavedETag(url, info.etag);
            }
        } catch (error) {
            this.web.logs.log("debug", `Could not read the S3 ETag for ${url}: ${errorMessage(error)}`);
        }
    }

    /**
     * Persist re-openable sources (workspace files, URLs) so a reload keeps the
     * engine. Pasted configs stay session-only because they hold API keys.
     */
    private rememberConfigSource(source: ConfigSource): void {
        switch (source.kind) {
            case "path":
                this.web.state.setStoredConfigSource({ kind: "path", path: source.path });
                return;
            case "url":
                this.web.state.setStoredConfigSource({ kind: "url", url: source.url });
                return;
            case "inline":
                return;
        }
    }

    /** Drop a config whose source no longer exists. */
    private forgetLoadedConfig(): void {
        const source = this.configSource;
        if (source?.kind === "path") {
            const stored = this.web.state.getStoredConfigSource();
            if (stored?.kind === "path" && stored.path === source.path) {
                this.web.state.setStoredConfigSource(null);
            }
        }
        this.configSource = null;
        this.attemptedSource = null;
        this.configError = null;
        this.configTextCache = null;
        this.remoteStatus = null;
        this.remoteTextHash = null;
        this.setEngine(null);
    }

    /** Validate config text without applying it (used by the editor). */
    validateConfigText(text: string, label = "pasted config"): ConfigValidation {
        return validateConfigText(this.web.platform, text, label);
    }

    /** Apply pasted config text. Throws when the text is invalid. */
    async applyConfigText(text: string, label = "pasted config"): Promise<Config> {
        const validation = this.validateConfigText(text, label);
        if (!validation.ok) {
            throw new Error(validation.issues.length > 0 ? validation.issues.join("\n") : validation.message);
        }
        return await this.loadConfigSource({ kind: "inline", text, label });
    }

    /**
     * Text of the current config source, for the editor. Null when unavailable.
     * Fetched sources are cached; pass `refresh` to read them again.
     */
    async getConfigText(options?: { refresh?: boolean }): Promise<string | null> {
        const source = this.configSource;
        if (source === null) {
            return null;
        }
        if (source.kind === "path" && !await this.web.platform.fs.exists(source.path)) {
            // The file was deleted (workspace removal or quota eviction). Do not
            // keep an engine alive that can never reload its config.
            this.forgetLoadedConfig();
            return null;
        }
        const cached = this.configTextCache;
        // Files are cheap to reread and may be replaced by an upload, so only
        // URL and inline sources use the cache.
        if (
            options?.refresh !== true &&
            source.kind !== "path" &&
            cached !== null &&
            sameConfigSource(cached.source, source)
        ) {
            return cached.text;
        }
        if (source.kind === "inline") {
            this.configTextCache = { source, text: source.text };
            return source.text;
        }
        try {
            const raw = await loadRawConfig(this.web.platform, source);
            this.configTextCache = { source, text: raw.contents };
            if (source.kind === "url") {
                const nextHash = hashText(raw.contents);
                const changed = this.remoteTextHash !== null && this.remoteTextHash !== nextHash;
                this.remoteTextHash = nextHash;
                this.remoteStatus = {
                    source,
                    fetchedAt: Date.now(),
                    changedAt: changed ? Date.now() : this.remoteStatus?.changedAt ?? null,
                    error: null,
                };
            }
            return raw.contents;
        } catch (error) {
            if (source.kind === "url") {
                this.remoteStatus = {
                    source,
                    fetchedAt: this.remoteStatus?.fetchedAt ?? null,
                    changedAt: this.remoteStatus?.changedAt ?? null,
                    error: errorMessage(error),
                };
            }
            return null;
        }
    }

    private assertValidForSaving(text: string, label: string): void {
        const validation = this.validateConfigText(text, label);
        if (!validation.ok) {
            throw new Error(validation.issues.length > 0 ? validation.issues.join("\n") : validation.message);
        }
    }

    /**
     * Config files a save may overwrite: anything in the durable library, or
     * anywhere inside the active workspace.
     */
    private assertConfigPathWritable(path: string): void {
        const workspace = this.getActiveWorkspace();
        if (isWithinPath(path, this.web.homeDir)) {
            return;
        }
        if (workspace !== null && isWithinPath(path, workspace.path)) {
            return;
        }
        throw new Error(`Refusing to write a config outside the library or the active workspace: ${path}`);
    }

    /** Write config text to an explicit file and make it the engine source. */
    async saveConfigToPath(path: string, text: string): Promise<ConfigSource> {
        this.assertWritable("Saving a config");
        this.assertIdle("Saving a config");
        this.assertConfigPathWritable(path);
        this.assertValidForSaving(text, path);
        await this.web.storageFs.writeText(path, text);
        const next: ConfigSource = { kind: "path", path };
        await this.loadConfigSource(next);
        return next;
    }

    /** Write config text back to the engine's current file. */
    async saveConfigToCurrentSource(text: string): Promise<ConfigSource> {
        const source = this.configSource;
        if (source === null || source.kind !== "path") {
            throw new Error("The current config is not a file. Use Save as instead.");
        }
        return await this.saveConfigToPath(source.path, text);
    }

    /** Write a config into the active workspace, optionally under a new name. */
    async saveConfigToWorkspace(
        text: string,
        relativePath: string = DEFAULT_CONFIG_FILE_NAME,
        options: SaveConfigOptions = {},
    ): Promise<ConfigSource> {
        this.assertWritable("Saving a config");
        this.assertIdle("Saving a config");
        const name = normalizeConfigRelativePath(relativePath);
        const workspace = this.requireActiveWorkspace();
        const path = this.resolveInWorkspace(workspace.path, name);
        if (!options.overwrite && await this.web.storageFs.exists(path)) {
            throw new Error(`"${name}" already exists in this workspace. Choose another name or overwrite it.`);
        }
        this.assertValidForSaving(text, name);
        await this.web.storageFs.writeText(path, text);
        const source: ConfigSource = { kind: "path", path };
        if (options.activate !== false) {
            await this.loadConfigSource(source);
        }
        return source;
    }

    // --- Durable config library ------------------------------------------------

    getHomeDir(): string {
        return this.web.homeDir;
    }

    getDefaultHomeConfig(): string | null {
        return this.web.state.getDefaultHomeConfig();
    }

    /** Library files, default first. */
    async listHomeConfigs(): Promise<HomeConfigFile[]> {
        let entries;
        try {
            entries = await this.web.storageFs.list(this.web.homeDir);
        } catch {
            return [];
        }
        const files = entries
            .filter((entry) => entry.kind === "file" && isTomlFileName(entry.name) && !entry.name.startsWith("."))
            .map((entry) => ({ name: entry.name, size: entry.size, mtimeMs: entry.mtimeMs }));
        const defaultName = this.getDefaultHomeConfig();
        files.sort((a, b) => {
            if (a.name === defaultName) {
                return -1;
            }
            if (b.name === defaultName) {
                return 1;
            }
            return a.name.localeCompare(b.name);
        });
        return files;
    }

    async readHomeConfig(name: string): Promise<string> {
        const path = this.resolveHomeConfigPath(name);
        if (!await this.web.storageFs.exists(path)) {
            throw new Error(this.describeMissingPath(path));
        }
        try {
            return await this.web.storageFs.readText(path);
        } catch (error) {
            if (!await this.web.storageFs.exists(path)) {
                throw new Error(this.describeMissingPath(path, error));
            }
            throw error;
        }
    }

    /** Save a config into the durable library. */
    async saveConfigToHome(
        text: string,
        name: string,
        options: SaveHomeConfigOptions = {},
    ): Promise<ConfigSource> {
        this.assertWritable("Saving a config");
        this.assertIdle("Saving a config");
        const fileName = normalizeConfigFileName(name);
        const path = joinPath(this.web.homeDir, fileName);
        if (!options.overwrite && await this.web.storageFs.exists(path)) {
            throw new Error(`"${fileName}" already exists in the config library. Choose another name or overwrite it.`);
        }
        this.assertValidForSaving(text, fileName);
        await this.web.storageFs.mkdir(this.web.homeDir);
        await this.web.storageFs.writeText(path, text);
        if (options.makeDefault === true) {
            this.web.state.setDefaultHomeConfig(fileName);
        }
        const source: ConfigSource = { kind: "path", path };
        if (options.activate !== false) {
            await this.loadConfigSource(source);
        }
        return source;
    }

    async deleteHomeConfig(name: string): Promise<void> {
        this.assertWritable("Deleting a config");
        this.assertIdle("Deleting a config");
        const fileName = normalizeConfigFileName(name);
        const path = joinPath(this.web.homeDir, fileName);
        if (!await this.web.storageFs.exists(path)) {
            throw new Error(`"${fileName}" does not exist in the config library.`);
        }
        await this.web.storageFs.remove(path);
        await this.deleteEditorDraftKey(editorDraftKey({ kind: "path", path }));
        if (this.getDefaultHomeConfig() === fileName) {
            this.web.state.setDefaultHomeConfig(null);
        }
        const current = this.configSource;
        if (current?.kind === "path" && current.path === path) {
            this.forgetLoadedConfig();
        }
        const attempted = this.attemptedSource;
        if (attempted?.kind === "path" && attempted.path === path) {
            this.attemptedSource = null;
        }
        this.web.logs.log("info", `Removed config library file '${fileName}'.`);
    }

    /** Select the library file used when a workspace has no config. */
    async setDefaultHomeConfig(name: string | null): Promise<void> {
        this.assertWritable("Changing the default config");
        if (name === null) {
            this.web.state.setDefaultHomeConfig(null);
            return;
        }
        const fileName = normalizeConfigFileName(name);
        const path = joinPath(this.web.homeDir, fileName);
        if (!await this.web.storageFs.exists(path)) {
            throw new Error(`"${fileName}" does not exist in the config library.`);
        }
        this.web.state.setDefaultHomeConfig(fileName);
    }

    /** Copy a library config into the active workspace. */
    async copyHomeConfigToWorkspace(
        name: string,
        targetName: string = DEFAULT_CONFIG_FILE_NAME,
        options: SaveConfigOptions = {},
    ): Promise<ConfigSource> {
        const text = await this.readHomeConfig(name);
        return await this.saveConfigToWorkspace(text, targetName, options);
    }

    // --- S3-compatible object storage ------------------------------------------

    /** Current S3 settings, or the exact variables that are still missing. */
    getS3Settings(): S3SettingsResult {
        return resolveS3Settings(this.web.env);
    }

    /**
     * Check the endpoint, credentials, addressing style and CORS/preflight by
     * reading the object key the user is about to save. Using the target key
     * keeps a B2 application key's file-name prefix restriction satisfied.
     * A 404 still means the request itself worked.
     */
    async testS3Connection(objectKey?: string): Promise<S3ConnectionTestResult> {
        const resolved = resolveS3Settings(this.web.env);
        if (!resolved.ok) {
            return { ok: false, message: resolved.message };
        }
        try {
            const relativeKey = normalizeConfigRelativePath(objectKey ?? DEFAULT_CONFIG_FILE_NAME);
            const key = joinS3Key(resolved.settings.prefix, relativeKey);
            await headS3Object(resolved.settings, key);
            return {
                ok: true,
                bucket: resolved.settings.bucket,
                endpoint: resolved.settings.endpoint,
                addressingStyle: resolved.settings.addressingStyle,
                key,
            };
        } catch (error) {
            return { ok: false, message: errorMessage(error) };
        }
    }

    /**
     * Write one config file to the configured S3-compatible bucket. The config
     * is validated before any network call.
     *
     * The concurrency guard is optimistic so it works on every provider: the
     * object is HEADed first and its ETag is compared with the ETag captured
     * when the config was read (a create must not overwrite an existing key).
     * No conditional `If-Match` / `If-None-Match` header is sent, because some
     * providers reject it with `501 NotImplemented`.
     *
     * Limitation: the check is not atomic. A write that lands between the HEAD
     * and the PUT is not detected. {@link SaveConfigToS3Options.force} skips the
     * check entirely.
     */
    async saveConfigToS3(text: string, options: SaveConfigToS3Options = {}): Promise<SavedS3Config> {
        this.assertWritable("Saving a config to S3");
        this.assertIdle("Saving a config to S3");
        const resolved = resolveS3Settings(this.web.env);
        if (!resolved.ok) {
            throw new Error(resolved.message);
        }
        const settings = resolved.settings;
        const relativeKey = normalizeConfigRelativePath(options.key ?? DEFAULT_CONFIG_FILE_NAME);
        const key = joinS3Key(settings.prefix, relativeKey);
        this.assertValidForSaving(text, `s3://${settings.bucket}/${key}`);
        const publicURL = publicS3ObjectUrl(
            settings,
            key,
            this.web.env.get(S3_PUBLIC_BASE_URL_ENV_VAR),
        );
        const checked = !(options.overwrite && options.force);

        if (checked) {
            const expected = publicURL === null
                ? null
                : this.s3ETags.get(normalizedURL(publicURL)) ?? null;
            const existing = await headS3Object(settings, key);
            if (!options.overwrite) {
                if (existing.exists) {
                    throw new Error(
                        `The S3 object "${key}" already exists. Choose another key or enable overwrite.`,
                    );
                }
            } else {
                if (existing.etag === null) {
                    this.web.logs.log(
                        "warn",
                        `The S3 endpoint did not expose an ETag for '${key}'; the concurrency check was skipped.`,
                    );
                }
                if (
                    expected !== null &&
                    existing.etag !== null &&
                    existing.etag !== expected
                ) {
                    throw new Error(
                        "The config changed on S3 since it was read. Reload it and try again, or confirm an overwrite.",
                    );
                }
            }
        }

        const saved = await putS3Object(settings, key, text);
        this.rememberSavedETag(publicURL, saved.etag);
        return this.s3Result(settings, key, saved.etag, checked);
    }

    /** Keep the ETag used for the next overwrite of the same public URL. */
    private rememberSavedETag(publicURL: string | null, etag: string | null): void {
        if (publicURL === null) {
            return;
        }
        const key = normalizedURL(publicURL);
        if (etag !== null && etag.length > 0) {
            this.s3ETags.set(key, etag);
        } else {
            // The write succeeded but the new version is unknown; never reuse
            // the previous ETag, which now describes an older object.
            this.s3ETags.delete(key);
        }
    }

    private s3Result(
        settings: S3Settings,
        key: string,
        etag: string | null,
        checked: boolean,
    ): SavedS3Config {
        const publicURL = publicS3ObjectUrl(
            settings,
            key,
            this.web.env.get(S3_PUBLIC_BASE_URL_ENV_VAR),
        );
        return {
            bucket: settings.bucket,
            key,
            etag,
            url: s3ObjectUrl(settings, key),
            publicURL,
            checked,
        };
    }

    // --- Rename ---------------------------------------------------------------

    async renameHomeConfig(oldName: string, newName: string): Promise<ConfigSource> {
        const oldPath = this.resolveHomeConfigPath(normalizeConfigFileName(oldName));
        const newFileName = normalizeConfigFileName(newName);
        return await this.renameConfigFile(oldPath, newFileName);
    }

    async renameWorkspaceConfig(relativePath: string, newName: string): Promise<ConfigSource> {
        const workspace = this.requireActiveWorkspace();
        const path = this.resolveInWorkspace(workspace.path, normalizeConfigRelativePath(relativePath));
        const newFileName = normalizeConfigFileName(newName);
        return await this.renameConfigFile(path, newFileName);
    }

    /**
     * Rename a config file in place (same directory, flat name). If the file is
     * the loaded source or the library default, the pointers follow it.
     */
    async renameConfigFile(path: string, newName: string): Promise<ConfigSource> {
        this.assertWritable("Renaming a config");
        this.assertIdle("Renaming a config");
        this.assertConfigPathWritable(path);
        const info = await this.web.storageFs.stat(path);
        if (info === null || info.kind !== "file") {
            throw new Error(`Config file not found: ${path}`);
        }
        const fileName = normalizeConfigFileName(newName);
        const target = joinPath(dirnamePath(path), fileName);
        if (target === path) {
            return { kind: "path", path };
        }
        if (await this.web.storageFs.exists(target)) {
            throw new Error(`"${fileName}" already exists in that folder.`);
        }
        const text = await this.web.storageFs.readText(path);
        await this.web.storageFs.writeText(target, text);
        await this.web.storageFs.remove(path);

        const previousName = basenamePath(path);
        if (isWithinPath(path, this.web.homeDir) && this.getDefaultHomeConfig() === previousName) {
            this.web.state.setDefaultHomeConfig(fileName);
        }

        const current = this.configSource;
        const wasCurrent = current?.kind === "path" && current.path === path;
        const next: ConfigSource = { kind: "path", path: target };
        if (wasCurrent) {
            this.configSource = next;
            this.configTextCache = null;
            this.rememberConfigSource(next);
        }
        const attempted = this.attemptedSource;
        if (attempted?.kind === "path" && attempted.path === path) {
            this.attemptedSource = next;
        }
        const stored = this.web.state.getStoredConfigSource();
        if (stored?.kind === "path" && stored.path === path) {
            this.web.state.setStoredConfigSource({ kind: "path", path: target });
        }
        await this.moveEditorDraftKey(editorDraftKey({ kind: "path", path }), editorDraftKey({ kind: "path", path: target }));
        if (wasCurrent) {
            await this.loadConfigSource(next);
        }
        this.web.logs.log("info", `Renamed config '${previousName}' to '${fileName}'.`);
        return next;
    }

    private resolveHomeConfigPath(name: string): string {
        return joinPath(this.web.homeDir, normalizeConfigFileName(name));
    }

    // --- Config discovery -----------------------------------------------------

    /** Config files present in a workspace (defaults to the active one). */
    async detectConfigCandidates(workspacePath?: string): Promise<string[]> {
        const workspace = workspacePath ?? this.getActiveWorkspace()?.path;
        if (workspace === undefined) {
            return [];
        }
        const found: string[] = [];
        for (const candidate of CONFIG_CANDIDATE_NAMES) {
            if (await this.web.storageFs.exists(joinPath(workspace, candidate))) {
                found.push(candidate);
            }
        }
        return found;
    }

    /**
     * Every TOML file a user may open from the workspace, including custom
     * names. Only the priority candidates are auto-adopted; this broader list
     * is for the picker.
     */
    async listWorkspaceConfigFiles(workspacePath?: string): Promise<string[]> {
        const workspace = workspacePath ?? this.getActiveWorkspace()?.path;
        if (workspace === undefined) {
            return [];
        }
        const found = new Set<string>();
        try {
            const entries = await this.web.storageFs.list(workspace);
            for (const entry of entries) {
                if (entry.kind === "file" && isTomlFileName(entry.name) && !entry.name.startsWith(".")) {
                    found.add(entry.name);
                }
            }
            const evalDir = joinPath(workspace, "eval");
            if (await this.web.storageFs.exists(evalDir)) {
                const evalEntries = await this.web.storageFs.list(evalDir);
                for (const entry of evalEntries) {
                    if (entry.kind === "file" && isTomlFileName(entry.name) && !entry.name.startsWith(".")) {
                        found.add(`eval/${entry.name}`);
                    }
                }
            }
        } catch {
            return [];
        }
        const priority = new Map(CONFIG_CANDIDATE_NAMES.map((name, index) => [name, index]));
        return [...found].sort((a, b) => {
            const aPriority = priority.get(a) ?? CONFIG_CANDIDATE_NAMES.length;
            const bPriority = priority.get(b) ?? CONFIG_CANDIDATE_NAMES.length;
            if (aPriority !== bPriority) {
                return aPriority - bPriority;
            }
            return a.localeCompare(b);
        });
    }

    /**
     * Find the config a fresh session should adopt: stored source, environment,
     * active workspace, then the durable library.
     */
    async findConfigSource(): Promise<ConfigSource | null> {
        const stored = this.web.state.getStoredConfigSource();
        if (stored !== null) {
            if (stored.kind === "url") {
                return stored;
            }
            if (await this.web.platform.fs.exists(stored.path)) {
                return stored;
            }
            this.web.state.setStoredConfigSource(null);
        }

        const fromEnv = this.web.env.get(CONFIG_URL_ENV_VAR);
        if (fromEnv !== undefined && fromEnv.trim().length > 0) {
            return toConfigSource(fromEnv.trim());
        }

        const workspace = this.getActiveWorkspace();
        if (workspace !== null) {
            const candidates = await this.detectConfigCandidates(workspace.path);
            const first = candidates[0];
            if (first !== undefined) {
                return { kind: "path", path: joinPath(workspace.path, first) };
            }
        }

        return await this.findLibraryConfigSource();
    }

    /** The durable library's default config, if one can be chosen unambiguously. */
    private async findLibraryConfigSource(): Promise<ConfigSource | null> {
        const home = await this.listHomeConfigs();
        if (home.length === 0) {
            return null;
        }
        const defaultName = this.getDefaultHomeConfig();
        const chosen = defaultName !== null && home.some((file) => file.name === defaultName)
            ? defaultName
            : home.some((file) => file.name === DEFAULT_CONFIG_FILE_NAME)
                ? DEFAULT_CONFIG_FILE_NAME
                : home.length === 1
                    ? home[0]!.name
                    : null;
        return chosen === null ? null : { kind: "path", path: joinPath(this.web.homeDir, chosen) };
    }

    // --- Editor drafts ---------------------------------------------------------

    private get draftsPath(): string {
        return joinPath(this.web.homeDir, ".editor", "drafts.json");
    }

    private async readDraftFile(): Promise<EditorDraftFile> {
        try {
            if (!await this.web.storageFs.exists(this.draftsPath)) {
                return createEmptyEditorDraftFile();
            }
            const text = await this.web.storageFs.readText(this.draftsPath);
            return coerceEditorDraftFile(JSON.parse(text) as unknown);
        } catch {
            return createEmptyEditorDraftFile();
        }
    }

    private async writeDraftFile(file: EditorDraftFile): Promise<void> {
        await this.web.storageFs.writeText(this.draftsPath, JSON.stringify(file, null, 2));
    }

    /** Delete the drafts of a source that no longer exists. */
    private async deleteEditorDraftKey(sourceKey: string): Promise<void> {
        try {
            const file = await this.readDraftFile();
            if (!Object.prototype.hasOwnProperty.call(file.drafts, sourceKey)) {
                return;
            }
            delete file.drafts[sourceKey];
            await this.writeDraftFile(file);
        } catch {
            // Draft cleanup is best-effort; the file operation already succeeded.
        }
    }

    /** Keep a stale draft attached to its file when the file is renamed. */
    private async moveEditorDraftKey(oldKey: string, newKey: string): Promise<void> {
        if (oldKey === newKey) {
            return;
        }
        try {
            const file = await this.readDraftFile();
            const draft = file.drafts[oldKey];
            if (draft === undefined) {
                return;
            }
            delete file.drafts[oldKey];
            file.drafts[newKey] = { ...draft, sourceKey: newKey };
            await this.writeDraftFile(file);
        } catch {
            // Draft cleanup is best-effort.
        }
    }

    async readEditorDrafts(): Promise<EditorDraftFile> {
        return await this.readDraftFile();
    }

    async saveEditorDraft(draft: EditorDraft): Promise<void> {
        this.assertWritable("Saving an editor draft");
        const file = await this.readDraftFile();
        file.drafts[draft.sourceKey] = draft;
        pruneEditorDrafts(file);
        await this.web.storageFs.writeText(this.draftsPath, JSON.stringify(file, null, 2));
    }

    async deleteEditorDraft(sourceKey: string): Promise<void> {
        this.assertWritable("Deleting an editor draft");
        const file = await this.readDraftFile();
        if (!Object.prototype.hasOwnProperty.call(file.drafts, sourceKey)) {
            return;
        }
        delete file.drafts[sourceKey];
        await this.web.storageFs.writeText(this.draftsPath, JSON.stringify(file, null, 2));
    }

    async clearEditorDrafts(): Promise<void> {
        this.assertWritable("Clearing editor drafts");
        await this.web.storageFs.writeText(this.draftsPath, JSON.stringify(createEmptyEditorDraftFile(), null, 2));
    }

    // --- Workspaces ---

    async createWorkspace(label: string, origin: WorkspaceOrigin): Promise<WorkspaceState> {
        this.assertWritable("Creating a workspace");
        this.assertIdle("Creating a workspace");
        const path = joinPath(this.web.storageFs.root, "workspaces", workspaceSlug(label));
        await this.web.storageFs.mkdir(path);
        const now = Date.now();
        const workspace: WorkspaceState = {
            path,
            label,
            origin,
            createdAt: now,
            lastUsedAt: now,
            pinned: false,
        };
        this.web.state.upsertWorkspace(workspace);
        // Go through the regular switch path so engine results belonging to the
        // previous workspace are cleared and the change is logged.
        await this.setActiveWorkspace(path);
        return workspace;
    }

    async setActiveWorkspace(path: string): Promise<void> {
        const workspace = this.web.state.getWorkspace(path);
        if (workspace === null) {
            throw new Error(`Unknown workspace: ${path}`);
        }
        if (this.web.state.get().activeWorkspace === path) {
            return;
        }
        this.assertIdle("Switching workspace");
        this.web.state.setActiveWorkspace(path);
        // Output records belong to the old workspace; the files stay where they are.
        this.engine?.clearResults();
        this.web.logs.log("info", `Active workspace: ${workspace.label}`);
    }

    async removeWorkspace(path: string): Promise<void> {
        this.assertWritable("Removing a workspace");
        this.assertIdle("Removing a workspace");
        const workspace = this.web.state.getWorkspace(path);
        if (workspace === null) {
            throw new Error(`Unknown workspace: ${path}`);
        }
        const wasActive = this.web.state.get().activeWorkspace === workspace.path;
        const configInWorkspace = this.configSource?.kind === "path"
            && isWithinPath(this.configSource.path, workspace.path);
        const attemptedInWorkspace = this.attemptedSource?.kind === "path"
            && isWithinPath(this.attemptedSource.path, workspace.path);

        await this.web.storageFs.remove(workspace.path, { recursive: true });
        this.web.state.removeWorkspace(workspace.path);
        const stored = this.web.state.getStoredConfigSource();
        if (stored !== null && stored.kind === "path" && isWithinPath(stored.path, workspace.path)) {
            this.web.state.setStoredConfigSource(null);
        }
        if (attemptedInWorkspace) {
            this.attemptedSource = null;
        }
        if (configInWorkspace) {
            // The file the engine reloads from no longer exists; do not leave a
            // "config loaded" badge pointing at a deleted path.
            this.forgetLoadedConfig();
        } else if (wasActive) {
            this.engine?.clearResults();
        }
    }

    setWorkspacePinned(path: string, pinned: boolean): void {
        this.web.state.setPinned(path, pinned);
    }

    /**
     * Whether a workspace's directory is still present in storage. A workspace
     * that only exists in the index (evicted, or created by another tab this
     * read-only session cannot see yet) has no files to list, which is not the
     * same thing as an empty workspace.
     */
    async workspaceExists(workspacePath?: string): Promise<boolean> {
        const path = workspacePath ?? this.getActiveWorkspace()?.path;
        if (path === undefined) {
            return false;
        }
        return await this.web.storageFs.exists(path);
    }

    /** Files in a workspace, as workspace-relative paths. */
    async listFiles(workspacePath?: string): Promise<WorkspaceFile[]> {
        const root = workspacePath ?? this.getActiveWorkspace()?.path;
        if (root === undefined) {
            return [];
        }
        const results: WorkspaceFile[] = [];

        // A removed or not-yet-created workspace simply has no files.
        if (!await this.web.storageFs.exists(root)) {
            return results;
        }

        const walk = async (directory: string, relative: string, depth: number): Promise<void> => {
            if (depth > MAX_WORKSPACE_WALK_DEPTH) {
                return;
            }
            const entries = await this.web.storageFs.list(directory);
            for (const entry of entries) {
                if (entry.name.startsWith(".")) {
                    continue;
                }
                const childRelative = relative.length === 0 ? entry.name : `${relative}/${entry.name}`;
                if (entry.kind === "directory") {
                    await walk(joinPath(directory, entry.name), childRelative, depth + 1);
                } else {
                    results.push({ path: childRelative, size: entry.size, mtimeMs: entry.mtimeMs });
                }
            }
        };

        await walk(root, "", 1);
        return results.sort((a, b) => a.path.localeCompare(b.path));
    }

    // --- Sources ---

    /** Fetch a GitHub URL or repository into a workspace. */
    async fetchSource(request: FetchSourceRequest): Promise<FetchSourceSummary> {
        this.assertWritable("Fetching a source");
        this.assertIdle("Fetching a source");
        const label = request.label ?? (request.kind === "url" ? labelFromUrl(request.url) : labelForRepo(request));

        const env: EnvVars = this.web.env.all();
        // A token on the request wins over the environment, like the CLI's --token.
        if (request.token !== undefined && request.token.trim().length > 0) {
            env[GITHUB_PAT_ENV_VAR] = request.token.trim();
        }
        const notes = { onNote: (message: string): void => this.web.logs.log("info", message) };

        // Plan first: an invalid URL must not leave an empty workspace behind.
        const plan = request.kind === "url"
            ? await githubRemote.plan(request.url, env, notes)
            : await planGithubDownload({
                owner: request.owner,
                repo: request.repo,
                ref: request.ref,
                path: request.directory,
                mode: request.mode,
            }, env, notes);

        const previousActive = this.web.state.get().activeWorkspace;
        const workspace = await this.resolveFetchWorkspace(request, label);
        let summary: DownloadSummary;
        try {
            summary = await runDownload(plan, {
                outputDir: workspace.path,
                skipExisting: false,
                concurrency: DOWNLOAD_CONCURRENCY,
                fs: this.web.storageFs,
                maxFileBytes: this.web.state.getStorageSettings().maxFileBytes,
            });
        } catch (error) {
            // A newly created workspace exists only for this fetch; remove it so
            // a failed URL does not leave an unusable entry in the list.
            if (request.workspacePath === undefined) {
                await this.web.storageFs.remove(workspace.path, { recursive: true });
                this.web.state.removeWorkspace(workspace.path);
                if (previousActive !== null && this.web.state.getWorkspace(previousActive) !== null) {
                    this.web.state.setActiveWorkspace(previousActive);
                }
            }
            throw error;
        }
        this.web.state.touchWorkspace(workspace.path);

        const configCandidates = await this.detectConfigCandidates(workspace.path);
        let configLoaded: string | null = null;
        let configError: string | null = null;
        const first = configCandidates[0];
        // A new workspace is defined by its repository: adopt its config even
        // when another config was loaded before. An explicitly targeted
        // workspace keeps the current config unless none is loaded.
        if (first !== undefined && (request.workspacePath === undefined || !this.hasConfig())) {
            try {
                await this.loadConfigSource({ kind: "path", path: joinPath(workspace.path, first) });
                configLoaded = first;
            } catch (error) {
                configError = errorMessage(error);
                this.web.logs.log("warn", `Could not load the fetched config '${first}': ${configError}`);
                if (!this.hasConfig()) {
                    this.configError = configError;
                }
            }
        }

        // A repository without a config, or an upload into a fresh workspace,
        // still needs something to run. Fall back to the durable library.
        if (!this.hasConfig()) {
            const homeSource = await this.findLibraryConfigSource();
            if (homeSource !== null) {
                try {
                    await this.loadConfigSource(homeSource);
                    configLoaded = homeSource.kind === "path" ? basenamePath(homeSource.path) : null;
                } catch (error) {
                    const message = errorMessage(error);
                    this.web.logs.log("warn", `Could not load the library config: ${message}`);
                }
            }
        }

        return { workspace, plan, summary, configCandidates, configLoaded, configError };
    }

    /**
     * Workspace a fetch writes into: the requested one (which must exist, and
     * becomes active), otherwise a freshly created workspace.
     */
    private async resolveFetchWorkspace(request: FetchSourceRequest, label: string): Promise<WorkspaceState> {
        if (request.workspacePath === undefined) {
            return await this.createWorkspace(label, "github");
        }
        const workspace = this.web.state.getWorkspace(request.workspacePath);
        if (workspace === null) {
            throw new Error(`Unknown workspace: ${request.workspacePath}`);
        }
        await this.setActiveWorkspace(workspace.path);
        return workspace;
    }

    /** Write uploaded files into a workspace (defaults to the active one). */
    async uploadFiles(files: UploadedFile[], targetDirectory = ""): Promise<UploadSummary> {
        this.assertWritable("Uploading files");
        this.assertIdle("Uploading files");
        const workspace = this.requireActiveWorkspace();
        const target = this.resolveInWorkspace(workspace.path, sanitizeTargetDirectory(targetDirectory));
        let written = 0;
        let bytes = 0;

        for (const file of files) {
            const safeName = sanitizeRelativePath(file.name);
            if (safeName.length === 0) {
                continue;
            }
            await this.web.storageFs.writeBytes(this.resolveInWorkspace(target, safeName), file.bytes);
            written++;
            bytes += file.bytes.byteLength;
        }

        this.web.state.touchWorkspace(workspace.path);
        return { workspace, written, bytes };
    }

    /** Resolve a workspace-relative path, refusing anything outside the workspace. */
    private resolveInWorkspace(workspacePath: string, relative: string): string {
        const target = resolvePath(workspacePath, relative);
        if (!isWithinPath(target, workspacePath)) {
            throw new Error(`Path '${relative}' is outside the workspace.`);
        }
        return target;
    }

    // --- Running ---

    /** Run workflows through the engine (requires a loaded config). */
    async runWorkflows(filters?: { only?: string[]; skip?: string[] }): Promise<WorkflowRunResult[]> {
        this.assertWritable("Running workflows");
        if (this.configSource?.kind === "url") {
            // The remote file is the shared source of truth. Failure is
            // non-fatal: the status explains it and the last config still runs.
            await this.refreshRemoteConfig();
        }
        const engine = this.requireEngine();
        const results = await engine.runWorkflows(filters);
        this.web.state.touchWorkspace(this.requireActiveWorkspace().path);
        return results;
    }

    /**
     * Header for `ls`: which workspace a run searches and which config drives
     * it. Those two answers cover most "No files found for workflow" reports.
     */
    private describeListingContext(): string[] {
        const workspace = this.getActiveWorkspace();
        const loaded = this.getConfigSource();
        const source = loaded ?? this.getAttemptedConfigSource();
        let config = "(none loaded)";
        if (source !== null) {
            config = configSourceLabel(source);
            if (loaded === null) {
                config += " (failed to load)";
            }
        }
        return [
            `Workspace: ${workspace === null ? "(none active)" : workspace.label}`,
            `Config: ${config}`,
        ];
    }

    /**
     * Run a console command through the same dispatcher the CLI REPL uses, with
     * the browser's workspace-aware context: `ls` reports the workspace and
     * config, `clear`/`rerun` delete the files, and `exit` explains why it does
     * nothing here.
     */
    async executeCommand(line: string): Promise<CommandResult> {
        const trimmed = line.trim();
        if (trimmed.length === 0) {
            return { kind: "output", message: "" };
        }

        const [command, ...args] = trimmed.split(/\s+/);
        const normalized = command!.toLowerCase();
        this.web.state.appendConsoleHistory(trimmed);

        if (this.engine === null) {
            // `ls` is handled before the config check: inspecting the workspace
            // is how a wrong search_directory, a flattened subdirectory fetch,
            // or a config that failed to load actually gets diagnosed.
            if (normalized === "ls") {
                return await executeLs(this.web.platform.fs, args, { header: this.describeListingContext() });
            }
            if (normalized === "help") {
                return { kind: "output", message: `${helpText("web")}${BROWSER_HELP_SUFFIX}` };
            }
            return {
                kind: "error",
                message: "No config loaded yet. 'ls' can still list the workspace. Pick a config source in the Config panel (or paste one) and try again.",
            };
        }

        try {
            return await parseAndExecute(this.engine, trimmed, {
                host: "web",
                lsHeader: this.describeListingContext(),
                knownOutputs: () => this.existingRecordedOutputs(),
                clearOutputs: (names) => this.clearOutputFiles(names),
                exitMessage: "The browser console cannot close the page; close the tab instead.",
            });
        } catch (error) {
            const message = errorMessage(error);
            this.web.logs.log("warn", message);
            return { kind: "error", message };
        }
    }

    // --- Outputs ---

    /** Files that finished runs wrote into a workspace (defaults to the active one). */
    getRecordedOutputs(workspacePath?: string): string[] {
        const path = workspacePath ?? this.getActiveWorkspace()?.path;
        return path === undefined ? [] : this.web.state.getWorkspaceOutputs(path);
    }

    /** Recorded output files that still exist in the active workspace. */
    private async existingRecordedOutputs(): Promise<string[]> {
        const workspace = this.getActiveWorkspace();
        if (workspace === null) {
            return [];
        }
        const existing: string[] = [];
        for (const name of this.getRecordedOutputs(workspace.path)) {
            const info = await this.web.storageFs.stat(joinPath(workspace.path, name));
            if (info !== null && info.kind === "file") {
                existing.push(name);
            }
        }
        return existing;
    }

    /**
     * Delete the recorded output files (optionally only those of the given
     * workflow slugs) and drop them from the engine's result list. Files no run
     * wrote — config and sources — are never touched.
     */
    async clearRecordedOutputs(slugs?: string[]): Promise<string[]> {
        this.assertWritable("Clearing outputs");
        this.assertIdle("Clearing outputs");
        const workspace = this.requireActiveWorkspace();
        const engine = this.engine;
        const recorded = this.getRecordedOutputs(workspace.path);
        const filter = slugs !== undefined && slugs.length > 0 ? slugs : undefined;
        const names = engine === null || filter === undefined
            ? recorded
            : engine.resolveOutputFileNames(recorded, filter);
        const removed = await this.clearOutputFiles(names);
        if (engine !== null) {
            if (filter === undefined) {
                engine.clearResults();
            } else if (removed.length > 0) {
                engine.clearResultFiles(removed);
            }
        }
        return removed;
    }

    /** Delete exactly these workspace-relative files. Returns the names removed. */
    async clearOutputFiles(names: readonly string[]): Promise<string[]> {
        this.assertWritable("Clearing outputs");
        this.assertIdle("Clearing outputs");
        const workspace = this.requireActiveWorkspace();
        const removed: string[] = [];

        for (const name of names) {
            const relative = sanitizeRelativePath(name);
            if (relative.length === 0) {
                continue;
            }
            const target = this.resolveInWorkspace(workspace.path, relative);
            if (!await this.web.storageFs.exists(target)) {
                continue;
            }
            await this.web.storageFs.remove(target);
            removed.push(relative);
        }

        if (removed.length > 0) {
            this.web.state.clearWorkspaceOutputs(workspace.path, removed);
        }
        return removed;
    }

    /** Remove every file in a workspace, keeping the workspace itself. */
    async clearWorkspace(path?: string): Promise<void> {
        this.assertWritable("Clearing a workspace");
        this.assertIdle("Clearing a workspace");
        const workspace = path !== undefined ? this.web.state.getWorkspace(path) : this.getActiveWorkspace();
        if (workspace === null) {
            throw new Error(`Unknown workspace: ${path ?? "(none active)"}`);
        }
        await this.web.storageFs.remove(workspace.path, { recursive: true });
        await this.web.storageFs.mkdir(workspace.path);
        this.web.state.clearWorkspaceOutputs(workspace.path);
        this.web.logs.log("info", `Workspace '${workspace.label}' files cleared.`);
    }

    // --- Chat sessions --------------------------------------------------------

    /**
     * Recorded chat sessions, newest first. Defaults to the active workspace;
     * pass `null` to list every workspace.
     */
    async listSessions(workspacePath?: string | null): Promise<ChatSessionSummary[]> {
        const sessions = await this.sessionStore.listSummaries();
        const scope = workspacePath === undefined ? this.getActiveWorkspace()?.path ?? null : workspacePath;
        return scope === null ? sessions : sessions.filter((session) => session.workspace === scope);
    }

    async readSession(id: string): Promise<ChatSession | null> {
        return await this.sessionStore.read(id);
    }

    /** Send a chat message. Requires a loaded config and write access. */
    async chatSession(
        id: string,
        text: string,
        handlers: ChatStreamHandlers = {},
        signal?: AbortSignal,
    ): Promise<ChatOutcome> {
        this.assertWritable("Chatting");
        return await this.requireEngine().chatSession(id, text, handlers, signal);
    }

    async regenerateSession(
        id: string,
        handlers: ChatStreamHandlers = {},
        signal?: AbortSignal,
    ): Promise<ChatOutcome> {
        this.assertWritable("Chatting");
        return await this.requireEngine().regenerateSession(id, handlers, signal);
    }

    async editSessionMessage(
        id: string,
        messageIndex: number,
        text: string,
        handlers: ChatStreamHandlers = {},
        signal?: AbortSignal,
    ): Promise<ChatOutcome> {
        this.assertWritable("Editing a chat message");
        return await this.requireEngine().editSessionMessage(id, messageIndex, text, handlers, signal);
    }

    async deleteSession(id: string): Promise<boolean> {
        this.assertWritable("Deleting a chat session");
        if (this.engine === null) {
            return await this.sessionStore.delete(id);
        }
        return await this.engine.deleteSession(id);
    }

    /** Remove every recorded session. Returns the ids removed. */
    async clearSessions(): Promise<string[]> {
        this.assertWritable("Clearing chat sessions");
        return await this.sessionStore.clear();
    }

    // --- Storage ---

    async getUsage(): Promise<StorageUsage> {
        return {
            used: await this.web.quota.usage(),
            cap: this.web.state.getStorageSettings().maxTotalBytes,
        };
    }

    /**
     * The browser's own storage estimate for the whole site, when it exposes
     * one. Kept separate from {@link getUsage}: it is origin-wide, on disk and
     * approximate, so it must not drive EPF's quota bar.
     */
    async getBrowserEstimate(): Promise<BrowserStorageEstimate | null> {
        return await storageEstimate();
    }

    private requireEngine(): Engine {
        if (this.engine === null) {
            throw new Error("No config loaded. Choose a config source before running workflows.");
        }
        return this.engine;
    }
}

/** Canonical URL form, for matching a public config URL to its S3 object. */
function normalizedURL(value: string): string {
    try {
        return new URL(value).toString();
    } catch {
        return value;
    }
}

/** Filesystem-safe, collision-resistant directory name for a workspace label. */
function workspaceSlug(label: string): string {
    const base = label
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40);
    const suffix = Math.random().toString(36).slice(2, 7);
    return `${base.length > 0 ? base : "workspace"}-${suffix}`;
}

function labelFromUrl(url: string): string {
    const parsed = parseGithubUrl(url);
    if (parsed === null) {
        return url;
    }
    if (parsed.mode === "pull") {
        return `${parsed.owner}/${parsed.repo}#pull/${parsed.pullNumber}`;
    }
    return `${parsed.owner}/${parsed.repo}@${parsed.refAndPath}`;
}

function labelForRepo(request: { owner: string; repo: string; ref?: string; directory?: string }): string {
    const ref = request.ref !== undefined && request.ref.length > 0 ? request.ref : "default";
    const location = request.directory !== undefined && request.directory.length > 0
        ? `${ref}:${request.directory}`
        : ref;
    return `${request.owner}/${request.repo}@${location}`;
}

/** Keep uploads inside the workspace: drop absolute prefixes and `..` segments. */
export function sanitizeRelativePath(name: string): string {
    const normalized = name.replace(/\\/g, "/").replace(/^\/+/, "");
    const segments = normalized
        .split("/")
        .filter((segment) => segment.length > 0 && segment !== "." && segment !== "..");
    return segments.join("/");
}

/**
 * Normalize a user-supplied upload directory. Unlike file names (which are
 * silently made safe), a target directory that tries to leave the workspace is
 * reported as an error: it means the user asked for something we will not do.
 */
export function sanitizeTargetDirectory(directory: string): string {
    const normalized = directory.replace(/\\/g, "/").trim();
    if (normalized.length === 0) {
        return "";
    }
    if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
        throw new Error(`Upload target must be relative to the workspace, not '${directory}'.`);
    }
    const segments = normalized.split("/").filter((segment) => segment.length > 0 && segment !== ".");
    if (segments.includes("..")) {
        throw new Error(`Upload target must stay inside the workspace, not '${directory}'.`);
    }
    return segments.join("/");
}

/** True when two config sources point at the same place. */
function sameConfigSource(a: ConfigSource, b: ConfigSource): boolean {
    if (a.kind !== b.kind) {
        return false;
    }
    switch (a.kind) {
        case "path":
            return a.path === (b as { path: string }).path;
        case "url":
            return a.url === (b as { url: string }).url;
        case "inline":
            return a.text === (b as { text: string }).text;
    }
}

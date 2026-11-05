/**
 * Browser session for EPF.
 *
 * Owns the single `WebEPF` instance (browser filesystem, engine, workspaces)
 * and exposes it as Svelte stores. A module-level singleton, so the console
 * page and the results viewer share one session and one filesystem.
 *
 * EPF itself is imported lazily: nothing on this page's route is downloaded
 * until the session is actually created.
 */

import { writable } from "svelte/store";

import { fileTypeFor } from "$lib/results/file-sources";

import { COMMAND_NAMES } from "$epf/command-handler.ts";
import { isStorageLockFree } from "$epf/platform/web/storage-lock.ts";
import { ENV_VARS } from "$epf/util/env-vars.ts";
import { errorMessage } from "$epf/util/errors.ts";

import type {
	WebEPF,
	BrowserStorageEstimate,
	FetchSourceRequest,
	FetchSourceSummary,
	HomeConfigFile,
	OpenedConfigDocument,
	RemoteConfigStatus,
	S3ConnectionTestResult,
	SaveConfigOptions,
	SaveConfigToS3Options,
	SaveHomeConfigOptions,
	SavedS3Config,
	StorageUsage,
	UploadedFile,
	WorkspaceFile
} from "$epf/hosts/web-host.ts";
import type { CommandResult } from "$epf/command-handler.ts";
import type { Engine, WorkflowRunResult } from "$epf/engine/engine.ts";
import type { LogEntry } from "$epf/platform/types.ts";
import type { StorageSettings, WorkspaceOrigin, WorkspaceState } from "$epf/platform/web/web-state.ts";
import type { WriteBlockReason } from "$epf/platform/web/web-platform.ts";
import type { ConfigSource, ConfigValidation } from "$epf/util/config-loader.ts";
import type { S3SettingsResult } from "$epf/util/s3.ts";
import { userMessage } from "$epf/util/chat-session.ts";
import { cloneSession, lastUserIndex, truncateSession } from "$epf/util/chat-service.ts";
import type { ChatSession, ChatSessionSummary } from "$epf/util/chat-session.ts";
import type { ChatStreamHandlers } from "$epf/util/llm.ts";
import type { ChatOutcome } from "$epf/util/chat-service.ts";
import type { EditorDraft, EditorDraftFile } from "$epf/util/editor-draft.ts";
import type { ResultFileContent, ResultFileEntry } from "$lib/results/file-sources";

const LOG_LIMIT = 2000;
/** Commands that can change the config text; everything else keeps the cached copy. */
const CONFIG_REFRESHING_COMMANDS = new Set(["reload"]);

export type EnvVarValue = {
	name: string;
	value: string;
	persisted: boolean;
};

/** Live output of a streaming chat turn. */
export type ChatStreamingState = {
	active: boolean;
	text: string;
	reasoning: string;
};

class EpfSession {
	readonly busy = writable(false);
	readonly error = writable<string | null>(null);
	readonly persistent = writable(true);
	readonly soleOwner = writable(true);
	/** Why this tab cannot write to browser storage, or null when it owns it. */
	readonly writeBlocked = writable<WriteBlockReason | null>(null);
	/** True when the active workspace has no directory in storage (evicted or not yet visible). */
	readonly workspaceMissing = writable(false);
	readonly logs = writable<LogEntry[]>([]);
	readonly status = writable<{ inFlight: string[]; completedFiles: string[] }>({
		inFlight: [],
		completedFiles: []
	});
	readonly workspaces = writable<WorkspaceState[]>([]);
	readonly activeWorkspace = writable<WorkspaceState | null>(null);
	readonly configLoaded = writable(false);
	readonly configSource = writable<ConfigSource | null>(null);
	readonly attemptedConfigSource = writable<ConfigSource | null>(null);
	readonly remoteConfig = writable<RemoteConfigStatus | null>(null);
	readonly configText = writable("");
	readonly configIssues = writable<string[]>([]);
	readonly homeConfigs = writable<HomeConfigFile[]>([]);
	readonly defaultHomeConfig = writable<string | null>(null);
	readonly files = writable<WorkspaceFile[]>([]);
	readonly usage = writable<StorageUsage | null>(null);
	/**
	 * The browser's own storage figure for the whole site. Deliberately not
	 * refreshed by routine actions: it is approximate and on disk, so it moves
	 * for reasons EPF does not control. `refreshBrowserEstimate()` is called at
	 * session start and on demand from the Storage panel.
	 */
	readonly browserEstimate = writable<BrowserStorageEstimate | null>(null);
	readonly lastResults = writable<WorkflowRunResult[]>([]);
	readonly envValues = writable<EnvVarValue[]>([]);
	readonly initialized = writable(false);
	/** Bumped by clearLog() so the console can rebuild its terminal. */
	readonly consoleEpoch = writable(0);
	/** Recorded chat sessions for the active workspace. */
	readonly chatSessions = writable<ChatSessionSummary[]>([]);
	readonly activeChatSession = writable<ChatSession | null>(null);
	readonly chatStreaming = writable<ChatStreamingState>({ active: false, text: "", reasoning: "" });
	readonly chatBusy = writable(false);
	readonly chatError = writable<string | null>(null);

	private epf: WebEPF | null = null;
	private creating: Promise<WebEPF> | null = null;
	private access: "read-write" | "read-only" = "read-write";
	private busyCount = 0;
	private logBuffer: LogEntry[] = [];
	private activeChatId: string | null = null;
	/** Mirror of `activeChatSession` for optimistic updates during a stream. */
	private activeSession: ChatSession | null = null;
	private chatAbort: AbortController | null = null;
	private chatRunning = false;
	private readonly logListeners: Set<(entry: LogEntry) => void> = new Set();
	private unsubscribeLogs: (() => void) | null = null;
	private unsubscribeEngineChange: (() => void) | null = null;
	private unsubscribeEngineEvents: (() => void) | null = null;
	/** Output contents keyed by path, invalidated when the file's mtime changes. */
	private readonly outputCache = new Map<string, { key: string; content: ResultFileContent }>();

	/** Current log lines, e.g. to replay into a freshly mounted console. */
	getLogSnapshot(): LogEntry[] {
		return [...this.logBuffer];
	}

	/**
	 * Whether taking over storage would work right now (the owning tab is gone).
	 * Used by the "Take over storage" button, which must not offer itself while
	 * another tab still holds the lock.
	 */
	async canTakeOverStorage(): Promise<boolean> {
		if (this.epf === null || this.epf.web.writeBlockedBy === null) {
			return false;
		}
		try {
			return await isStorageLockFree();
		} catch {
			return false;
		}
	}

	/** Called for each new log line. Returns an unsubscribe function. */
	subscribeLogs(listener: (entry: LogEntry) => void): () => void {
		this.logListeners.add(listener);
		return () => {
			this.logListeners.delete(listener);
		};
	}

	/**
	 * Create the session on first use and refresh every store.
	 *
	 * The results viewer passes `writeAccess: false`, so it reads the persisted
	 * store without taking the write lock from the tab that owns it.
	 */
	async ensure(options: { writeAccess?: boolean } = {}): Promise<WebEPF> {
		const wantWrite = options.writeAccess ?? true;

		if (this.epf !== null) {
			if (!(wantWrite && this.access === "read-only")) {
				return this.epf;
			}
			// Upgrading to write access replaces the session. It must not happen
			// while another tab owns storage: the replacement would be read-only
			// too, so the only thing the swap achieves is losing the mount that
			// currently shows the user's files.
			if (this.epf.web.writeBlockedBy !== null && !await isStorageLockFree()) {
				// The actionable reason on the EPF page is the other tab, even when
				// this session started as a read-only viewer.
				this.writeBlocked.set("another-tab");
				return this.epf;
			}
			// The EPF page needs write access even if a viewer opened the session first.
			this.detach();
			this.epf = null;
		}

		if (this.creating === null) {
			this.creating = this.createSession(wantWrite);
		}
		try {
			return await this.creating;
		} finally {
			this.creating = null;
		}
	}

	/**
	 * Session for internal refreshes: never triggers a read-only -> read-write
	 * upgrade (that would await the creation promise we are already inside).
	 */
	private async requireSession(): Promise<WebEPF> {
		if (this.epf !== null) {
			return this.epf;
		}
		return await this.ensure();
	}

	private async createSession(writeAccess: boolean): Promise<WebEPF> {
		this.beginBusy();
		try {
			const module = await import("$epf/hosts/web-host.ts");
			const epf = await module.WebEPF.create({ access: writeAccess ? "read-write" : "read-only" });
			this.epf = epf;
			// The platform decides: a write-intent tab that could not take the
			// storage lock comes back read-only (but still able to read the store).
			this.access = epf.web.readOnly ? "read-only" : "read-write";
			this.attach(epf);
			this.persistent.set(epf.web.persistent);
			this.soleOwner.set(epf.web.soleOwner);
			this.writeBlocked.set(epf.web.writeBlockedBy);
			// The platform logs why storage is read-only (viewer, another tab) or
			// memory-only (unavailable); no need to repeat it here.
			await this.refreshAll();
			await this.refreshBrowserEstimate();
			this.error.set(null);
			return epf;
		} catch (err) {
			const message = errorMessage(err);
			this.error.set(message);
			throw err;
		} finally {
			this.endBusy();
			this.initialized.set(true);
		}
	}

	/**
	 * Replace a read-only session with a writable one, now that the tab that
	 * owned browser storage is gone. Safe to call while still blocked: it
	 * reports the reason instead of swapping the session for an empty one.
	 */
	async takeOverStorage(): Promise<void> {
		if (this.creating !== null) {
			return;
		}
		const current = this.epf;
		if (current !== null && current.web.writeBlockedBy === null) {
			return;
		}
		if (!await isStorageLockFree()) {
			throw new Error("Another tab is still using browser storage. Close it, then try again.");
		}
		this.writeBlocked.set(null);
		this.detach();
		this.epf = null;
		this.access = "read-only";
		await this.ensure();
	}

	/** Drop listeners so a session can be replaced. */
	private detach(): void {
		this.chatAbort?.abort();
		this.chatAbort = null;
		this.unsubscribeLogs?.();
		this.unsubscribeLogs = null;
		this.unsubscribeEngineChange?.();
		this.unsubscribeEngineChange = null;
		this.unsubscribeEngineEvents?.();
		this.unsubscribeEngineEvents = null;
		this.epf?.web.state.dispose();
	}

	private attach(epf: WebEPF): void {
		this.logBuffer = epf.web.logs.getEntries().slice(-LOG_LIMIT);
		this.logs.set([...this.logBuffer]);
		this.unsubscribeLogs?.();
		this.unsubscribeLogs = epf.web.logs.subscribe((entry) => {
			this.logBuffer = [...this.logBuffer, entry].slice(-LOG_LIMIT);
			this.logs.set(this.logBuffer);
			for (const listener of this.logListeners) {
				try {
					listener(entry);
				} catch (error) {
					console.error("log listener failed", error);
				}
			}
		});

		this.unsubscribeEngineChange?.();
		this.unsubscribeEngineChange = epf.onEngineChange((engine) => this.attachEngine(engine));
		this.attachEngine(epf.getEngine());
	}

	private attachEngine(engine: Engine | null): void {
		this.unsubscribeEngineEvents?.();
		this.unsubscribeEngineEvents = null;
		if (engine === null) {
			this.status.set({ inFlight: [], completedFiles: [] });
			return;
		}
		this.unsubscribeEngineEvents = engine.addEventListener((event) => {
			if (event.type === "files-changed") {
				void this.refreshOutputs();
			}
			if (event.type === "session-changed") {
				void this.refreshChatSessions();
			}
		});
		this.refreshStatus();
	}

	// --- Refresh helpers ---

	async refreshAll(): Promise<void> {
		await Promise.all([
			this.refreshWorkspaces(),
			this.refreshOutputs(),
			this.refreshUsage(),
			this.refreshConfig(),
			this.refreshHomeConfigs(),
			this.refreshChatSessions()
		]);
		this.refreshEnvValues();
	}

	async refreshHomeConfigs(): Promise<void> {
		const epf = await this.requireSession();
		this.homeConfigs.set(await epf.listHomeConfigs());
		this.defaultHomeConfig.set(epf.getDefaultHomeConfig());
	}

	refreshEnvValues(): void {
		this.envValues.set(this.listEnvValues());
	}

	async refreshWorkspaces(): Promise<void> {
		const epf = await this.requireSession();
		// A viewer tab keeps no live link to the owner tab; reread the persisted
		// index so newly created or removed workspaces show up while polling.
		if (epf.web.readOnly) {
			epf.web.state.reloadFromStorage();
		}
		this.workspaces.set(epf.listWorkspaces());
		this.activeWorkspace.set(epf.getActiveWorkspace());
	}

	async refreshOutputs(): Promise<void> {
		const epf = await this.requireSession();
		const workspace = epf.getActiveWorkspace();
		// A workspace that exists in the index but not in storage has no files to
		// show; that is not the same thing as an empty workspace, and the panel
		// must say which one it is.
		const exists = workspace === null ? false : await epf.workspaceExists(workspace.path);
		this.workspaceMissing.set(workspace !== null && !exists);
		this.files.set(exists ? await epf.listFiles() : []);
	}

	async refreshUsage(): Promise<void> {
		const epf = await this.requireSession();
		this.usage.set(await epf.getUsage());
	}

	/** Re-read the browser's whole-site estimate (Storage panel / manual refresh). */
	async refreshBrowserEstimate(): Promise<void> {
		const epf = await this.requireSession();
		this.browserEstimate.set(await epf.getBrowserEstimate());
	}

	async refreshConfig(options: { refresh?: boolean } = {}): Promise<void> {
		const epf = await this.requireSession();
		const text = await epf.getConfigText(options);
		this.configLoaded.set(epf.hasConfig());
		const source = epf.getConfigSource();
		this.configSource.set(source);
		this.attemptedConfigSource.set(epf.getAttemptedConfigSource());
		this.remoteConfig.set(epf.getRemoteConfigStatus());
		if (text !== null) {
			this.configText.set(text);
		} else if (!epf.hasConfig()) {
			this.configText.set("");
		}
		this.configIssues.set(this.configIssuesFromError(epf.getConfigError()));
		this.refreshStatus();
	}

	/**
	 * Re-fetch the URL config. Returns the freshness status instead of throwing:
	 * a failed refresh keeps the last loaded config usable.
	 */
	async refreshRemoteConfig(): Promise<RemoteConfigStatus | null> {
		const epf = await this.ensure();
		const status = await epf.refreshRemoteConfig();
		this.remoteConfig.set(status);
		await this.refreshConfig();
		return status;
	}

	refreshStatus(): void {
		if (this.epf === null) {
			return;
		}
		const engine = this.epf.getEngine();
		if (engine === null) {
			this.status.set({ inFlight: [], completedFiles: [] });
			return;
		}
		this.status.set(engine.getStatus());
	}

	private configIssuesFromError(message: string | null): string[] {
		if (message === null || message.length === 0) {
			return [];
		}
		return message.split("\n");
	}

	// --- Config ---

	validateConfigText(text: string): ConfigValidation {
		if (this.epf === null) {
			return { ok: false, message: "Session is still starting.", issues: [], structuredIssues: [] };
		}
		return this.epf.validateConfigText(text, "pasted config");
	}

	async applyConfigText(text: string, label = "session config"): Promise<void> {
		const epf = await this.ensure();
		await this.withBusy(async () => {
			await epf.applyConfigText(text, label);
		});
		await this.refreshConfig();
	}

	/** Load a config from a source and make it the active one. */
	async loadConfigSource(source: ConfigSource): Promise<void> {
		const epf = await this.ensure();
		await this.withBusy(async () => {
			await epf.loadConfigSource(source);
		});
		await this.refreshAll();
	}

	/** Every TOML file in the active workspace, for the editor's picker. */
	async listWorkspaceConfigFiles(): Promise<string[]> {
		const epf = await this.ensure();
		return await epf.listWorkspaceConfigFiles();
	}

	/** Read a config for editing without applying it to the engine. */
	async openConfigDocument(source: ConfigSource): Promise<OpenedConfigDocument> {
		const epf = await this.ensure();
		return await epf.openConfigDocument(source);
	}

	getHomeDir(): string {
		return this.epf?.getHomeDir() ?? "";
	}

	async readHomeConfig(name: string): Promise<string> {
		const epf = await this.ensure();
		return await epf.readHomeConfig(name);
	}

	async saveConfigToPath(path: string, text: string): Promise<ConfigSource> {
		const epf = await this.ensure();
		const source = await this.withBusy(async () => await epf.saveConfigToPath(path, text));
		await this.refreshAll();
		return source;
	}

	async saveConfigToWorkspace(
		text: string,
		name: string,
		options: SaveConfigOptions = {}
	): Promise<ConfigSource> {
		const epf = await this.ensure();
		const source = await this.withBusy(async () => await epf.saveConfigToWorkspace(text, name, options));
		await this.refreshAll();
		return source;
	}

	async saveConfigToHome(
		text: string,
		name: string,
		options: SaveHomeConfigOptions = {}
	): Promise<ConfigSource> {
		const epf = await this.ensure();
		const source = await this.withBusy(async () => await epf.saveConfigToHome(text, name, options));
		await this.refreshAll();
		return source;
	}

	async saveConfigToS3(text: string, options: SaveConfigToS3Options = {}): Promise<SavedS3Config> {
		const epf = await this.ensure();
		const saved = await this.withBusy(async () => await epf.saveConfigToS3(text, options));
		await this.refreshAll();
		return saved;
	}

	getS3Settings(): S3SettingsResult {
		if (this.epf === null) {
			return {
				ok: false,
				missing: [],
				message: "The EPF session is still starting."
			};
		}
		return this.epf.getS3Settings();
	}

	async testS3Connection(objectKey?: string): Promise<S3ConnectionTestResult> {
		const epf = await this.ensure();
		return await epf.testS3Connection(objectKey);
	}

	async deleteHomeConfig(name: string): Promise<void> {
		const epf = await this.ensure();
		await this.withBusy(async () => await epf.deleteHomeConfig(name));
		await this.refreshAll();
	}

	async setDefaultHomeConfig(name: string | null): Promise<void> {
		const epf = await this.ensure();
		await this.withBusy(async () => await epf.setDefaultHomeConfig(name));
		await this.refreshHomeConfigs();
	}

	async renameConfigFile(path: string, newName: string): Promise<ConfigSource> {
		const epf = await this.ensure();
		const source = await this.withBusy(async () => await epf.renameConfigFile(path, newName));
		await this.refreshAll();
		return source;
	}

	async renameHomeConfig(oldName: string, newName: string): Promise<ConfigSource> {
		const epf = await this.ensure();
		const source = await this.withBusy(async () => await epf.renameHomeConfig(oldName, newName));
		await this.refreshAll();
		return source;
	}

	async renameWorkspaceConfig(relativePath: string, newName: string): Promise<ConfigSource> {
		const epf = await this.ensure();
		const source = await this.withBusy(async () => await epf.renameWorkspaceConfig(relativePath, newName));
		await this.refreshAll();
		return source;
	}

	async copyHomeConfigToWorkspace(
		name: string,
		targetName = "epf.toml",
		options: SaveConfigOptions = {}
	): Promise<ConfigSource> {
		const epf = await this.ensure();
		const source = await this.withBusy(async () => await epf.copyHomeConfigToWorkspace(name, targetName, options));
		await this.refreshAll();
		return source;
	}

	async readEditorDrafts(): Promise<EditorDraftFile> {
		const epf = await this.ensure();
		return await epf.readEditorDrafts();
	}

	async saveEditorDraft(draft: EditorDraft): Promise<void> {
		const epf = await this.ensure();
		await epf.saveEditorDraft(draft);
	}

	async deleteEditorDraft(sourceKey: string): Promise<void> {
		const epf = await this.ensure();
		await epf.deleteEditorDraft(sourceKey);
	}

	async clearEditorDrafts(): Promise<void> {
		const epf = await this.ensure();
		await epf.clearEditorDrafts();
	}

	getStorageSettings(): StorageSettings | null {
		return this.epf === null ? null : this.epf.web.state.getStorageSettings();
	}

	async setStorageSettings(settings: Partial<StorageSettings>): Promise<void> {
		if (this.epf === null) {
			return;
		}
		const epf = this.epf;
		epf.web.state.setStorageSettings(settings);
		await this.withBusy(async () => {
			// A lower total or TTL must take effect now, not on the next write.
			await epf.web.quota.cleanupExpired();
			await epf.web.quota.enforceBudget();
		});
		await this.refreshAll();
	}

	// --- Environment ---

	listEnvValues(): EnvVarValue[] {
		if (this.epf === null) {
			return [];
		}
		const persisted = new Set(this.epf.web.env.persistedNames());
		return Object.entries(this.epf.web.env.all()).map(([name, value]) => ({
			name,
			value,
			persisted: persisted.has(name)
		}));
	}

	getEnv(name: string): string {
		return this.epf?.web.env.get(name) ?? "";
	}

	setEnv(name: string, value: string, persist: boolean): void {
		this.epf?.web.env.set(name, value, { persist });
		this.refreshEnvValues();
	}

	clearEnv(name: string): void {
		this.epf?.web.env.clear(name);
		this.refreshEnvValues();
	}

	/**
	 * Forget secrets remembered in this browser (the "remember" switch was turned
	 * off). The values stay usable for this tab, as they do by default.
	 */
	forgetPersistedSecrets(): void {
		if (this.epf === null) {
			return;
		}
		const secrets = ENV_VARS.filter((spec) => spec.secret).map((spec) => spec.name);
		this.epf.web.env.clearPersisted(secrets);
		this.refreshEnvValues();
	}

	// --- Workspaces and sources ---

	async createWorkspace(label: string, origin: WorkspaceOrigin = "empty"): Promise<WorkspaceState> {
		const epf = await this.ensure();
		const workspace = await epf.createWorkspace(label, origin);
		await this.refreshAll();
		return workspace;
	}

	async activateWorkspace(path: string): Promise<void> {
		const epf = await this.ensure();
		await epf.setActiveWorkspace(path);
		await this.refreshAll();
	}

	async removeWorkspace(path: string): Promise<void> {
		const epf = await this.ensure();
		await this.withBusy(async () => {
			await epf.removeWorkspace(path);
		});
		this.outputCache.clear();
		await this.refreshAll();
	}

	setWorkspacePinned(path: string, pinned: boolean): void {
		this.epf?.setWorkspacePinned(path, pinned);
		if (this.epf !== null) {
			this.workspaces.set(this.epf.listWorkspaces());
		}
	}

	async fetchSource(request: FetchSourceRequest): Promise<FetchSourceSummary | null> {
		const epf = await this.ensure();
		let summary: FetchSourceSummary;
		try {
			summary = await this.withBusy(async () => await epf.fetchSource(request));
		} catch (error) {
			// A failed fetch may have rolled back a workspace; refresh so the
			// Source panel does not keep showing a removed entry.
			await this.refreshAll();
			throw error;
		}
		await this.refreshAll();
		return summary;
	}

	async uploadFiles(files: UploadedFile[], targetDirectory = ""): Promise<void> {
		const epf = await this.ensure();
		await this.withBusy(async () => {
			await epf.uploadFiles(files, targetDirectory);
		});
		await this.refreshAll();
	}

	// --- Running ---

	async run(filters?: { only?: string[]; skip?: string[] }): Promise<WorkflowRunResult[]> {
		const epf = await this.ensure();
		const results = await this.withBusy(async () => await epf.runWorkflows(filters));
		this.lastResults.set(results);
		await this.refreshAll();
		return results;
	}

	async execute(line: string): Promise<CommandResult> {
		const epf = await this.ensure();
		const result = await this.withBusy(async () => await epf.executeCommand(line));
		// `reload` re-reads the source inside the engine and emits the new text,
		// so the cached copy is already fresh; no second URL fetch is needed.
		const command = line.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
		if (CONFIG_REFRESHING_COMMANDS.has(command)) {
			await this.refreshConfig();
		}
		await Promise.all([this.refreshOutputs(), this.refreshUsage(), this.refreshStatus(), this.refreshWorkspaces()]);
		return result;
	}

	/** Result of tab-completing a console line. */
	complete(line: string): { text: string; matches: string[] } {
		const engine = this.epf?.getEngine() ?? null;
		const slugs = engine === null ? { analysis: [], testing: [] } : engine.listWorkflows();
		const allSlugs = [...slugs.analysis, ...slugs.testing];

		const trimmed = line.trimStart();
		const parts = trimmed.split(/\s+/);
		if (parts.length <= 1) {
			const partial = trimmed.toLowerCase();
			const matches = COMMAND_NAMES.filter((name) => name.startsWith(partial));
			if (matches.length === 1) {
				return { text: `${matches[0]} `, matches };
			}
			const prefix = longestCommonPrefix(matches);
			return { text: prefix.length > partial.length ? prefix : line, matches };
		}
		const command = parts[0]!.toLowerCase();
		if (command !== "run" && command !== "rerun" && command !== "clear") {
			return { text: line, matches: [] };
		}
		const partial = parts[parts.length - 1] ?? "";
		const matches = allSlugs.filter((slug) => slug.startsWith(partial));
		if (matches.length === 0) {
			return { text: line, matches };
		}
		const base = trimmed.slice(0, trimmed.length - partial.length);
		if (matches.length === 1) {
			return { text: `${base}${matches[0]} `, matches };
		}
		const prefix = longestCommonPrefix(matches);
		return { text: prefix.length > partial.length ? `${base}${prefix}` : line, matches };
	}

	// --- Outputs ---

	/**
	 * Output files recorded for the view's workspace, for the results viewer's
	 * `#source=workspace`. Only files a run wrote are listed, so fetched sources
	 * and configs are never presented as results.
	 */
	async listOutputs(): Promise<ResultFileEntry[]> {
		const epf = await this.ensure({ writeAccess: false });
		if (epf.web.readOnly) {
			epf.web.state.reloadFromStorage();
		}
		const workspace = epf.getViewWorkspace();
		if (workspace === null) {
			return [];
		}
		const entries: ResultFileEntry[] = [];
		for (const name of epf.getRecordedOutputs(workspace.path)) {
			const info = await epf.web.storageFs.stat(`${workspace.path}/${name}`);
			if (info === null || info.kind !== "file") {
				// The file was deleted or moved on; the recording is stale.
				continue;
			}
			entries.push({
				name,
				type: fileTypeFor(name),
				modification_time: new Date(info.mtimeMs).toISOString()
			});
		}
		return entries;
	}

	/** One output file, re-read only when its modification time changed. */
	async readOutput(name: string): Promise<ResultFileContent> {
		const epf = await this.ensure({ writeAccess: false });
		if (epf.web.readOnly) {
			epf.web.state.reloadFromStorage();
		}
		const workspace = epf.getViewWorkspace();
		if (workspace === null) {
			throw new Error("No workspace to read outputs from.");
		}
		const path = `${workspace.path}/${name}`;
		const info = await epf.web.storageFs.stat(path);
		const key = `${info?.mtimeMs ?? 0}:${info?.size ?? 0}`;
		const cached = this.outputCache.get(path);
		if (cached !== undefined && cached.key === key) {
			return cached.content;
		}
		const content = await epf.web.storageFs.readText(path);
		const value: ResultFileContent = { name, type: fileTypeFor(name), content };
		this.outputCache.set(path, { key, content: value });
		return value;
	}

	async clearOutputs(): Promise<void> {
		const epf = await this.ensure();
		const removed = await this.withBusy(async () => await epf.clearRecordedOutputs());
		this.outputCache.clear();
		if (removed.length > 0) {
			epf.web.logs.log("info", `Removed ${removed.length} output file(s) from the workspace.`);
		}
		await this.refreshAll();
	}

	// --- Chat sessions ---

	/** Reload the session list for the active workspace. */
	async refreshChatSessions(): Promise<void> {
		const epf = this.epf ?? await this.ensure({ writeAccess: false });
		try {
			this.chatSessions.set(await epf.listSessions());
		} catch (err) {
			// Keep whatever the panel already shows: replacing the list with an
			// empty one makes a storage problem look like deleted history.
			const message = errorMessage(err);
			console.error("Could not list chat sessions", message);
			this.chatError.set(`Could not read the chat sessions from browser storage: ${message}`);
		}
	}

	async openChatSession(id: string): Promise<ChatSession | null> {
		const epf = this.epf ?? await this.ensure({ writeAccess: false });
		let session: ChatSession | null;
		try {
			session = await epf.readSession(id);
		} catch (err) {
			const message = errorMessage(err);
			this.chatError.set(`Could not open this chat session: ${message}`);
			return null;
		}
		if (session === null) {
			this.chatError.set("This chat session is no longer in browser storage.");
		}
		this.activeChatId = session?.id ?? null;
		this.setActiveSession(session);
		if (session !== null) {
			this.chatError.set(null);
		}
		return session;
	}

	private setActiveSession(session: ChatSession | null): void {
		this.activeSession = session;
		this.activeChatSession.set(session);
	}

	async sendChatMessage(text: string): Promise<void> {
		if (this.chatRunning) {
			return;
		}
		const id = this.activeChatId;
		if (id === null) {
			throw new Error("Open a chat session first.");
		}
		const current = this.activeSession;
		if (current !== null) {
			// Show the user's turn immediately; the canonical session arrives when
			// the stream finishes (the service persists the same message first).
			const optimistic = cloneSession(current);
			optimistic.messages.push(userMessage(text.trim()));
			optimistic.meta.push({ at: new Date().toISOString() });
			this.setActiveSession(optimistic);
		}
		await this.runChat((epf, handlers, signal) => epf.chatSession(id, text, handlers, signal));
	}

	async regenerateChat(): Promise<void> {
		if (this.chatRunning) {
			return;
		}
		const id = this.activeChatId;
		if (id === null) {
			throw new Error("Open a chat session first.");
		}
		const current = this.activeSession;
		if (current !== null) {
			const index = lastUserIndex(current.messages);
			if (index >= 0) {
				this.setActiveSession(truncateSession(current, index + 1));
			}
		}
		await this.runChat((epf, handlers, signal) => epf.regenerateSession(id, handlers, signal));
	}

	async editChatMessage(messageIndex: number, text: string): Promise<void> {
		if (this.chatRunning) {
			return;
		}
		const id = this.activeChatId;
		if (id === null) {
			throw new Error("Open a chat session first.");
		}
		const current = this.activeSession;
		if (current !== null) {
			const next = truncateSession(current, messageIndex + 1);
			next.messages[messageIndex] = userMessage(text.trim());
			next.meta[messageIndex] = { ...next.meta[messageIndex], at: new Date().toISOString() };
			this.setActiveSession(next);
		}
		await this.runChat((epf, handlers, signal) => epf.editSessionMessage(id, messageIndex, text, handlers, signal));
	}

	/** Abort the current stream; the partial reply is kept and marked stopped. */
	stopChat(): void {
		this.chatAbort?.abort();
	}

	async deleteChatSession(id: string): Promise<void> {
		const epf = await this.ensure();
		await this.withBusy(async () => {
			await epf.deleteSession(id);
		});
		if (this.activeChatId === id) {
			this.activeChatId = null;
			this.setActiveSession(null);
		}
		await this.refreshChatSessions();
	}

	private async runChat(
		action: (
			epf: WebEPF,
			handlers: ChatStreamHandlers,
			signal: AbortSignal
		) => Promise<ChatOutcome>
	): Promise<void> {
		if (this.chatRunning) {
			return;
		}
		this.chatRunning = true;
		this.chatBusy.set(true);
		this.chatError.set(null);
		this.chatStreaming.set({ active: true, text: "", reasoning: "" });
		const controller = new AbortController();
		this.chatAbort = controller;
		const handlers: ChatStreamHandlers = {
			onText: (delta) => this.chatStreaming.update((state) => ({ ...state, text: state.text + delta })),
			onReasoning: (delta) => this.chatStreaming.update((state) => ({ ...state, reasoning: state.reasoning + delta }))
		};

		try {
			const epf = await this.ensure();
			const outcome = await action(epf, handlers, controller.signal);
			this.activeChatId = outcome.session.id;
			this.setActiveSession(outcome.session);
			if (outcome.status === "failed") {
				this.chatError.set(outcome.error ?? "The reply failed.");
			}
		} catch (err) {
			const message = errorMessage(err);
			this.chatError.set(message);
		} finally {
			this.chatStreaming.set({ active: false, text: "", reasoning: "" });
			this.chatBusy.set(false);
			this.chatAbort = null;
			this.chatRunning = false;
			try {
				await this.refreshChatSessions();
			} catch {
				// Listing failures are already logged; the chat itself succeeded.
			}
		}
	}

	clearLog(): void {
		this.logBuffer = [];
		this.logs.set([]);
		this.epf?.web.logs.clear();
		this.consoleEpoch.update((value) => value + 1);
	}

	formatLog(entry: LogEntry): string {
		const prefix = entry.slug ? `[${entry.slug}] ` : "";
		const detail = entry.detail ? ` ${entry.detail}` : "";
		return `${prefix}${entry.message}${detail}`;
	}

	private beginBusy(): void {
		this.busyCount += 1;
		this.busy.set(true);
	}

	private endBusy(): void {
		this.busyCount = Math.max(0, this.busyCount - 1);
		this.busy.set(this.busyCount > 0);
	}

	private async withBusy<T>(action: () => Promise<T>): Promise<T> {
		this.beginBusy();
		try {
			const value = await action();
			this.error.set(null);
			return value;
		} catch (err) {
			const message = errorMessage(err);
			this.error.set(message);
			throw err;
		} finally {
			this.endBusy();
		}
	}
}

function longestCommonPrefix(values: readonly string[]): string {
	if (values.length === 0) {
		return "";
	}
	let prefix = values[0]!;
	for (const value of values.slice(1)) {
		let index = 0;
		while (index < prefix.length && index < value.length && prefix[index] === value[index]) {
			index += 1;
		}
		prefix = prefix.slice(0, index);
		if (prefix.length === 0) {
			break;
		}
	}
	return prefix;
}

export const epfSession = new EpfSession();

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
import { ENV_VARS } from "$epf/util/env-vars.ts";
import { toConfigSource } from "$epf/util/config-loader.ts";

import type {
	WebEPF,
	FetchSourceRequest,
	FetchSourceSummary,
	HomeConfigFile,
	OpenedConfigDocument,
	SaveConfigOptions,
	SaveHomeConfigOptions,
	StorageUsage,
	UploadedFile,
	WorkspaceFile
} from "$epf/hosts/web-host.ts";
import type { CommandResult } from "$epf/command-handler.ts";
import type { Engine, WorkflowRunResult } from "$epf/engine/engine.ts";
import type { LogEntry } from "$epf/platform/types.ts";
import type { StorageSettings, WorkspaceOrigin, WorkspaceState } from "$epf/platform/web/web-state.ts";
import type { ConfigSource, ConfigValidation } from "$epf/util/config-loader.ts";
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

class EpfSession {
	readonly busy = writable(false);
	readonly error = writable<string | null>(null);
	readonly persistent = writable(true);
	readonly soleOwner = writable(true);
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
	readonly configSourceLabel = writable<string | null>(null);
	readonly configText = writable("");
	readonly configIssues = writable<string[]>([]);
	readonly homeConfigs = writable<HomeConfigFile[]>([]);
	readonly defaultHomeConfig = writable<string | null>(null);
	readonly files = writable<WorkspaceFile[]>([]);
	readonly usage = writable<StorageUsage | null>(null);
	readonly lastResults = writable<WorkflowRunResult[]>([]);
	readonly lastFetch = writable<FetchSourceSummary | null>(null);
	readonly envValues = writable<EnvVarValue[]>([]);
	readonly initialized = writable(false);
	/** Bumped by clearLog() so the console can rebuild its terminal. */
	readonly consoleEpoch = writable(0);

	private epf: WebEPF | null = null;
	private creating: Promise<WebEPF> | null = null;
	private access: "read-write" | "read-only" = "read-write";
	private busyCount = 0;
	private logBuffer: LogEntry[] = [];
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
			this.access = writeAccess ? "read-write" : "read-only";
			this.attach(epf);
			this.persistent.set(epf.web.persistent);
			this.soleOwner.set(epf.web.soleOwner);
			// The platform logs why storage is memory-only (unavailable, or another
			// tab owns it); no need to repeat it here.
			await this.refreshAll();
			this.error.set(null);
			return epf;
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.error.set(message);
			throw err;
		} finally {
			this.endBusy();
			this.initialized.set(true);
		}
	}

	/** Drop listeners so a session can be replaced. */
	private detach(): void {
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
			this.refreshHomeConfigs()
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
		this.files.set(await epf.listFiles());
	}

	async refreshUsage(): Promise<void> {
		const epf = await this.requireSession();
		this.usage.set(await epf.getUsage());
	}

	async refreshConfig(options: { refresh?: boolean } = {}): Promise<void> {
		const epf = await this.requireSession();
		const text = await epf.getConfigText(options);
		this.configLoaded.set(epf.hasConfig());
		const source = epf.getConfigSource();
		this.configSource.set(source);
		this.attemptedConfigSource.set(epf.getAttemptedConfigSource());
		this.configSourceLabel.set(source === null ? null : describeSource(source));
		if (text !== null) {
			this.configText.set(text);
		} else if (!epf.hasConfig()) {
			this.configText.set("");
		}
		this.configIssues.set(this.configIssuesFromError(epf.getConfigError()));
		this.refreshStatus();
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

	async saveConfigText(text: string, path = "epf.toml"): Promise<void> {
		const epf = await this.ensure();
		await this.withBusy(async () => {
			await epf.saveConfigText(text, path);
		});
		await this.refreshAll();
	}

	async loadConfigFromInput(value: string): Promise<void> {
		const epf = await this.ensure();
		const source = toConfigSource(value.trim());
		await this.withBusy(async () => {
			await epf.loadConfigSource(source);
		});
		await this.refreshAll();
	}

	async loadConfigFromWorkspace(name: string): Promise<void> {
		const epf = await this.ensure();
		const workspace = epf.requireActiveWorkspace();
		await this.withBusy(async () => {
			await epf.loadConfigSource({ kind: "path", path: `${workspace.path}/${name}` });
		});
		await this.refreshAll();
	}

	/** Config files found in the active workspace. */
	async detectWorkspaceConfigs(): Promise<string[]> {
		const epf = await this.ensure();
		return await epf.detectConfigCandidates();
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

	/** The source a fresh page would pick (workspace or library). */
	async findConfigSource(): Promise<ConfigSource | null> {
		const epf = await this.ensure();
		return await epf.findConfigSource();
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

	async saveConfigToCurrentSource(text: string): Promise<ConfigSource> {
		const epf = await this.ensure();
		const source = await this.withBusy(async () => await epf.saveConfigToCurrentSource(text));
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
		this.lastFetch.set(summary);
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
		// Only a config-carrying command can change the config text, and reading a
		// URL source again is a network round-trip.
		const command = line.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
		if (CONFIG_REFRESHING_COMMANDS.has(command)) {
			await this.refreshConfig({ refresh: true });
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

	async clearActiveWorkspace(): Promise<void> {
		const epf = await this.ensure();
		await this.withBusy(async () => {
			await epf.clearWorkspace();
		});
		this.outputCache.clear();
		await this.refreshAll();
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
			const message = err instanceof Error ? err.message : String(err);
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

function describeSource(source: ConfigSource): string {
	switch (source.kind) {
		case "path":
			return source.path;
		case "url":
			return source.url;
		case "inline":
			return source.label;
	}
}

export const epfSession = new EpfSession();

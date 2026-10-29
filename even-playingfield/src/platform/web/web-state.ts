/**
 * Web platform state: one JSON blob in `localStorage`.
 *
 * Holds the workspace index (what was fetched or uploaded, when it was last
 * used, whether it is pinned), the storage policy values and the console
 * history. Everything here is small and human-inspectable; file contents live
 * in the ZenFS store instead.
 */

export type KeyValueStorage = {
    getItem(key: string): string | null;
    setItem(key: string, value: string): void;
    removeItem(key: string): void;
};

export const WEB_STATE_KEY = "epf.platform";
export const WEB_STATE_VERSION = 2;

export const DEFAULT_STORAGE_SETTINGS: StorageSettings = {
    /** A single file larger than this is refused (fetch reports it as skipped). */
    maxFileBytes: 8 * 1024 * 1024,
    /** Total bytes EPF keeps in browser storage. */
    maxTotalBytes: 128 * 1024 * 1024,
    /** Unpinned workspaces older than this are removed on startup. */
    sourceTtlDays: 7,
};

export type StorageSettings = {
    maxFileBytes: number;
    maxTotalBytes: number;
    sourceTtlDays: number;
};

export type HomeSettings = {
    /**
     * Library config used when the active workspace has none. Null means the
     * conventional `epf.toml`, or the only library file when there is exactly
     * one.
     */
    defaultConfig: string | null;
};

export type WorkspaceOrigin = "github" | "upload" | "empty";

export type WorkspaceState = {
    /** Absolute VFS path, e.g. `/epf/workspaces/ws-1700000000000`. */
    path: string;
    label: string;
    origin: WorkspaceOrigin;
    createdAt: number;
    lastUsedAt: number;
    pinned: boolean;
};

export type WebState = {
    version: number;
    activeWorkspace: string | null;
    workspaces: WorkspaceState[];
    home: HomeSettings;
    storage: StorageSettings;
    /**
     * Last config source that can be re-opened after a reload. Inline (pasted)
     * configs are deliberately never stored — they can contain API keys.
     */
    configSource: StoredConfigSource | null;
    /**
     * Workspace-relative names of files that finished workflow runs wrote, per
     * workspace path. This is what "clear outputs" deletes, so the workspace's
     * own sources and config are never mistaken for results.
     */
    outputs: Record<string, string[]>;
    console: { history: string[] };
};

/** Keeps one workspace's recorded outputs from growing without bound. */
export const MAX_RECORDED_OUTPUTS = 200;

export type StoredConfigSource =
    | { kind: "path"; path: string }
    | { kind: "url"; url: string };

export function createMemoryStorage(initial?: Record<string, string>): KeyValueStorage {
    const map = new Map<string, string>(Object.entries(initial ?? {}));
    return {
        getItem: (key) => map.get(key) ?? null,
        setItem: (key, value) => {
            map.set(key, value);
        },
        removeItem: (key) => {
            map.delete(key);
        },
    };
}

/**
 * `localStorage` when it is actually usable. It throws in some privacy modes
 * and is absent under test, in which case state degrades to memory.
 */
export function defaultStorage(): KeyValueStorage {
    try {
        const storage = globalThis.localStorage as KeyValueStorage | undefined;
        if (storage) {
            const probe = "__epf_probe__";
            storage.setItem(probe, "1");
            storage.removeItem(probe);
            return storage;
        }
    } catch {
        // Fall through to memory storage.
    }
    return createMemoryStorage();
}

function defaultState(): WebState {
    return {
        version: WEB_STATE_VERSION,
        activeWorkspace: null,
        workspaces: [],
        home: { defaultConfig: null },
        storage: { ...DEFAULT_STORAGE_SETTINGS },
        configSource: null,
        outputs: {},
        console: { history: [] },
    };
}

function validHomeConfigName(value: unknown): string | null {
    if (typeof value !== "string") {
        return null;
    }
    const name = value.trim();
    if (name.length === 0 || name.startsWith(".") || name.includes("/") || name.includes("\\")) {
        return null;
    }
    return name.toLowerCase().endsWith(".toml") ? name : `${name}.toml`;
}

/** Merge a parsed blob with defaults so missing/renamed fields cannot break. */
function coerceState(raw: unknown): WebState {
    const state = defaultState();
    if (typeof raw !== "object" || raw === null) {
        return state;
    }
    const record = raw as Record<string, unknown>;

    if (typeof record.activeWorkspace === "string" || record.activeWorkspace === null) {
        state.activeWorkspace = record.activeWorkspace as string | null;
    }

    if (Array.isArray(record.workspaces)) {
        state.workspaces = record.workspaces.flatMap((entry): WorkspaceState[] => {
            if (typeof entry !== "object" || entry === null) {
                return [];
            }
            const item = entry as Record<string, unknown>;
            if (typeof item.path !== "string") {
                return [];
            }
            return [{
                path: item.path,
                label: typeof item.label === "string" ? item.label : item.path,
                origin: (item.origin === "github" || item.origin === "upload" ? item.origin : "empty") as WorkspaceOrigin,
                createdAt: typeof item.createdAt === "number" ? item.createdAt : Date.now(),
                lastUsedAt: typeof item.lastUsedAt === "number" ? item.lastUsedAt : Date.now(),
                pinned: item.pinned === true,
            }];
        });
    }

    if (typeof record.home === "object" && record.home !== null) {
        const home = record.home as Record<string, unknown>;
        const defaultConfig = validHomeConfigName(home.defaultConfig);
        if (defaultConfig !== null) {
            state.home.defaultConfig = defaultConfig;
        }
    }

    if (typeof record.storage === "object" && record.storage !== null) {
        const storage = record.storage as Record<string, unknown>;
        for (const key of Object.keys(DEFAULT_STORAGE_SETTINGS) as (keyof StorageSettings)[]) {
            const value = storage[key];
            if (typeof value === "number" && Number.isFinite(value) && value > 0) {
                state.storage[key] = value;
            }
        }
    }

    if (typeof record.configSource === "object" && record.configSource !== null) {
        const configSource = record.configSource as Record<string, unknown>;
        if (configSource.kind === "path" && typeof configSource.path === "string") {
            state.configSource = { kind: "path", path: configSource.path };
        } else if (configSource.kind === "url" && typeof configSource.url === "string") {
            state.configSource = { kind: "url", url: configSource.url };
        }
    }

    if (typeof record.outputs === "object" && record.outputs !== null) {
        const outputs = record.outputs as Record<string, unknown>;
        for (const [path, names] of Object.entries(outputs)) {
            if (!Array.isArray(names)) {
                continue;
            }
            state.outputs[path] = names
                .filter((name): name is string => typeof name === "string" && name.length > 0)
                .slice(-MAX_RECORDED_OUTPUTS);
        }
    }

    if (typeof record.console === "object" && record.console !== null) {
        const consoleState = record.console as Record<string, unknown>;
        if (Array.isArray(consoleState.history)) {
            state.console.history = consoleState.history.filter((line): line is string => typeof line === "string").slice(-100);
        }
    }

    return state;
}

const SAVE_DELAY_MS = 250;

export type WebStateStoreOptions = {
    /**
     * False for read-only sessions: they read the persisted blob but never write,
     * so a viewer tab cannot clobber the state of the tab that owns the store.
     */
    persist?: boolean;
};

export class WebStateStore {
    private readonly storage: KeyValueStorage;
    private readonly key: string;
    private readonly persist: boolean;
    private state: WebState;
    private saveTimer: ReturnType<typeof setTimeout> | undefined;
    private readonly pagehideHandler: (() => void) | null;

    constructor(
        storage: KeyValueStorage = defaultStorage(),
        key: string = WEB_STATE_KEY,
        options: WebStateStoreOptions = {},
    ) {
        this.storage = storage;
        this.key = key;
        this.persist = options.persist ?? true;
        this.state = this.load();
        if (this.persist) {
            // Debounced writes must not be lost when the tab closes mid-window.
            this.pagehideHandler = () => this.saveNow();
            globalThis.addEventListener?.("pagehide", this.pagehideHandler);
        } else {
            this.pagehideHandler = null;
        }
    }

    /** Stop listening for unload and flush pending writes. */
    dispose(): void {
        if (this.pagehideHandler !== null) {
            globalThis.removeEventListener?.("pagehide", this.pagehideHandler);
        }
        this.saveNow();
    }

    /**
     * Re-read the persisted blob. Only meaningful for read-only sessions: the
     * tab that owns storage is the source of truth and must not clobber its
     * unsaved state with a stale disk copy.
     */
    reloadFromStorage(): void {
        if (this.persist) {
            return;
        }
        this.state = this.load();
    }

    private load(): WebState {
        try {
            const raw = this.storage.getItem(this.key);
            if (raw === null || raw.trim().length === 0) {
                return defaultState();
            }
            return coerceState(JSON.parse(raw) as unknown);
        } catch {
            // Corrupt or unreadable state: start clean rather than crash.
            return defaultState();
        }
    }

    /** Current state. Treat as read-only; use {@link update} to change it. */
    get(): WebState {
        return this.state;
    }

    /**
     * Mutate state. Saves are debounced unless `immediate` is set, which the
     * callers below use for values a reload must not lose (active workspace,
     * storage limits, chosen config source).
     */
    update(mutator: (state: WebState) => void, options?: { immediate?: boolean }): void {
        mutator(this.state);
        if (options?.immediate === true) {
            this.saveNow();
            return;
        }
        this.scheduleSave();
    }

    /** Write immediately (used at startup and by explicit UI actions). */
    saveNow(): void {
        if (!this.persist) {
            return;
        }
        if (this.saveTimer !== undefined) {
            clearTimeout(this.saveTimer);
            this.saveTimer = undefined;
        }
        try {
            this.storage.setItem(this.key, JSON.stringify(this.state));
        } catch {
            // Storage full or blocked: state stays in memory for this session.
        }
    }

    private scheduleSave(): void {
        if (this.saveTimer !== undefined) {
            return;
        }
        this.saveTimer = setTimeout(() => {
            this.saveTimer = undefined;
            this.saveNow();
        }, SAVE_DELAY_MS);
    }

    // --- Workspaces ---

    listWorkspaces(): WorkspaceState[] {
        return [...this.state.workspaces];
    }

    getWorkspace(path: string): WorkspaceState | null {
        return this.state.workspaces.find((workspace) => workspace.path === path) ?? null;
    }

    upsertWorkspace(workspace: WorkspaceState): void {
        this.update((state) => {
            const index = state.workspaces.findIndex((entry) => entry.path === workspace.path);
            if (index === -1) {
                state.workspaces.push(workspace);
            } else {
                state.workspaces[index] = workspace;
            }
        });
    }

    removeWorkspace(path: string): void {
        this.update((state) => {
            state.workspaces = state.workspaces.filter((entry) => entry.path !== path);
            delete state.outputs[path];
            if (state.configSource?.kind === "path" &&
                (state.configSource.path === path || state.configSource.path.startsWith(`${path}/`))) {
                state.configSource = null;
            }
            if (state.activeWorkspace === path) {
                state.activeWorkspace = state.workspaces[0]?.path ?? null;
            }
        }, { immediate: true });
    }

    setActiveWorkspace(path: string | null): void {
        this.update((state) => {
            state.activeWorkspace = path;
            const workspace = state.workspaces.find((entry) => entry.path === path);
            if (workspace) {
                workspace.lastUsedAt = Date.now();
            }
        }, { immediate: true });
    }

    touchWorkspace(path: string): void {
        this.update((state) => {
            const workspace = state.workspaces.find((entry) => entry.path === path);
            if (workspace) {
                workspace.lastUsedAt = Date.now();
            }
        });
    }

    setPinned(path: string, pinned: boolean): void {
        this.update((state) => {
            const workspace = state.workspaces.find((entry) => entry.path === path);
            if (workspace) {
                workspace.pinned = pinned;
            }
        });
    }

    // --- Storage settings ---

    getStorageSettings(): StorageSettings {
        return { ...this.state.storage };
    }

    setStorageSettings(settings: Partial<StorageSettings>): void {
        this.update((state) => {
            const next = { ...state.storage };
            for (const key of Object.keys(DEFAULT_STORAGE_SETTINGS) as (keyof StorageSettings)[]) {
                const value = settings[key];
                if (typeof value === "number" && Number.isFinite(value) && value > 0) {
                    next[key] = value;
                }
            }
            state.storage = next;
        }, { immediate: true });
    }

    // --- Home config library ---

    getHomeSettings(): HomeSettings {
        return { ...this.state.home };
    }

    getDefaultHomeConfig(): string | null {
        return this.state.home.defaultConfig;
    }

    setDefaultHomeConfig(name: string | null): void {
        const value = name === null ? null : validHomeConfigName(name);
        if (name !== null && value === null) {
            throw new Error(`Invalid config file name: ${name}`);
        }
        this.update((state) => {
            state.home.defaultConfig = value;
        }, { immediate: true });
    }

    // --- Recorded outputs ---

    /** Names of files finished runs wrote into this workspace. */
    getWorkspaceOutputs(path: string): string[] {
        return [...(this.state.outputs[path] ?? [])];
    }

    /** Add names to a workspace's recorded outputs (newest last, deduplicated). */
    recordWorkspaceOutputs(path: string, names: readonly string[]): void {
        const fresh = names.filter((name) => name.length > 0);
        if (fresh.length === 0) {
            return;
        }
        this.update((state) => {
            const existing = state.outputs[path] ?? [];
            const merged = new Set([...existing, ...fresh]);
            state.outputs[path] = [...merged].slice(-MAX_RECORDED_OUTPUTS);
        }, { immediate: true });
    }

    /** Forget a workspace's recorded outputs (after they were deleted). */
    clearWorkspaceOutputs(path: string, names?: readonly string[]): void {
        this.update((state) => {
            if (names === undefined) {
                delete state.outputs[path];
                return;
            }
            const removed = new Set(names);
            const remaining = (state.outputs[path] ?? []).filter((name) => !removed.has(name));
            if (remaining.length === 0) {
                delete state.outputs[path];
            } else {
                state.outputs[path] = remaining;
            }
        }, { immediate: true });
    }

    // --- Config source ---

    getStoredConfigSource(): StoredConfigSource | null {
        return this.state.configSource;
    }

    /** Remember a re-openable source; inline sources pass null and are ignored. */
    setStoredConfigSource(source: StoredConfigSource | null): void {
        this.update((state) => {
            state.configSource = source;
        }, { immediate: true });
    }

    // --- Console history ---

    getConsoleHistory(): string[] {
        return [...this.state.console.history];
    }

    appendConsoleHistory(line: string): void {
        if (line.trim().length === 0) {
            return;
        }
        this.update((state) => {
            const history = state.console.history.filter((entry) => entry !== line);
            history.push(line);
            state.console.history = history.slice(-100);
        });
    }
}

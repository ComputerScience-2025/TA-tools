/**
 * Browser platform wiring: ZenFS storage + quota policy + localStorage state,
 * environment and log buffer.
 *
 * Everything the core needs is assembled here, so `hosts/web-host.ts` and the
 * ta-dashboard session code stay thin.
 */

import { parse as parseToml } from "smol-toml";

import { QuotaFileSystem, formatBytes } from "./quota-vfs.ts";
import { ScopedFileSystem } from "./scoped-vfs.ts";
import { WebEnvProvider, WEB_ENV_KEY } from "./web-env.ts";
import { WebLogBuffer } from "./web-logger.ts";
import { WebStateStore, WEB_STATE_KEY, defaultStorage } from "./web-state.ts";
import { WEB_WORKSPACE_ROOT, createZenFileSystem } from "./zen-vfs.ts";
import { DEFAULT_CONFIG_FILE_NAME } from "../../util/config-loader.ts";
import { ShellUnavailableError } from "../types.ts";
import type { KeyValueStorage } from "./web-state.ts";
import type { QuotaEvent } from "./quota-vfs.ts";
import type { Platform, ShellResult, ShellRunner, TomlCodec, VirtualFileSystem, DirEntry } from "../types.ts";

/** Names the Web Locks entry that keeps two tabs off one storage area. */
export const WEB_STORAGE_LOCK = "epf-storage";

/**
 * Durable home directory for a workspace root. Unlike `<root>/workspaces/...`,
 * nothing in the quota policy evicts it: library configs and editor drafts
 * outlive workspaces.
 */
export function webHomeDir(root: string): string {
    return `${root.replace(/\/+$/, "")}/home`;
}

export type WebPlatformOptions = {
    /** Ask ZenFS for the IndexedDB backend (default true). */
    persist?: boolean;
    /**
     * Read-only sessions skip the storage lock and never initialise or clean up
     * the tree, so a viewer tab can read alongside the tab that owns the store.
     */
    access?: "read-write" | "read-only";
    /** Injectable for tests; defaults to `localStorage`. */
    storage?: KeyValueStorage;
    logBuffer?: WebLogBuffer;
    /** Skip the multi-tab storage lock (tests only). */
    skipSessionLock?: boolean;
    /** Workspace root inside the mount. */
    root?: string;
};

export type WebPlatform = {
    /** Platform handed to the core: `fs` resolves relative to the active workspace. */
    platform: Platform;
    /** Workspace-scoped filesystem (identical to `platform.fs`). */
    fs: ScopedFileSystem;
    /** Storage-level filesystem with the quota policy; paths are absolute. */
    storageFs: QuotaFileSystem;
    /** Underlying store, for operations that bypass policy (removal). */
    rawFs: VirtualFileSystem;
    /** Durable config library directory. */
    homeDir: string;
    state: WebStateStore;
    env: WebEnvProvider;
    logs: WebLogBuffer;
    quota: QuotaFileSystem;
    /** False when the mount fell back to memory (private window, other tab). */
    persistent: boolean;
    /** False when another tab already holds the storage lock. */
    soleOwner: boolean;
    /** True for viewer sessions that never write to the store. */
    readOnly: boolean;
};

export async function createWebPlatform(options: WebPlatformOptions = {}): Promise<WebPlatform> {
    const logs = options.logBuffer ?? new WebLogBuffer();
    const storage = options.storage ?? defaultStorage();
    const readOnly = options.access === "read-only";
    const soleOwner = readOnly || options.skipSessionLock === true ? true : await acquireSessionLock();
    // Only the tab that owns the store may write to it. A read-only viewer still
    // mounts it, because reading what the owning tab produced is the point; a
    // write-intent tab that lost the lock runs memory-only instead, so two tabs
    // can never split the workspace index between them.
    const ownsStore = soleOwner && !readOnly;
    const persist = (options.persist ?? true) && soleOwner;

    const mount = await createZenFileSystem({
        persist,
        root: options.root ?? WEB_WORKSPACE_ROOT,
        // A read-only mount still reads the persisted store; it just never writes.
        writeAccess: !readOnly,
    });

    if (!soleOwner) {
        logs.log(
            "warn",
            "Another EPF tab already owns browser storage; this tab runs in memory only. Close the other tab and reload to take over.",
        );
    } else if (mount.fallbackReason !== undefined) {
        logs.log("warn", `Browser storage could not be opened (${mount.fallbackReason}); this session runs in memory only.`);
    }

    if (mount.persistent && ownsStore) {
        void requestPersistentStorage();
    }

    // Only the owning tab writes state, so a viewer (or a tab that lost the lock)
    // cannot overwrite what the owner stored.
    const state = new WebStateStore(storage, WEB_STATE_KEY, { persist: ownsStore });
    const env = new WebEnvProvider(storage, WEB_ENV_KEY, { persist: ownsStore });

    const quotaContext = {
        settings: () => state.getStorageSettings(),
        workspaces: () => state.listWorkspaces(),
        activeWorkspace: () => state.get().activeWorkspace,
        removeWorkspace: async (path: string): Promise<void> => {
            await mount.fs.remove(path, { recursive: true });
            state.removeWorkspace(path);
        },
        onEvent: (event: QuotaEvent): void => {
            logs.log(event.type === "over-cap" ? "warn" : "info", describeQuotaEvent(event));
        },
    };

    const homeDir = webHomeDir(mount.root);
    const quota = new QuotaFileSystem(mount.fs, quotaContext);
    if (!readOnly) {
        await quota.mkdir(quota.root);
        await quota.mkdir(homeDir);
        await adoptOrphanWorkspaces(mount.fs, state, quota.root);
        await quota.usage();
        await quota.cleanupExpired();
    }

    // The core sees the active workspace as its working directory, which is what
    // config-relative paths (search_directory, output filenames) resolve against.
    const scoped = new ScopedFileSystem(quota, () => state.get().activeWorkspace ?? quota.root);

    const platform: Platform = {
        fs: scoped,
        env,
        shell: createUnavailableShell(),
        logger: logs,
        toml: SMOL_TOML,
        homeDir,
        get homeConfigName(): string {
            return state.getHomeSettings().defaultConfig ?? DEFAULT_CONFIG_FILE_NAME;
        },
    };

    return {
        platform,
        fs: scoped,
        storageFs: quota,
        rawFs: mount.fs,
        homeDir,
        state,
        env,
        logs,
        quota,
        persistent: mount.persistent,
        soleOwner,
        readOnly,
    };
}

const SMOL_TOML: TomlCodec = {
    parse(text: string): Record<string, unknown> {
        return parseToml(text) as Record<string, unknown>;
    },
};

export function describeQuotaEvent(event: QuotaEvent): string {
    switch (event.type) {
        case "evicted": {
            const reason = event.reason === "ttl" ? "expired" : "over the storage cap";
            return `Removed workspace '${event.label}' (${formatBytes(event.bytes)}) — ${reason}.`;
        }
        case "over-cap":
            return `Browser storage is over the cap: ${formatBytes(event.usage)} of ${formatBytes(event.limit)}. Remove a workspace to free space.`;
        case "rejected":
            return `Skipped '${event.path}': ${formatBytes(event.size)} is above the ${formatBytes(event.limit)} per-file limit.`;
    }
}

/**
 * Adopt workspace directories left behind when the state index was lost (for
 * example, the user cleared localStorage but IndexedDB remained). Without this
 * they count against the storage cap but can never be listed, pinned or
 * deleted from the UI.
 */
async function adoptOrphanWorkspaces(fs: VirtualFileSystem, state: WebStateStore, root: string): Promise<void> {
    const directory = `${root.replace(/\/+$/, "")}/workspaces`;
    let entries: DirEntry[];
    try {
        if (!await fs.exists(directory)) {
            return;
        }
        entries = await fs.list(directory);
    } catch {
        return;
    }
    const known = new Set(state.listWorkspaces().map((workspace) => workspace.path));
    const now = Date.now();
    for (const entry of entries) {
        if (entry.kind !== "directory") {
            continue;
        }
        const path = `${directory}/${entry.name}`;
        if (known.has(path)) {
            continue;
        }
        state.upsertWorkspace({
            path,
            label: entry.name,
            origin: "empty",
            createdAt: entry.mtimeMs > 0 ? entry.mtimeMs : now,
            lastUsedAt: now,
            pinned: false,
        });
        known.add(path);
    }
}

function createUnavailableShell(): ShellRunner {
    return {
        available: false,
        async run(command: string): Promise<ShellResult> {
            throw new ShellUnavailableError(
                `Cannot run '${command}': shell execution is not available in this browser target. Use the CLI for testing workflows.`,
            );
        },
    };
}

/**
 * Ask the browser to keep our storage out of automatic eviction. Best effort:
 * Safari and Firefox may ignore or prompt.
 */
export async function requestPersistentStorage(): Promise<boolean> {
    try {
        const storageManager = globalThis.navigator?.storage as StorageManager | undefined;
        if (!storageManager || typeof storageManager.persist !== "function") {
            return false;
        }
        return await storageManager.persist();
    } catch {
        return false;
    }
}

/** Browser-wide quota information, when the browser exposes it. */
export async function storageEstimate(): Promise<{ usage: number; quota: number } | null> {
    try {
        const storageManager = globalThis.navigator?.storage as StorageManager | undefined;
        if (!storageManager || typeof storageManager.estimate !== "function") {
            return null;
        }
        const estimate = await storageManager.estimate();
        return { usage: estimate.usage ?? 0, quota: estimate.quota ?? 0 };
    } catch {
        return null;
    }
}

type LockManagerLike = {
    request(
        name: string,
        options: { mode: "exclusive"; ifAvailable: true },
        callback: (lock: unknown) => Promise<void>,
    ): Promise<unknown>;
};

/**
 * Hold an exclusive lock for the lifetime of the page. Returns false when
 * another tab already owns it, in which case the caller runs memory-only so the
 * two tabs cannot corrupt one IndexedDB store.
 */
async function acquireSessionLock(): Promise<boolean> {
    const locks = (globalThis.navigator as unknown as { locks?: LockManagerLike } | undefined)?.locks;
    if (!locks) {
        return true;
    }
    return await new Promise<boolean>((resolve) => {
        void locks
            .request(WEB_STORAGE_LOCK, { mode: "exclusive", ifAvailable: true }, async (lock) => {
                if (lock === null) {
                    resolve(false);
                    return;
                }
                resolve(true);
                // Hold until the tab goes away so later tabs see the lock taken.
                await new Promise<void>((release) => {
                    globalThis.addEventListener("pagehide", () => release(), { once: true });
                });
            })
            .catch(() => resolve(true));
    });
}

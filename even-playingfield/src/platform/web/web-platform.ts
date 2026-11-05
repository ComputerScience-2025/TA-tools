/**
 * Browser platform wiring: ZenFS storage + quota policy + localStorage state,
 * environment and log buffer.
 *
 * Everything the core needs is assembled here, so `hosts/web-host.ts` and the
 * ta-dashboard session code stay thin.
 */

import { parse as parseToml } from "smol-toml";

import { QuotaFileSystem } from "./quota-vfs.ts";
import { ScopedFileSystem } from "./scoped-vfs.ts";
import { WEB_STORAGE_LOCK, acquireSessionLock, isStorageLockFree } from "./storage-lock.ts";
import { WebEnvProvider, WEB_ENV_KEY } from "./web-env.ts";
import { WebLogBuffer } from "./web-logger.ts";
import { WebStateStore, WEB_STATE_KEY, defaultStorage } from "./web-state.ts";
import { WEB_WORKSPACE_ROOT, createZenFileSystem } from "./zen-vfs.ts";
import { DEFAULT_CONFIG_FILE_NAME } from "../../util/config-loader.ts";
import { formatBytes } from "../../util/format.ts";
import { ShellUnavailableError } from "../types.ts";
import type { KeyValueStorage } from "./web-state.ts";
import type { QuotaEvent } from "./quota-vfs.ts";
import type { Platform, ShellResult, ShellRunner, TomlCodec, VirtualFileSystem, DirEntry } from "../types.ts";

// Re-exported for callers that already import the platform from here.
export { WEB_STORAGE_LOCK, isStorageLockFree };

/**
 * Why this tab may not write to browser storage. `null` means it owns the store.
 *
 *   - `viewer`: the results viewer opened a read-only session on purpose;
 *   - `another-tab`: a different tab holds the storage lock.
 *
 * Both cases still mount IndexedDB read-only, so the files the owning tab wrote
 * stay visible; only mutations are refused.
 */
export type WriteBlockReason = "viewer" | "another-tab";

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
    /** IndexedDB store name (tests use a unique one per case). */
    storeName?: string;
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
    /** False when the mount fell back to memory (private window, blocked storage). */
    persistent: boolean;
    /** False when another tab already holds the storage lock. */
    soleOwner: boolean;
    /** True when writes are refused: a viewer session or another tab owns the store. */
    readOnly: boolean;
    /** Why writes are refused, or null when this tab owns the store. */
    writeBlockedBy: WriteBlockReason | null;
};

export async function createWebPlatform(options: WebPlatformOptions = {}): Promise<WebPlatform> {
    const logs = options.logBuffer ?? new WebLogBuffer();
    const storage = options.storage ?? defaultStorage();
    const viewerOnly = options.access === "read-only";
    const soleOwner = viewerOnly || options.skipSessionLock === true ? true : await acquireSessionLock();
    // Only the tab that owns the store may write to it. A viewer, or a tab that
    // lost the lock, still mounts IndexedDB — read-only. Mounting an empty
    // in-memory filesystem instead made every saved file look deleted.
    const ownsStore = soleOwner && !viewerOnly;
    const writeBlockedBy: WriteBlockReason | null = viewerOnly
        ? "viewer"
        : soleOwner
            ? null
            : "another-tab";
    const readOnly = writeBlockedBy !== null;

    const mount = await createZenFileSystem({
        persist: options.persist ?? true,
        root: options.root ?? WEB_WORKSPACE_ROOT,
        storeName: options.storeName,
        // A read-only mount still reads the persisted store; it just never writes.
        writeAccess: ownsStore,
    });

    if (writeBlockedBy === "another-tab") {
        logs.log(
            "warn",
            "Another EPF tab owns browser storage, so this tab is read-only. Close the other tab and take over storage here (or reload) to make changes.",
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
    if (ownsStore) {
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
        writeBlockedBy,
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
export type BrowserStorageEstimate = {
    /** Bytes the browser attributes to this whole origin (not only EPF). */
    usage: number;
    /** Bytes the browser currently allows this origin. */
    quota: number;
    /**
     * Chromium's per-storage-system breakdown (`indexedDB`, `caches`, …), when
     * reported. Stores with no usage are omitted, and the sum can differ from
     * `usage`.
     */
    details: Record<string, number> | null;
};

/**
 * The browser's own storage estimate for the whole site.
 *
 * Deliberately not part of the quota policy: the figure is approximate,
 * origin-wide and on disk, so it is not comparable with the logical size of the
 * EPF tree that {@link QuotaFileSystem.usage} reports.
 */
export async function storageEstimate(): Promise<BrowserStorageEstimate | null> {
    try {
        const storageManager = globalThis.navigator?.storage as StorageManager | undefined;
        if (!storageManager || typeof storageManager.estimate !== "function") {
            return null;
        }
        // `usageDetails` is a Chromium extension: present in Chrome/Edge/Opera,
        // absent from `lib.dom`, so it is read defensively.
        const estimate = await storageManager.estimate() as StorageEstimate & { usageDetails?: unknown };
        return {
            usage: estimate.usage ?? 0,
            quota: estimate.quota ?? 0,
            details: collectUsageDetails(estimate.usageDetails),
        };
    } catch {
        return null;
    }
}

/** Keep the numeric, non-zero entries of a `usageDetails` object. */
export function collectUsageDetails(raw: unknown): Record<string, number> | null {
    if (typeof raw !== "object" || raw === null) {
        return null;
    }
    const details: Record<string, number> = {};
    for (const [name, value] of Object.entries(raw as Record<string, unknown>)) {
        if (typeof value === "number" && Number.isFinite(value) && value > 0) {
            details[name] = value;
        }
    }
    return Object.keys(details).length > 0 ? details : null;
}

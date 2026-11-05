/**
 * Web Locks policy that keeps two tabs off one storage area.
 *
 * Deliberately dependency-free: the dashboard imports this module directly to
 * decide whether it may upgrade a read-only session, and it must not drag the
 * ZenFS graph (or any other browser platform code) into that import.
 */

/** Names the Web Locks entry that keeps two tabs off one storage area. */
export const WEB_STORAGE_LOCK = "epf-storage";

type LockManagerLike = {
    request(
        name: string,
        options: { mode: "exclusive"; ifAvailable: true },
        callback: (lock: unknown) => Promise<void>,
    ): Promise<unknown>;
    query?(): Promise<{ held: { name?: string }[]; pending: { name?: string }[] }>;
};

function lockManager(): LockManagerLike | undefined {
    return (globalThis.navigator as unknown as { locks?: LockManagerLike } | undefined)?.locks;
}

/**
 * Whether this tab could take the storage lock right now, without taking it.
 *
 * Called before a read-only session is replaced by a writable one: a tab that
 * cannot write must keep the session it has, so its files stay readable instead
 * of being swapped for an empty memory filesystem.
 */
export async function isStorageLockFree(): Promise<boolean> {
    const locks = lockManager();
    if (!locks) {
        return true;
    }
    if (typeof locks.query === "function") {
        try {
            const state = await locks.query();
            return !state.held.some((lock) => lock.name === WEB_STORAGE_LOCK);
        } catch {
            // Some browsers expose query() but refuse it; fall back to a probe.
        }
    }
    return await new Promise<boolean>((resolve) => {
        void locks
            .request(WEB_STORAGE_LOCK, { mode: "exclusive", ifAvailable: true }, async (lock) => {
                resolve(lock !== null);
            })
            .catch(() => resolve(true));
    });
}

/**
 * Hold an exclusive lock for the lifetime of the page. Returns false when
 * another tab already owns it, in which case the caller mounts the store
 * read-only so the saved files stay visible and writes are refused.
 */
export async function acquireSessionLock(): Promise<boolean> {
    const locks = lockManager();
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

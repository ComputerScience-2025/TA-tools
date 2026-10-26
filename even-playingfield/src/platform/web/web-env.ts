/**
 * `EnvProvider` for the browser.
 *
 * Values marked `persist: true` (and configured with "remember" in the UI) are
 * written to a JSON blob in `localStorage`. Everything else — secrets by
 * default — lives in memory for the tab session only.
 */

import { defaultStorage } from "./web-state.ts";
import type { EnvProvider, EnvSetOptions } from "../types.ts";
import type { KeyValueStorage } from "./web-state.ts";

export const WEB_ENV_KEY = "epf.env";

export type WebEnvOptions = {
    /** False for read-only sessions, which must not change stored values. */
    persist?: boolean;
};

export class WebEnvProvider implements EnvProvider {
    private readonly storage: KeyValueStorage;
    private readonly key: string;
    private readonly persist: boolean;
    private persisted: Record<string, string> = {};
    private readonly session: Record<string, string> = {};

    constructor(
        storage: KeyValueStorage = defaultStorage(),
        key: string = WEB_ENV_KEY,
        options: WebEnvOptions = {},
    ) {
        this.storage = storage;
        this.key = key;
        this.persist = options.persist ?? true;
        this.persisted = this.load();
    }

    get(name: string): string | undefined {
        return this.session[name] ?? this.persisted[name];
    }

    set(name: string, value: string, opts?: EnvSetOptions): void {
        if (opts?.persist === true) {
            this.persisted[name] = value;
            delete this.session[name];
        } else {
            // Moving a value out of persistence must not leave the old copy behind.
            delete this.persisted[name];
            if (value.length === 0) {
                delete this.session[name];
            } else {
                this.session[name] = value;
            }
        }
        this.save();
    }

    clear(name: string): void {
        delete this.persisted[name];
        delete this.session[name];
        this.save();
    }

    /**
     * Move remembered values back to session-only storage, so a disabled
     * "remember" setting leaves nothing behind in the browser. Without `names`,
     * every remembered value is forgotten.
     */
    clearPersisted(names?: readonly string[]): void {
        const targets = names ?? Object.keys(this.persisted);
        let changed = false;
        for (const name of targets) {
            const value = this.persisted[name];
            if (value === undefined) {
                continue;
            }
            delete this.persisted[name];
            // Keep the value usable for this session, matching the session-only default.
            if (!(name in this.session)) {
                this.session[name] = value;
            }
            changed = true;
        }
        if (changed) {
            this.save();
        }
    }

    all(): Record<string, string> {
        return { ...this.persisted, ...this.session };
    }

    /** Names currently remembered in `localStorage`. */
    persistedNames(): string[] {
        return Object.keys(this.persisted);
    }

    private load(): Record<string, string> {
        try {
            const raw = this.storage.getItem(this.key);
            if (raw === null || raw.trim().length === 0) {
                return {};
            }
            const parsed = JSON.parse(raw) as unknown;
            if (typeof parsed !== "object" || parsed === null) {
                return {};
            }
            const result: Record<string, string> = {};
            for (const [name, value] of Object.entries(parsed as Record<string, unknown>)) {
                if (typeof value === "string") {
                    result[name] = value;
                }
            }
            return result;
        } catch {
            return {};
        }
    }

    private save(): void {
        if (!this.persist) {
            return;
        }
        try {
            this.storage.setItem(this.key, JSON.stringify(this.persisted));
        } catch {
            // Storage blocked or full: values stay available for this session.
        }
    }
}

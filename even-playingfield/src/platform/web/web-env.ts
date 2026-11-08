/**
 * `EnvProvider` for the browser.
 *
 * Values are written to a JSON blob in `localStorage`, alongside the config
 * drafts and library files that already keep API keys. A read-only session
 * keeps values in memory but never writes them.
 */

import { defaultStorage } from "./web-state.ts";
import type { EnvProvider } from "../types.ts";
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
    private values: Record<string, string> = {};

    constructor(
        storage: KeyValueStorage = defaultStorage(),
        key: string = WEB_ENV_KEY,
        options: WebEnvOptions = {},
    ) {
        this.storage = storage;
        this.key = key;
        this.persist = options.persist ?? true;
        this.values = this.load();
    }

    get(name: string): string | undefined {
        return this.values[name];
    }

    set(name: string, value: string): void {
        if (value.length === 0) {
            delete this.values[name];
        } else {
            this.values[name] = value;
        }
        this.save();
    }

    clear(name: string): void {
        delete this.values[name];
        this.save();
    }

    all(): Record<string, string> {
        return { ...this.values };
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
            this.storage.setItem(this.key, JSON.stringify(this.values));
        } catch {
            // Storage blocked or full: values stay available for this session.
        }
    }
}

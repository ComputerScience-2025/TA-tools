/** `EnvProvider` over `process.env` — the CLI / compiled-binary implementation. */

import type { EnvProvider } from "../types.ts";

export class BunEnvProvider implements EnvProvider {
    get(name: string): string | undefined {
        return process.env[name];
    }

    set(name: string, value: string): void {
        process.env[name] = value;
    }

    all(): Record<string, string> {
        const result: Record<string, string> = {};
        for (const [key, value] of Object.entries(process.env)) {
            if (value !== undefined) {
                result[key] = value;
            }
        }
        return result;
    }
}

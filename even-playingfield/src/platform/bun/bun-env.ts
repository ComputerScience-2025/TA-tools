/** `EnvProvider` over `process.env` — the CLI / compiled-binary implementation. */

import type { EnvProvider, EnvSetOptions } from "../types.ts";

export class BunEnvProvider implements EnvProvider {
    get(name: string): string | undefined {
        return process.env[name];
    }

    // `persist` has no meaning for a process environment: values live until the
    // process exits either way.
    set(name: string, value: string, _opts?: EnvSetOptions): void {
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

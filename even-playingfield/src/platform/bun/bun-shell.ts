/**
 * `ShellRunner` over Bun's shell — the CLI / compiled-binary implementation.
 *
 * Commands come from config files (`setup_commands`, `test_cases`, …) and are
 * passed through raw, without interpolation.
 */

import { $ } from "bun";

import type { ShellResult, ShellRunner } from "../types.ts";

export class BunShellRunner implements ShellRunner {
    readonly available = true;

    async run(command: string, opts: { cwd: string }): Promise<ShellResult> {
        const result = await $`${{ raw: command }}`.cwd(opts.cwd).nothrow().quiet();
        return {
            stdout: result.stdout.toString(),
            stderr: result.stderr.toString(),
            exitCode: result.exitCode,
        };
    }
}

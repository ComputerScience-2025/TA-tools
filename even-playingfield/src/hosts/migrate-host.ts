#!/usr/bin/env bun
/**
 * `even-pf migrate` subcommand entrypoint.
 *
 * Transforms an outdated `epf.toml` config up to the current schema version.
 * This is a separate CLI surface from the main engine/REPL (`cli-host.ts`),
 * reached via the `migrate` positional: `even-pf migrate [flags]`.
 *
 * No automatic migration happens at runtime — `readConfig` rejects outdated
 * versions and points the user here. Each schema change registers a migration
 * step in `config-migrations.ts`; this tool chains them to current, validates
 * the result with `ConfigSchema`, and writes it out.
 *
 * Flags:
 *   -C, --config <path|url>   Input config (else resolved via the usual lookup)
 *   -O, --output <path>       Write to this path instead of in-place
 *       --dry-run             Print the migrated TOML; write nothing
 *   [positional]              Treated as the input path when -C is absent
 *
 * Output rules (per the chosen defaults):
 *   - default:     write in-place, backing up the original to `<input>.bak`
 *   - --output:    write to the given path; no backup
 *   - --dry-run:   write nothing; print to stdout
 *   - URL input:    requires --output or --dry-run (cannot back up / overwrite a URL)
 */

import { parseArgs } from "node:util";
import { writeFileSync, copyFileSync } from "node:fs";

import chalk from "chalk";
import { stringify } from "smol-toml";

import { ConfigSchema, CURRENT_CONFIG_VERSION } from "../util/config-schema.ts";
import { resolveConfigPath, loadRawConfig } from "../util/config.ts";
import { detectConfigVersion, migrateToCurrent } from "../util/config-migrations.ts";


export async function runMigrate(argv: string[]): Promise<void> {
    const args = parseArgs({
        args: argv,
        options: {
            config: { type: "string", short: "C" },
            output: { type: "string", short: "O" },
            "dry-run": { type: "boolean", default: false },
        },
        strict: true,
        allowPositionals: true,
    });

    const inputPath = resolveConfigPath(args.values.config ?? args.positionals[0]);
    const isUrl = /^https?:\/\//.test(inputPath);

    const { obj } = await loadRawConfig(inputPath);

    const fromVersion = detectConfigVersion(obj);
    console.log(chalk.cyan(`Input:  ${inputPath}`));
    console.log(chalk.cyan(`Source version: ${fromVersion}  (current: ${CURRENT_CONFIG_VERSION})`));

    if (fromVersion > CURRENT_CONFIG_VERSION) {
        console.error(chalk.red(
            `Config is newer than this tool supports (${fromVersion} > ${CURRENT_CONFIG_VERSION}). Upgrade even-pf.`,
        ));
        process.exit(1);
    }
    if (fromVersion === CURRENT_CONFIG_VERSION) {
        console.log(chalk.yellow(`Config is already at version ${CURRENT_CONFIG_VERSION}; nothing to migrate.`));
        process.exit(0);
    }

    const migrated = migrateToCurrent(obj);
    const finalVersion = detectConfigVersion(migrated);
    console.log(chalk.cyan(`Migrated to version ${finalVersion}.`));

    const validated = ConfigSchema.safeParse(migrated);
    if (!validated.success) {
        console.error(chalk.red("Migrated config failed validation:"));
        console.error(validated.error.format());
        process.exit(1);
    }

    // Stringify the raw migrated object, NOT `validated.data`. Zod's
    // `.default()` resolvers would bake in values (e.g. a frozen `seed`
    // timestamp) that contradict the intended runtime behavior — a config
    // that omits `seed` should get a fresh timestamp on each *run*, not one
    // captured at migration time. safeParse above is a correctness gate only;
    // we emit exactly the source fields plus the migration transforms.
    const tomlString = stringify(migrated);

    if (args.values["dry-run"]) {
        console.log(chalk.gray("--- dry-run: no file written ---"));
        console.log(tomlString);
        return;
    }

    const outputPath = args.values.output;
    if (outputPath) {
        writeFileSync(outputPath, tomlString);
        console.log(chalk.green(`Migrated config written to ${outputPath}.`));
        return;
    }

    if (isUrl) {
        console.error(chalk.red("Input is a URL: --output is required (or use --dry-run)."));
        process.exit(1);
    }

    // In-place write with a backup of the original.
    const backupPath = `${inputPath}.bak`;
    copyFileSync(inputPath, backupPath);
    writeFileSync(inputPath, tomlString);
    console.log(chalk.green(`Migrated config written to ${inputPath} (backup at ${backupPath}).`));
}

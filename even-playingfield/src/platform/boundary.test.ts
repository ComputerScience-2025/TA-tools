/**
 * Guards the platform boundary: the core must stay runnable on every target.
 *
 * If a file under `engine/`, `workflow/`, `util/`, `download/`, or the shared
 * platform helpers imports a Bun/Node built-in or a DOM global, the browser
 * build breaks at bundle time — this test catches it at unit-test time instead.
 * `command-handler.ts` and the download modules are included because the web
 * host drives them from the browser.
 */

import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, test } from "bun:test";

const ROOT = join(import.meta.dir, "..");

const CORE_DIRECTORIES = [
    join(ROOT, "engine"),
    join(ROOT, "workflow"),
    join(ROOT, "util"),
    join(ROOT, "download"),
];
const CORE_FILES = ["command-handler.ts", "util/env-vars.ts"].map((name) => join(ROOT, name));
const SHARED_PLATFORM_FILES = ["types.ts", "path.ts", "glob.ts"].map((name) => join(ROOT, "platform", name));

const FORBIDDEN_PATTERNS: { name: string; pattern: RegExp }[] = [
    { name: "bun built-in import", pattern: /from\s+["']bun["']/ },
    { name: "node built-in import", pattern: /from\s+["']node:/ },
    { name: "bun built-in require", pattern: /require\(\s*["']bun["']\s*\)/ },
    { name: "node built-in require", pattern: /require\(\s*["']node:/ },
    { name: "bun global", pattern: /\bBun\s*\./ },
    { name: "process global", pattern: /\bprocess\./ },
    { name: "dynamic bun/node import", pattern: /import\(\s*["'](bun|node:)/ },
    { name: "browser global", pattern: /\b(document|window|localStorage|indexedDB)\s*\./ },
    { name: "navigator global", pattern: /\bnavigator\s*\./ },
];

/** Relative path of the Bun/Web adapters, which are allowed to use them. */
const ALLOWED_FILES = new Set<string>();

function sourceFiles(directory: string): string[] {
    const found: string[] = [];
    for (const entry of readdirSync(directory)) {
        const full = join(directory, entry);
        if (statSync(full).isDirectory()) {
            found.push(...sourceFiles(full));
            continue;
        }
        if (entry.endsWith(".ts") && !entry.endsWith(".test.ts")) {
            found.push(full);
        }
    }
    return found;
}

/** Remove comments so documentation that mentions Bun APIs is not flagged. */
function stripComments(contents: string): string {
    return contents
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|[^:])\/\/.*$/gm, "$1");
}

describe("platform boundary", () => {
    const files = [
        ...CORE_DIRECTORIES.flatMap(sourceFiles),
        ...CORE_FILES,
        ...SHARED_PLATFORM_FILES,
    ];

    test("core files exist", () => {
        expect(files.length).toBeGreaterThan(6);
    });

    for (const file of files) {
        const label = relative(ROOT, file).replace(/\\/g, "/");
        if (ALLOWED_FILES.has(label)) {
            continue;
        }
        test(`${label} avoids Bun/Node APIs`, () => {
            const contents = stripComments(readFileSync(file, "utf8"));
            const violations = FORBIDDEN_PATTERNS
                .filter(({ pattern }) => pattern.test(contents))
                .map(({ name }) => name);
            expect(violations).toEqual([]);
        });
    }
});

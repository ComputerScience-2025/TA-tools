/**
 * TOML serialization wrapper that preserves multi-line strings.
 *
 * `smol-toml`'s `stringify` always emits single-line basic strings (it uses
 * `JSON.stringify` internally), so any value containing newlines comes out as
 * `"line1\nline2"`. That is semantically correct but a severe readability
 * regression for config fields like `prompt` or `llm_judge_prompt` that are
 * naturally multi-line. The `migrate` command, which rewrites user-authored
 * configs in place, would destroy carefully formatted prompts this way.
 *
 * This wrapper post-processes `smol-toml`'s output and re-emits any
 * `key = "..."` whose value contains a newline as a TOML multi-line basic
 * string (`"""..."""`). The two forms are semantically identical; only the
 * on-disk representation changes.
 *
 * Scope: only top-level `key = "value"` pairs (including those inside
 * `[table]` sections and dotted keys) are converted. Strings inside arrays
 * or inline tables are left as single-line basic strings — multi-line
 * strings in those contexts would be awkward, and the config fields that
 * commonly hold multi-line text (`prompt`, `llm_judge_prompt`,
 * `prompt_replacement.*`) all appear as table values.
 */

import { stringify as smolStringify } from "smol-toml";


/**
 * Escape a string value as a TOML multi-line basic string body (without the
 * surrounding `"""` delimiters). Newlines and tabs are kept literal (both are
 * permitted inside multi-line basic strings); other control characters are
 * escaped per the TOML spec.
 *
 * The caller wraps the result directly with `"""` ... `"""` — no leading
 * newline is inserted. Per the TOML spec, a newline immediately after the
 * opening `"""` should be trimmed by parsers, but `Bun.TOML.parse` (which
 * this codebase uses for config loading) does NOT perform that trim. Emitting
 * a leading newline would therefore add a spurious `\n` to the value on
 * re-parse. By emitting the content verbatim, the string round-trips
 * correctly through `Bun.TOML.parse` regardless of whether it starts with
 * a newline.
 */
function escapeMultilineBody(s: string): string {
    let result = s
        .replace(/\\/g, "\\\\")          // backslash must be escaped first
        .replace(/"""/g, '""\\"')        // escape triple-quote to avoid early close
        .replace(/\r/g, "\\r")           // CR cannot appear literally
        .replace(/\x08/g, "\\b")         // backspace (0x08) — NOT \b (word boundary in regex)
        .replace(/\f/g, "\\f")           // form feed (0x0C)
        .replace(/[\x00-\x07\x0b\x0e-\x1f\x7f]/g, (ch) => {
            return "\\u" + ch.charCodeAt(0).toString(16).padStart(4, "0");
        });
    // \t and \n are left literal — both are valid in multi-line basic strings.

    // Escape any trailing " that would merge with the closing """ delimiter.
    // A trailing " is unescaped iff preceded by an even number of backslashes.
    // Escape each unescaped trailing " one at a time until we hit an
    // already-escaped one. Without this, e.g. `Hello\nWorld"` would emit
    // `"""Hello\nWorld""""`, and the parser would close at the first `"""`,
    // leaving the stray `"` as garbage.
    while (result.endsWith('"')) {
        let backslashes = 0;
        let i = result.length - 2;
        while (i >= 0 && result[i] === "\\") { backslashes++; i--; }
        if (backslashes % 2 === 0) {
            result = result.slice(0, -1) + '\\"';
        } else {
            break;  // already escaped — safe
        }
    }

    return result;
}

// Bare keys: A-Za-z0-9_-  (TOML also allows Unicode bare keys, but smol-toml
// only emits ASCII bare keys via its own BARE_KEY regex, so we match that.)
const BARE_KEY = "[A-Za-z0-9_-]+";
const QUOTED_KEY = '"(?:[^"\\\\]|\\\\.)*"';
const KEY = `(?:${BARE_KEY}|${QUOTED_KEY})`;
const STRING_VAL = '"(?:[^"\\\\]|\\\\.)*"';

/**
 * Matches a line of the form  `indent key = "string"`  where `key` may be
 * dotted (`a.b.c`). Captures:
 *   group 1 — leading whitespace (indentation)
 *   group 2 — the full (possibly dotted) key
 *   group 3 — the JSON-style string literal, including quotes
 *
 * Does NOT match arrays, inline tables, or `[table.header]` lines.
 */
const LINE_REGEX = new RegExp(
    `^(\\s*)(${KEY}(?:\\.${KEY})*)\\s*=\\s*(${STRING_VAL})\\s*$`,
);

/**
 * Serialize an object to TOML, preserving multi-line strings as
 * `"""..."""` blocks. See the file header for the full rationale and scope.
 */
export function stringifyToml(obj: Record<string, unknown>): string {
    const base = smolStringify(obj);
    const lines = base.split("\n");
    const out: string[] = [];

    for (const line of lines) {
        const m = LINE_REGEX.exec(line);
        if (!m) {
            out.push(line);
            continue;
        }

        const indent = m[1]!;
        const key = m[2]!;
        const stringLiteral = m[3]!;

        // Recover the actual string value by parsing the JSON-style literal.
        // smol-toml emits strings via JSON.stringify, so this round-trips.
        let value: string;
        try {
            value = JSON.parse(stringLiteral) as string;
        } catch {
            out.push(line);
            continue;
        }

        if (!value.includes("\n")) {
            out.push(line);
            continue;
        }

        out.push(`${indent}${key} = """${escapeMultilineBody(value)}"""`);
    }

    return out.join("\n");
}

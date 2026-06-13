import { marked, type Tokens } from "marked";
import hljs from "highlight.js";
import { get } from "svelte/store";

import { enableMultilineTableCode, escapePipesInTableCode } from "$lib/stores";

/**
 * Helper to highlight code with a fallback to plain text.
 */
function highlightCode(code: string, lang?: string): string {
    if (lang && hljs.getLanguage(lang)) {
        try {
            return hljs.highlight(code, { language: lang }).value;
        } catch (_) {}
    }
    // Fallback: highlight auto, and if that fails, safely escape raw text
    try {
        return hljs.highlightAuto(code).value;
    } catch (_) {
        return code
            .replace(/&/g, "&amp;")
            .replace(/</g, "&lt;")
            .replace(/>/g, "&gt;");
    }
}

/**
 * Matches an inline code span whose text content starts with an optional
 * language identifier followed by a line-separator (\n literal or &lt;br&gt;).
 *
 * Marked converts ```lang\n...\n``` inside table cells into:
 *   <code>lang\ncontent\n</code>          (for \n variant)
 *   <code>lang&lt;br&gt;content&lt;br&gt;</code>  (for <br> variant)
 *
 * Groups: [1] = language (word chars, may be empty), [2] = body
 */
const CODE_SPAN_RE = /<code>(\w*?)(?:\\n|&lt;br\s*\/?\s*&gt;)([\s\S]*?)<\/code>/g;

/** Line-separator pattern inside the already-escaped code body. */
const LINE_SEP_RE = /\\n|&lt;br\s*\/?\s*&gt;/gi;

/**
 * Unescape HTML entities back to raw characters.
 */
function unescapeHtml(html: string): string {
    return html
        .replace(/\\&quot;/g, '"')
        .replace(/\\&#39;/g, "'")
        .replace(/\\&apos;/g, "'")
        .replace(/\\"/g, '"')
        .replace(/\\'/g, "'")
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&apos;/g, "'")
        .replace(/&amp;/g, "&"); // Keep &amp; replacement last so we don't double unescape
}

/**
 * Transform inline code spans that represent fenced code blocks
 * into proper <pre><code> blocks within a table cell's HTML.
 */
export function expandCodeBlocksInCell(cellHtml: string): string {
    if (!cellHtml.includes("<code>")) {
        return cellHtml;
    }
    return cellHtml.replace(
        CODE_SPAN_RE,
        (_match: string, lang: string, body: string) => {
            const lines = body.replace(LINE_SEP_RE, "\n").replace(/\n$/, "");
            const rawCode = unescapeHtml(lines);
            const highlighted = highlightCode(rawCode, lang);
            const cls = lang ? ` class="language-${lang} hljs"` : " hljs";
            return `<pre><code${cls}>${highlighted}</code></pre>`;
        }
    );
}

/**
 * Escapes unescaped pipe characters (`|`) inside backtick code spans on
 * table rows so that the markdown table parser does not treat them as column
 * separators.  Only lines that begin with `|` (i.e. table rows) are touched.
 *
 * Robustness notes:
 *  - Separator rows (`| --- | --- |`) contain no backticks and pass through unchanged.
 *  - Already-escaped pipes (`\|`) are preserved via the lookbehind.
 *  - Backtick fences of any length are matched via backreference so a run of N
 *    backticks is only closed by another run of exactly N backticks, matching
 *    the CommonMark spec.
 *  - The `s` (dotAll) flag handles the `\n`-literal sequences that appear
 *    when code blocks are inlined into a single table row.
 */
export function preprocessMarkdown(src: string): string {
    if (!get(escapePipesInTableCode)) {
        return src;
    }
    // Split on real newlines only; \n literals inside cells are handled by the regex.
    const lines = src.split("\n");
    const result: string[] = [];
    // Matches a backtick fence of N backticks, then the shortest content that
    // ends with the same N backticks.  The `s` flag allows `.` to match \n
    // literals embedded in a single-line table cell.
    const BACKTICK_SPAN_RE = /(`+)(.*?)\1/gs;
    for (const line of lines) {
        // Only process lines that look like table rows.
        if (!line.trimStart().startsWith("|")) {
            result.push(line);
            continue;
        }
        // Skip pure separator rows — they never contain code spans.
        if (/^\s*\|[\s|:-]+\|\s*$/.test(line)) {
            result.push(line);
            continue;
        }
        // Reset lastIndex before each use because the regex is defined outside
        // the loop and has the `g` flag.
        BACKTICK_SPAN_RE.lastIndex = 0;
        const escaped = line.replace(
            BACKTICK_SPAN_RE,
            (_match: string, fence: string, content: string) => {
                // Escape unescaped pipes inside the code span content.
                const safeContent = content.replace(/(?<!\\)\|/g, "\\|");
                return `${fence}${safeContent}${fence}`;
            }
        );
        result.push(escaped);
    }
    return result.join("\n");
}

const renderer = new marked.Renderer();

renderer.tablecell = function (token: Tokens.TableCell) {
    const defaultHtml: string = marked.Renderer.prototype.tablecell.call(this, token);
    if (get(enableMultilineTableCode)) {
        return expandCodeBlocksInCell(defaultHtml);
    }
    return defaultHtml;
};

// Also highlight regular standalone code blocks
renderer.code = function (token: Tokens.Code) {
    const highlighted = highlightCode(token.text, token.lang);
    const cls = token.lang ? ` class="language-${token.lang} hljs"` : " hljs";
    return `<pre><code${cls}>${highlighted}</code></pre>`;
};

marked.use({ renderer });

export { marked };

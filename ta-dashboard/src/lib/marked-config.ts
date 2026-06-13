import { marked, type Tokens } from "marked";
import hljs from "highlight.js";

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

const renderer = new marked.Renderer();

renderer.tablecell = function (token: Tokens.TableCell) {
    const defaultHtml: string = marked.Renderer.prototype.tablecell.call(this, token);
    return expandCodeBlocksInCell(defaultHtml);
};

// Also highlight regular standalone code blocks
renderer.code = function (token: Tokens.Code) {
    const highlighted = highlightCode(token.text, token.lang);
    const cls = token.lang ? ` class="language-${token.lang} hljs"` : " hljs";
    return `<pre><code${cls}>${highlighted}</code></pre>`;
};

marked.use({ renderer });

export { marked };

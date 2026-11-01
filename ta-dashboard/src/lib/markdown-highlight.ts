import hljs from "highlight.js";

/**
 * Markdown source highlighting for the EPF config editor's prompt fields.
 *
 * highlight.js' Markdown grammar is regex-based and several of its modes have no
 * terminator: an emphasis it cannot close, an indented-code line, or an inline
 * HTML opener without a `>` all run to the end of the input. Everything after
 * them is swallowed by that span and never tokenized, so the rest of the prompt
 * loses its highlighting (and invalid `_` runs, such as the ones in
 * `{{base_role}}` or `snake_case`, produce italics that CommonMark forbids).
 *
 * Before highlighting, every such trigger is replaced with a one-character
 * placeholder ("shielded"), then restored in the generated HTML. The placeholders
 * are 1:1, so lengths, wrapping and caret positions are untouched and the mirror
 * in MarkdownField stays character-for-character identical to the textarea.
 */

const SHIELD = {
    underscore: "\uE000",
    star: "\uE001",
    space: "\uE002",
    tab: "\uE003",
    lessThan: "\uE004"
} as const;

const SHIELD_CHARS: readonly string[] = Object.values(SHIELD);

const EMPHASIS_SELECTOR = ".hljs-emphasis, .hljs-strong";
const OPEN_RUN_RE = /^(\*{1,3}|_{1,3})/;
const CLOSE_RUN_RE = /(\*{1,3}|_{1,3})$/;
const PUNCTUATION_RE = /\p{P}/u;
const WHITESPACE_RE = /\s/u;
const INDENTED_LINE_RE = /^(?: {4}|\t)/;
const LIST_ITEM_RE = /^[ \t]*(?:[-*+]|\d+[.)])\s/;
const INLINE_HTML_START_RE = /[A-Za-z_/]/;
const CARRIAGE_RETURN_RE = /\r\n?/g;

type Flanking = {
    /** The run is followed by content and can start an emphasis. */
    left: boolean;
    /** The run is preceded by content and can end an emphasis. */
    right: boolean;
    beforePunctuation: boolean;
    afterPunctuation: boolean;
};

type Delimiter = "_" | "*";

type DelimiterRun = {
    start: number;
    length: number;
    delimiter: Delimiter;
    canOpen: boolean;
    canClose: boolean;
    paired: boolean;
    /** A `*` that starts a bullet list item, not emphasis. */
    listMarker: boolean;
};

function isPunctuation(char: string): boolean {
    return char.length > 0 && PUNCTUATION_RE.test(char);
}

function isWhitespace(char: string): boolean {
    return char.length === 0 || WHITESPACE_RE.test(char);
}

/** CommonMark's left/right-flanking test for a delimiter run. */
function flanking(before: string, after: string): Flanking {
    const beforeSpace = isWhitespace(before);
    const afterSpace = isWhitespace(after);
    const beforePunctuation = isPunctuation(before);
    const afterPunctuation = isPunctuation(after);
    return {
        left: !afterSpace && (!afterPunctuation || beforeSpace || beforePunctuation),
        right: !beforeSpace && (!beforePunctuation || afterSpace || afterPunctuation),
        beforePunctuation,
        afterPunctuation
    };
}

/**
 * `_` may not open intraword emphasis, `*` may. `before` is the character
 * before the run, `after` the character after it.
 */
export function canOpenEmphasis(delimiter: string, before: string, after: string): boolean {
    const run = flanking(before, after);
    if (delimiter.startsWith("*")) {
        return run.left;
    }
    return run.left && (!run.right || run.beforePunctuation);
}

/** The closing counterpart of {@link canOpenEmphasis}. */
export function canCloseEmphasis(delimiter: string, before: string, after: string): boolean {
    const run = flanking(before, after);
    if (delimiter.startsWith("*")) {
        return run.right;
    }
    return run.right && (!run.left || run.afterPunctuation);
}

function isBulletMarker(source: string, start: number, length: number): boolean {
    const lineStart = source.lastIndexOf("\n", start - 1) + 1;
    if (source.slice(lineStart, start).trim().length > 0) {
        return false;
    }
    const next = source[start + length] ?? "";
    return next === " " || next === "\t";
}

function delimiterRuns(source: string): DelimiterRun[] {
    const runs: DelimiterRun[] = [];
    for (let index = 0; index < source.length; index += 1) {
        const delimiter = source[index];
        if (delimiter !== "_" && delimiter !== "*") {
            continue;
        }
        let end = index + 1;
        while (end < source.length && source[end] === delimiter) {
            end += 1;
        }
        const length = end - index;
        const before = index === 0 ? "" : source[index - 1]!;
        const after = source[end] ?? "";
        runs.push({
            start: index,
            length,
            delimiter,
            canOpen: canOpenEmphasis(delimiter, before, after),
            canClose: canCloseEmphasis(delimiter, before, after),
            paired: false,
            listMarker: delimiter === "*" && isBulletMarker(source, index, length)
        });
        index = end - 1;
    }
    return runs;
}

/**
 * Match openers with closers per delimiter. Runs that never pair are the ones
 * highlight.js would leave open, so they are the ones worth shielding.
 */
function pairDelimiters(runs: DelimiterRun[]): void {
    const delimiters: Delimiter[] = ["_", "*"];
    for (const delimiter of delimiters) {
        const openers: DelimiterRun[] = [];
        for (const run of runs) {
            if (run.delimiter !== delimiter) {
                continue;
            }
            if (run.canClose && openers.length > 0) {
                const opener = openers.pop()!;
                opener.paired = true;
                run.paired = true;
            } else if (run.canOpen) {
                openers.push(run);
            }
        }
    }
}

function shieldDelimiterRuns(source: string): string {
    const runs = delimiterRuns(source);
    pairDelimiters(runs);
    let result = "";
    let cursor = 0;
    for (const run of runs) {
        if (run.paired || run.listMarker) {
            continue;
        }
        const shield = run.delimiter === "_" ? SHIELD.underscore : SHIELD.star;
        result += source.slice(cursor, run.start) + shield.repeat(run.length);
        cursor = run.start + run.length;
    }
    return result + source.slice(cursor);
}

/**
 * The indented-code variant of highlight.js' code rule has no terminator: one
 * line indented by four spaces or a tab colours everything after it as code.
 * Shield the indentation of such lines (list items keep their own rule).
 */
function shieldIndentedCode(source: string): string {
    const lines = source.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
        const line = lines[index]!;
        if (!INDENTED_LINE_RE.test(line) || LIST_ITEM_RE.test(line)) {
            continue;
        }
        const shield = line[0] === "\t" ? SHIELD.tab : SHIELD.space;
        lines[index] = shield + line.slice(1);
    }
    return lines.join("\n");
}

/**
 * `<` followed by a letter starts highlight.js' inline-HTML mode, which ends at
 * the next `>`; when there is none it swallows the rest of the prompt.
 */
function shieldUnclosedInlineHtml(source: string): string {
    let result = source;
    let position = result.indexOf("<");
    while (position !== -1) {
        if (INLINE_HTML_START_RE.test(result[position + 1] ?? "") &&
            result.indexOf(">", position + 1) === -1) {
            result = result.slice(0, position) + SHIELD.lessThan + result.slice(position + 1);
        }
        position = result.indexOf("<", position + 1);
    }
    return result;
}

function shieldSource(source: string): string {
    return shieldUnclosedInlineHtml(shieldIndentedCode(shieldDelimiterRuns(source)));
}

function restoreShields(html: string): string {
    return html
        .replaceAll(SHIELD.underscore, "_")
        .replaceAll(SHIELD.star, "*")
        .replaceAll(SHIELD.space, " ")
        .replaceAll(SHIELD.tab, "\t")
        // A literal `<` in HTML text would re-parse as markup.
        .replaceAll(SHIELD.lessThan, "&lt;");
}

function containsShield(source: string): boolean {
    return SHIELD_CHARS.some((char) => source.includes(char));
}

function firstTextNode(root: Node): Text | null {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const node = walker.nextNode();
    return node === null ? null : (node as Text);
}

function lastTextNode(root: Node): Text | null {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    let last: Text | null = null;
    let node = walker.nextNode();
    while (node !== null) {
        last = node as Text;
        node = walker.nextNode();
    }
    return last;
}

/** Replace an element with its children, keeping every character in place. */
function unwrap(element: Element): void {
    const parent = element.parentNode;
    if (parent === null) {
        return;
    }
    while (element.firstChild !== null) {
        parent.insertBefore(element.firstChild, element);
    }
    parent.removeChild(element);
}

/**
 * Does the span between these source offsets start and end with delimiters that
 * CommonMark accepts as emphasis?
 *
 * A span highlight.js left unterminated (it runs those to the end of the input)
 * is not emphasis. Uneven delimiter runs are nested constructs, left to the
 * grammar.
 */
function isValidEmphasis(source: string, start: number, end: number): boolean {
    const content = source.slice(start, end);
    const open = OPEN_RUN_RE.exec(content);
    const close = CLOSE_RUN_RE.exec(content);
    if (open === null || close === null || open[1]![0] !== close[1]![0]) {
        return false;
    }
    // Uneven runs are nested emphasis that highlight.js built differently.
    if (open[1]!.length !== close[1]!.length) {
        return true;
    }
    const before = source.slice(0, start).slice(-1);
    const after = source.slice(end, end + 1);
    const innerBefore = content[open[1]!.length] ?? "";
    const innerAfter = content[content.length - close[1]!.length - 1] ?? "";
    return canOpenEmphasis(open[1]!, before, innerBefore) &&
        canCloseEmphasis(close[1]!, innerAfter, after);
}

/**
 * Safety net for emphasis the shield could not predict (e.g. the multiple-of-three
 * rule): unwrap spans whose delimiters CommonMark rejects.
 */
function correctEmphasis(html: string, source: string): string {
    if (!html.includes("hljs-emphasis") && !html.includes("hljs-strong")) {
        return html;
    }
    const container = document.createElement("div");
    container.innerHTML = html;
    // The mirror must contain exactly the source text, otherwise the offsets
    // below are meaningless and no correction is attempted.
    if (container.textContent !== source) {
        return html;
    }
    const spans = Array.from(container.querySelectorAll<HTMLElement>(EMPHASIS_SELECTOR));
    if (spans.length === 0) {
        return html;
    }

    const offsets = new Map<Text, number>();
    let offset = 0;
    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
    let node = walker.nextNode();
    while (node !== null) {
        offsets.set(node as Text, offset);
        offset += (node as Text).data.length;
        node = walker.nextNode();
    }

    let changed = false;
    for (const span of spans) {
        const first = firstTextNode(span);
        const last = lastTextNode(span);
        if (first === null || last === null) {
            continue;
        }
        const start = offsets.get(first) ?? 0;
        const end = (offsets.get(last) ?? 0) + last.data.length;
        if (isValidEmphasis(source, start, end)) {
            continue;
        }
        unwrap(span);
        changed = true;
    }
    return changed ? container.innerHTML : html;
}

/**
 * Highlight Markdown source for display behind the editor's textarea.
 *
 * The returned HTML contains the source verbatim (entities aside), so it can be
 * layered underneath the textarea without changing glyph positions.
 */
export function highlightMarkdownSource(source: string): string {
    // The HTML parser normalizes CRLF to LF, so everything downstream works on
    // the normalized text; that also keeps the emphasis offsets aligned.
    const text = source.replace(CARRIAGE_RETURN_RE, "\n");
    const shieldable = !containsShield(text);
    const prepared = shieldable ? shieldSource(text) : text;
    const html = hljs.highlight(prepared, { language: "markdown", ignoreIllegals: true }).value;
    const restored = shieldable ? restoreShields(html) : html;
    if (typeof document === "undefined") {
        return restored;
    }
    try {
        return correctEmphasis(restored, text);
    } catch {
        // Highlighting must never break editing.
        return restored;
    }
}

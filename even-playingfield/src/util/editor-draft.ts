/**
 * Persisted editor drafts.
 *
 * The envelope is versioned independently of the config schema. A draft keeps
 * the serialized TOML text plus enough metadata to decide whether it still
 * belongs to the source the user is opening.
 */

export const EDITOR_DRAFT_VERSION = 1;
export const MAX_EDITOR_DRAFTS = 10;

export type EditorDraft = {
    /** Source key: `path:<absolute>`, `url:<url>`, `inline:<label>`, or `new`. */
    sourceKey: string;
    sourceLabel: string;
    /** Hash of the source text the draft started from. */
    baseHash: string;
    /** Config schema version at the time of the draft. */
    configVersion: number;
    /** Set when the draft came from an older config the user migrated. */
    migratedFrom: number | null;
    text: string;
    savedAt: number;
};

export type EditorDraftFile = {
    version: number;
    drafts: Record<string, EditorDraft>;
};

/** Draft key for a document that has no source yet ("New config"). */
export const NEW_DRAFT_KEY = "new";

/** The slice of `ConfigSource` a draft key needs (structural, no import). */
export type DraftSource =
    | { kind: "path"; path: string }
    | { kind: "url"; url: string }
    | { kind: "inline"; label: string };

/**
 * Key a draft and its DOM ids use for a config source. One definition shared
 * by the host (which moves/deletes drafts when a file is renamed) and the
 * editor (which reads and writes them), so the two cannot disagree.
 */
export function editorDraftKey(source: DraftSource | null): string {
    if (source === null) {
        return NEW_DRAFT_KEY;
    }
    switch (source.kind) {
        case "path":
            return `path:${source.path}`;
        case "url":
            return `url:${source.url}`;
        case "inline":
            return `inline:${source.label}`;
    }
}

export function createEmptyEditorDraftFile(): EditorDraftFile {
    return { version: EDITOR_DRAFT_VERSION, drafts: {} };
}

function asNumber(value: unknown): number | null {
    return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * Read a persisted draft file defensively. Unknown fields are ignored and
 * malformed entries are dropped rather than crashing the editor.
 */
export function coerceEditorDraftFile(raw: unknown): EditorDraftFile {
    const file = createEmptyEditorDraftFile();
    if (typeof raw !== "object" || raw === null) {
        return file;
    }
    const record = raw as Record<string, unknown>;
    const drafts = record["drafts"];
    if (typeof drafts !== "object" || drafts === null) {
        return file;
    }
    for (const [key, value] of Object.entries(drafts)) {
        if (typeof value !== "object" || value === null) {
            continue;
        }
        const entry = value as Record<string, unknown>;
        if (typeof entry["text"] !== "string" || entry["text"].length === 0) {
            continue;
        }
        const configVersion = asNumber(entry["configVersion"]);
        const savedAt = asNumber(entry["savedAt"]);
        if (configVersion === null || savedAt === null) {
            continue;
        }
        const migratedFrom = asNumber(entry["migratedFrom"]);
        const sourceKey = typeof entry["sourceKey"] === "string" && entry["sourceKey"].length > 0
            ? entry["sourceKey"]
            : key;
        file.drafts[sourceKey] = {
            sourceKey,
            sourceLabel: typeof entry["sourceLabel"] === "string" ? entry["sourceLabel"] : sourceKey,
            baseHash: typeof entry["baseHash"] === "string" ? entry["baseHash"] : "",
            configVersion,
            migratedFrom,
            text: entry["text"],
            savedAt,
        };
    }
    pruneEditorDrafts(file);
    return file;
}

/** Keep the newest `MAX_EDITOR_DRAFTS` entries. Mutates and returns `file`. */
export function pruneEditorDrafts(file: EditorDraftFile): EditorDraftFile {
    const entries = Object.entries(file.drafts);
    if (entries.length <= MAX_EDITOR_DRAFTS) {
        return file;
    }
    entries.sort((a, b) => a[1].savedAt - b[1].savedAt);
    for (const [key] of entries.slice(0, entries.length - MAX_EDITOR_DRAFTS)) {
        delete file.drafts[key];
    }
    return file;
}

/**
 * FNV-1a hash of the source text. Used only to detect that a file changed
 * underneath a draft, not for security.
 */
export function hashText(text: string): string {
    let hash = 0x811c9dc5;
    for (let index = 0; index < text.length; index += 1) {
        hash ^= text.charCodeAt(index);
        hash = Math.imul(hash, 0x01000193);
    }
    return (hash >>> 0).toString(16).padStart(8, "0");
}

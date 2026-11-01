import { describe, expect, test } from "bun:test";

import {
    coerceEditorDraftFile,
    createEmptyEditorDraftFile,
    editorDraftKey,
    hashText,
    pruneEditorDrafts,
} from "./editor-draft.ts";
import type { EditorDraft } from "./editor-draft.ts";

function draft(sourceKey: string, savedAt: number): EditorDraft {
    return {
        sourceKey,
        sourceLabel: sourceKey,
        baseHash: hashText("base"),
        configVersion: 5,
        migratedFrom: null,
        text: "version = 5\n",
        savedAt,
    };
}

describe("editor drafts", () => {
    test("hashes text deterministically", () => {
        expect(hashText("version = 5\n")).toBe(hashText("version = 5\n"));
        expect(hashText("a")).not.toBe(hashText("b"));
    });

    test("coerces a persisted blob and drops malformed entries", () => {
        const file = coerceEditorDraftFile({
            version: 1,
            drafts: {
                path: draft("path", 1),
                broken: { text: "" },
                missing: null,
            },
        });
        expect(Object.keys(file.drafts)).toEqual(["path"]);
        expect(file.drafts["path"]?.text).toBe("version = 5\n");
    });

    test("keeps only the newest drafts", () => {
        const file = createEmptyEditorDraftFile();
        for (let index = 0; index < 12; index += 1) {
            file.drafts[`draft-${index}`] = draft(`draft-${index}`, index);
        }
        pruneEditorDrafts(file);
        expect(Object.keys(file.drafts).length).toBe(10);
        expect(file.drafts["draft-0"]).toBeUndefined();
        expect(file.drafts["draft-11"]).toBeDefined();
    });

    test("derives one stable key per source kind", () => {
        expect(editorDraftKey(null)).toBe("new");
        expect(editorDraftKey({ kind: "path", path: "/epf/home/epf.toml" })).toBe("path:/epf/home/epf.toml");
        expect(editorDraftKey({ kind: "url", url: "https://example.test/epf.toml" }))
            .toBe("url:https://example.test/epf.toml");
        expect(editorDraftKey({ kind: "inline", label: "session config" })).toBe("inline:session config");
    });
});

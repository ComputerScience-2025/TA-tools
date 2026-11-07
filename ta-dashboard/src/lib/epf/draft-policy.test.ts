import { describe, expect, test } from "bun:test";

import { decideDraftAction } from "./draft-policy.ts";

describe("decideDraftAction", () => {
    test("discards a draft the editor already holds", () => {
        expect(
            decideDraftAction({
                draftText: "same",
                editorText: "same",
                draftBaseHash: "a",
                editorBaseHash: "b",
                hasDocument: true
            })
        ).toBe("discard");
    });

    test("restores a draft based on the current text", () => {
        expect(
            decideDraftAction({
                draftText: "edited",
                editorText: "base",
                draftBaseHash: "same",
                editorBaseHash: "same",
                hasDocument: true
            })
        ).toBe("restore");
    });

    test("restores when no document is open", () => {
        expect(
            decideDraftAction({
                draftText: "edited",
                editorText: "",
                draftBaseHash: "a",
                editorBaseHash: "b",
                hasDocument: false
            })
        ).toBe("restore");
    });

    test("reports a conflict when the base text changed", () => {
        expect(
            decideDraftAction({
                draftText: "edited",
                editorText: "base",
                draftBaseHash: "a",
                editorBaseHash: "b",
                hasDocument: true
            })
        ).toBe("conflict");
    });
});

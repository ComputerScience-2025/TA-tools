/**
 * Policy for reconciling an unsaved editor draft with the open document.
 *
 * Kept pure and separate from the editor so route changes (which unmount and
 * remount the Config panel) cannot silently change what happens to drafts.
 */

export type DraftAction = "discard" | "restore" | "conflict";

export type DraftComparison = {
    draftText: string;
    editorText: string;
    draftBaseHash: string;
    editorBaseHash: string;
    hasDocument: boolean;
};

export function decideDraftAction(input: DraftComparison): DraftAction {
    // The draft matches what the editor already holds: it is stale.
    if (input.draftText === input.editorText) {
        return "discard";
    }
    // A draft based on the current text (or no open document) can be restored.
    if (!input.hasDocument || input.draftBaseHash === input.editorBaseHash) {
        return "restore";
    }
    return "conflict";
}

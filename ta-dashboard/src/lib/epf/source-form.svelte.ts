/**
 * Source-panel input that should survive a route change.
 *
 * The EPF tabs are real routes, so the Source page unmounts when another tab is
 * opened. The GitHub URL and upload directory are in-progress UI state: keep
 * them in memory for this browser session only, never in browser storage.
 */

export type SourceMode = "url" | "fields";

class SourceFormState {
    mode = $state<SourceMode>("url");
    githubUrl = $state("https://github.com/");
    owner = $state("");
    repo = $state("");
    ref = $state("");
    directory = $state("");
    /** Upload target relative to the workspace root. */
    targetDirectory = $state("");
}

export const sourceForm = new SourceFormState();

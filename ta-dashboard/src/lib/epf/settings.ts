import { persisted } from "svelte-persisted-store";

/**
 * Dashboard-side EPF preferences.
 *
 * These are UI concerns (the config-file equivalent lives in `epf.toml`), so
 * they use the same `localStorage`-backed store as the rest of the dashboard.
 */

/** Show the file list of the active workspace in the Source panel. */
export const epfShowWorkspaceFiles = persisted("epfShowWorkspaceFiles", true);

/** Start the run automatically after a one-click fetch. */
export const epfAutoRunAfterFetch = persisted("epfAutoRunAfterFetch", true);

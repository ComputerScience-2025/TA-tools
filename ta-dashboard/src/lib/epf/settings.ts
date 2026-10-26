import { persisted } from "svelte-persisted-store";

/**
 * Dashboard-side EPF preferences.
 *
 * These are UI concerns (the config-file equivalent lives in `epf.toml`), so
 * they use the same `localStorage`-backed store as the rest of the dashboard.
 */

/**
 * When off (the default), API keys and tokens stay in memory for this tab
 * session and are never written to browser storage.
 */
export const epfRememberSecrets = persisted("epfRememberSecrets", false);

/** Show the file list of the active workspace in the Source panel. */
export const epfShowWorkspaceFiles = persisted("epfShowWorkspaceFiles", true);

/** Start the run automatically after a one-click fetch. */
export const epfAutoRunAfterFetch = persisted("epfAutoRunAfterFetch", true);

/**
 * Registry of download remotes.
 *
 * To add a new remote, implement {@link RemoteSource} and add it to this
 * array — the CLI host and runner discover it automatically.
 */

import type { RemoteSource } from "./types.ts";
import { githubRemote } from "./github.ts";

const REMOTES: readonly RemoteSource[] = [
    githubRemote,
];

/** Look up a remote by its CLI name (case-insensitive). */
export function getRemote(name: string): RemoteSource | null {
    const normalized = name.trim().toLowerCase();
    for (const remote of REMOTES) {
        if (remote.name === normalized) {
            return remote;
        }
    }
    return null;
}

/** All registered remotes. */
export function listRemotes(): readonly RemoteSource[] {
    return REMOTES;
}

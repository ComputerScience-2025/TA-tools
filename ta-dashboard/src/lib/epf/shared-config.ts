/**
 * Parsing for config URLs offered through the page hash.
 *
 * A shared link looks like `#?EPF_CONFIG_URL=https%3A%2F%2F…` (the `config`
 * alias is accepted for older hand-written links). Keeping the parsing pure
 * lets the layout stay a UI concern and the behaviour stay tested.
 */

export const SHARED_CONFIG_PARAM = "EPF_CONFIG_URL";
export const SHARED_CONFIG_ALIAS = "config";

/** Config URL encoded in a location hash, or null when there is none. */
export function sharedConfigUrlFromHash(hash: string): string | null {
    const raw = hash.startsWith("#") ? hash.slice(1) : hash;
    const queryStart = raw.indexOf("?");
    if (queryStart < 0) {
        return null;
    }
    const params = new URLSearchParams(raw.slice(queryStart + 1));
    const value = (params.get(SHARED_CONFIG_PARAM) ?? params.get(SHARED_CONFIG_ALIAS) ?? "").trim();
    return /^https?:\/\//i.test(value) ? value : null;
}

/**
 * Remove the config params, keeping the hash route and any other params.
 * Returns the new hash (without `#`), or null when there was nothing to strip.
 */
export function stripSharedConfigHash(hash: string): string | null {
    const raw = hash.startsWith("#") ? hash.slice(1) : hash;
    const queryStart = raw.indexOf("?");
    if (queryStart < 0) {
        return null;
    }
    const route = raw.slice(0, queryStart);
    const params = new URLSearchParams(raw.slice(queryStart + 1));
    if (!params.has(SHARED_CONFIG_PARAM) && !params.has(SHARED_CONFIG_ALIAS)) {
        return null;
    }
    params.delete(SHARED_CONFIG_PARAM);
    params.delete(SHARED_CONFIG_ALIAS);
    const query = params.toString();
    return query.length > 0 ? `${route}?${query}` : route;
}

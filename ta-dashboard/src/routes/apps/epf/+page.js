import { redirect } from "@sveltejs/kit";

import { epfIndexRedirectTarget } from "$lib/epf/routes.ts";

/**
 * The EPF app has no index content of its own: Source is the default tab.
 * Search and hash are preserved so shared config links still work.
 *
 * The hash is client-only state: `load`'s `url` has no fragment, and this
 * route is never server-rendered (`ssr` is false in `+layout.js`), so read it
 * from `window` when it exists.
 */
export function load({ url }) {
	const hash = typeof window === "undefined" ? "" : window.location.hash;
	redirect(307, epfIndexRedirectTarget({ search: url.search, hash }));
}

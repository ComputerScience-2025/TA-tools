import { redirect } from "@sveltejs/kit";

import { configHref } from "$lib/epf/routes.ts";

/** The Config root has no content of its own: Editor is the default section. */
export function load() {
	redirect(307, configHref("editor"));
}

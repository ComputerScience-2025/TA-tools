/**
 * Route metadata and URL helpers for the browser EPF app.
 *
 * Every tab is a SvelteKit route, so navigation belongs to the framework. This
 * module only centralises the paths and labels: links, redirects and the active
 * tab all read from here instead of repeating route strings.
 */

/** Tabs under the EPF app. Source is the index target. */
export type EpfTab = "source" | "config" | "console" | "outputs";

export type EpfTabSpec = {
    id: EpfTab;
    label: string;
    href: string;
};

/** Sub-routes of the Config tab. */
export type ConfigTab = "editor" | "library" | "environment" | "storage";

export type ConfigTabSpec = {
    id: ConfigTab;
    label: string;
    href: string;
};

/** Base path of the browser EPF app. */
export const EPF_ROOT = "/apps/epf";

/** Base path of the Config sub-routes. */
export const CONFIG_ROOT = `${EPF_ROOT}/config`;

export const EPF_HREFS: Record<EpfTab, string> = {
    source: `${EPF_ROOT}/source`,
    config: CONFIG_ROOT,
    console: `${EPF_ROOT}/console`,
    outputs: `${EPF_ROOT}/outputs`
};

export const EPF_TABS: readonly EpfTabSpec[] = [
    { id: "source", label: "Source", href: EPF_HREFS.source },
    { id: "config", label: "Config", href: EPF_HREFS.config },
    { id: "console", label: "Console", href: EPF_HREFS.console },
    { id: "outputs", label: "Outputs", href: EPF_HREFS.outputs }
];

export const CONFIG_TABS: readonly ConfigTabSpec[] = [
    { id: "editor", label: "Editor", href: `${CONFIG_ROOT}/editor` },
    { id: "library", label: "Library", href: `${CONFIG_ROOT}/library` },
    { id: "environment", label: "Environment", href: `${CONFIG_ROOT}/environment` },
    { id: "storage", label: "Storage", href: `${CONFIG_ROOT}/storage` }
];

/** Route for a tab. */
export function epfHref(tab: EpfTab): string {
    return EPF_HREFS[tab];
}

/** Route for a Config sub-section. */
export function configHref(tab: ConfigTab = "editor"): string {
    return `${CONFIG_ROOT}/${tab}`;
}

export function isEpfTab(value: string): value is EpfTab {
    return EPF_TABS.some((entry) => entry.id === value);
}

export function isConfigTab(value: string | null | undefined): value is ConfigTab {
    return value !== null && value !== undefined && CONFIG_TABS.some((entry) => entry.id === value);
}

/** Tab the pathname belongs to; `/apps/epf` itself behaves as Source. */
export function epfTabForPath(pathname: string): EpfTab | null {
    const path = pathname.length > 1 && pathname.endsWith("/") ? pathname.slice(0, -1) : pathname;
    if (path === EPF_ROOT) {
        return "source";
    }
    const prefix = `${EPF_ROOT}/`;
    if (!path.startsWith(prefix)) {
        return null;
    }
    const segment = path.slice(prefix.length).split("/")[0] ?? "";
    return isEpfTab(segment) ? segment : null;
}

/** Config sub-section the pathname belongs to, or null outside a sub-route. */
export function configTabForPath(pathname: string): ConfigTab | null {
    const prefix = `${CONFIG_ROOT}/`;
    if (!pathname.startsWith(prefix)) {
        return null;
    }
    const segment = pathname.slice(prefix.length).split("/")[0] ?? "";
    return isConfigTab(segment) ? segment : null;
}

/** Target of the `/apps/epf` index redirect, preserving search and hash. */
export function epfIndexRedirectTarget(url: { search: string; hash: string }): string {
    return `${epfHref("source")}${url.search}${url.hash}`;
}

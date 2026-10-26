/**
 * Every environment variable EPF reads, in one place.
 *
 * There is no environment in a browser, so the web UI renders this registry as
 * a settings panel (`util/env-vars.ts` is imported by both the CLI help text
 * and the dashboard). Adding an env-only option here is all that is needed for
 * it to show up in both places.
 */

export type EnvVarScope = "core" | "download";

export type EnvVarSpec = {
    name: string;
    description: string;
    scope: EnvVarScope;
    /** Masked in the UI and kept session-only unless the user opts in. */
    secret?: boolean;
    /** Shown as placeholder text in the UI. */
    example?: string;
};

/** Config resolution falls back to this path or URL. */
export const CONFIG_URL_ENV_VAR = "EPF_CONFIG_URL";
/** Token for GitHub downloads (`epf download`, and the web GitHub source). */
export const GITHUB_PAT_ENV_VAR = "EPF_DOWNLOAD_GITHUB_PAT";

export const ENV_VARS: readonly EnvVarSpec[] = [
    {
        name: CONFIG_URL_ENV_VAR,
        description: "Load the config from this path or URL when no config source is chosen explicitly.",
        scope: "core",
        example: "https://example.test/epf.toml",
    },
    {
        name: GITHUB_PAT_ENV_VAR,
        description: "GitHub token used to fetch repositories. Optional for public repositories.",
        scope: "download",
        secret: true,
        example: "ghp_…",
    },
];

export function getEnvVarSpec(name: string): EnvVarSpec | undefined {
    return ENV_VARS.find((spec) => spec.name === name);
}

export function envVarsByScope(scope: EnvVarScope): EnvVarSpec[] {
    return ENV_VARS.filter((spec) => spec.scope === scope);
}

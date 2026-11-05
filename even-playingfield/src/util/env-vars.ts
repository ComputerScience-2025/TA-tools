/**
 * Every environment variable EPF reads, in one place.
 *
 * There is no environment in a browser, so the web UI renders this registry as
 * a settings panel (`util/env-vars.ts` is imported by both the CLI help text
 * and the dashboard). Adding an env-only option here is all that is needed for
 * it to show up in both places.
 */

export type EnvVarScope = "core" | "download" | "storage";

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

/** S3-compatible object storage used by "Save as → S3 bucket". */
export const S3_ENDPOINT_ENV_VAR = "EPF_S3_ENDPOINT";
export const S3_REGION_ENV_VAR = "EPF_S3_REGION";
export const S3_BUCKET_ENV_VAR = "EPF_S3_BUCKET";
/** Optional key prefix applied to uploaded config files, e.g. `configs`. */
export const S3_PREFIX_ENV_VAR = "EPF_S3_PREFIX";
export const S3_ACCESS_KEY_ID_ENV_VAR = "EPF_S3_ACCESS_KEY_ID";
export const S3_SECRET_ACCESS_KEY_ENV_VAR = "EPF_S3_SECRET_ACCESS_KEY";
/** `path` or `virtual`; no automatic detection. */
export const S3_ADDRESSING_STYLE_ENV_VAR = "EPF_S3_ADDRESSING_STYLE";
/** Optional public URL prefix, so a saved object can be opened as a config URL. */
export const S3_PUBLIC_BASE_URL_ENV_VAR = "EPF_S3_PUBLIC_BASE_URL";

export const ENV_VARS: readonly EnvVarSpec[] = [
    {
        name: CONFIG_URL_ENV_VAR,
        description: "Load the config from this path or URL when no config source is chosen explicitly.",
        scope: "core",
        example: "https://example.test/epf.toml",
    },
    {
        name: S3_ENDPOINT_ENV_VAR,
        description: "S3-compatible API endpoint. B2: https://s3.<region>.backblazeb2.com; R2: https://<account-id>.r2.cloudflarestorage.com.",
        scope: "storage",
        example: "https://s3.us-west-004.backblazeb2.com",
    },
    {
        name: S3_REGION_ENV_VAR,
        description: "Signing region. Leave blank to infer it from the endpoint; use 'auto' for R2 and the B2 region for B2.",
        scope: "storage",
        example: "auto",
    },
    {
        name: S3_BUCKET_ENV_VAR,
        description: "Bucket that receives saved config files.",
        scope: "storage",
        example: "ta-configs",
    },
    {
        name: S3_PREFIX_ENV_VAR,
        description: "Optional key prefix for saved config files and the connection test, e.g. 'configs'. Leave blank for the bucket root.",
        scope: "storage",
        example: "configs",
    },
    {
        name: S3_ACCESS_KEY_ID_ENV_VAR,
        description: "Access key ID for the S3-compatible endpoint.",
        scope: "storage",
        example: "access key id",
    },
    {
        name: S3_SECRET_ACCESS_KEY_ENV_VAR,
        description: "Secret access key. Stays in memory unless 'Remember on this device' is enabled.",
        scope: "storage",
        secret: true,
        example: "secret access key",
    },
    {
        name: S3_ADDRESSING_STYLE_ENV_VAR,
        description: "How to address objects: 'path' (endpoint/bucket/key) or 'virtual' (bucket.endpoint/key). Use 'virtual' for Backblaze B2 and AWS; 'path' for R2/MinIO.",
        scope: "storage",
        example: "virtual",
    },
    {
        name: S3_PUBLIC_BASE_URL_ENV_VAR,
        description: "Optional public URL prefix (for example an R2 public domain). When set, a saved object can be opened as a config URL.",
        scope: "storage",
        example: "https://configs.example.com/epf",
    },
    {
        name: GITHUB_PAT_ENV_VAR,
        description: "GitHub token used to fetch repositories. Optional for public repositories.",
        scope: "download",
        secret: true,
        example: "ghp_…",
    },
];

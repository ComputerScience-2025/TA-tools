/**
 * GitHub remote backend for `epf download`.
 *
 * Supports directory and file URLs:
 *   https://github.com/{owner}/{repo}/tree/{ref}/{dir}
 *   https://github.com/{owner}/{repo}/blob/{ref}/{file}
 *
 * Uses the REST API. A personal access token read from
 * `EPF_DOWNLOAD_GITHUB_PAT` is optional (required for private repos) and is
 * sent as a bearer token.
 */

import { basename } from "node:path";

import type {
    DownloadPlan,
    EnvVars,
    RemoteFile,
    RemoteSource,
} from "./types.ts";

/** Env var holding the GitHub PAT. Optional; needed for private repos. */
export const GITHUB_PAT_ENV_VAR = "EPF_DOWNLOAD_GITHUB_PAT";

const GITHUB_HOST = "github.com";
const GITHUB_API_BASE = "https://api.github.com";
const GITHUB_API_VERSION = "2022-11-28";
const USER_AGENT = "even-pf-download";
const REFS_PER_PAGE = 100;
// Cap ref pagination so a repo with an enormous ref list cannot stall us.
const MAX_REF_PAGES = 10;

/** Parsed form of a supported GitHub URL. */
export type GithubUrl = {
    owner: string;
    repo: string;
    mode: "tree" | "blob";
    /** Everything after `/tree/` or `/blob/`, i.e. `ref` or `ref/path`. */
    refAndPath: string;
};

/** A ref/path split resolved from an ambiguous `refAndPath` string. */
export type ResolvedRef = {
    ref: string;
    path: string;
};

type ApiResult<T> =
    | { ok: true; data: T }
    | { ok: false; status: number; message: string };

type MatchingRef = { ref: string };
type TreeEntry = { path: string; type: "blob" | "tree" | "commit"; sha: string };
type TreeResponse = { tree: TreeEntry[]; truncated?: boolean };
type CommitResponse = { sha: string; commit: { tree: { sha: string } } };
type BlobResponse = { content: string; encoding: string };
type ContentEntry = { path: string; sha: string; type: "file" | "dir" | "symlink" | "submodule" };

/** Parse a GitHub URL into owner/repo/mode/refAndPath, or null if unsupported. */
export function parseGithubUrl(input: string): GithubUrl | null {
    let url: URL;
    try {
        url = new URL(input);
    } catch {
        return null;
    }

    if (url.hostname.toLowerCase() !== GITHUB_HOST) {
        return null;
    }

    const segments = url.pathname.split("/").filter((s) => s.length > 0);
    if (segments.length < 4) {
        return null;
    }

    const owner = segments[0]!;
    const repo = segments[1]!.replace(/\.git$/i, "");
    const mode = segments[2]!.toLowerCase();
    if (mode !== "tree" && mode !== "blob") {
        return null;
    }

    const refAndPath = segments.slice(3).join("/");
    if (refAndPath.length === 0) {
        return null;
    }

    return { owner, repo, mode, refAndPath };
}

/**
 * Split `refAndPath` into a ref and a path using the repo's known ref names.
 * Picks the **longest** ref that is a prefix so branches containing slashes
 * (e.g. `feature/foo`) win over a shorter overlapping ref (`feature`).
 * Returns null when no known ref matches.
 */
export function matchRef(refAndPath: string, refNames: readonly string[]): ResolvedRef | null {
    let best: ResolvedRef | null = null;
    for (const name of refNames) {
        if (name.length === 0) {
            continue;
        }
        if (refAndPath === name) {
            if (best === null || name.length > best.ref.length) {
                best = { ref: name, path: "" };
            }
        } else if (refAndPath.startsWith(`${name}/`)) {
            if (best === null || name.length > best.ref.length) {
                best = { ref: name, path: refAndPath.slice(name.length + 1) };
            }
        }
    }
    return best;
}

/** Build request headers, adding bearer auth only when a token is present. */
function buildHeaders(token: string | undefined): Record<string, string> {
    const headers: Record<string, string> = {
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": GITHUB_API_VERSION,
        "User-Agent": USER_AGENT,
    };
    if (token !== undefined && token.trim().length > 0) {
        headers["Authorization"] = `Bearer ${token}`;
    }
    return headers;
}

/** Encode a ref/path for use inside a URL path segment, keeping `:` and `/`. */
function encodeRefPath(value: string): string {
    return value
        .split("/")
        .map((segment) => encodeURIComponent(segment).replaceAll("%3A", ":"))
        .join("/");
}

async function apiGet<T>(url: string, headers: Record<string, string>): Promise<ApiResult<T>> {
    const response = await fetch(url, { headers });
    if (!response.ok) {
        let message = `${response.status} ${response.statusText}`;
        try {
            const body = await response.json() as { message?: unknown };
            if (typeof body.message === "string") {
                message = body.message;
            }
        } catch {
            // Non-JSON error body; keep the status-line message.
        }
        return { ok: false, status: response.status, message };
    }
    const data = await response.json() as T;
    return { ok: true, data };
}

/**
 * List ref names that could be the ref portion of `refAndPath`.
 *
 * Uses the `matching-refs` endpoint scoped to the first path segment, so we
 * only fetch refs that share that prefix (typically a handful) instead of the
 * entire branch/tag list. The true ref always starts with the first segment
 * of `refAndPath` because `refAndPath` is `ref` or `ref + "/" + path`.
 */
async function listRefNames(
    owner: string,
    repo: string,
    prefix: string,
    headers: Record<string, string>,
): Promise<string[]> {
    const names: string[] = [];
    for (const kind of ["heads", "tags"] as const) {
        const refPrefix = `refs/${kind}/`;
        for (let page = 1; page <= MAX_REF_PAGES; page++) {
            const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/git/matching-refs/${kind}/${encodeRefPath(prefix)}?per_page=${REFS_PER_PAGE}&page=${page}`;
            const result = await apiGet<MatchingRef[]>(url, headers);
            if (!result.ok) {
                break;
            }
            for (const ref of result.data) {
                if (ref.ref.startsWith(refPrefix)) {
                    names.push(ref.ref.slice(refPrefix.length));
                }
            }
            if (result.data.length < REFS_PER_PAGE) {
                break;
            }
        }
    }
    return names;
}

/**
 * Resolve `refAndPath` to a ref and a path. Prefers a longest-prefix match
 * against the repo's refs (so branches containing slashes win); falls back to
 * treating the first segment as the ref, which also covers commit SHAs.
 */
async function resolveRefAndPath(
    owner: string,
    repo: string,
    refAndPath: string,
    headers: Record<string, string>,
): Promise<ResolvedRef> {
    const firstSegment = refAndPath.includes("/") ? refAndPath.slice(0, refAndPath.indexOf("/")) : refAndPath;
    const refNames = await listRefNames(owner, repo, firstSegment, headers);
    const matched = matchRef(refAndPath, refNames);
    if (matched !== null) {
        return matched;
    }

    const slashIndex = refAndPath.indexOf("/");
    if (slashIndex === -1) {
        return { ref: refAndPath, path: "" };
    }
    return { ref: refAndPath.slice(0, slashIndex), path: refAndPath.slice(slashIndex + 1) };
}

/** Fetch a blob's bytes by SHA. */
async function fetchBlob(
    owner: string,
    repo: string,
    sha: string,
    headers: Record<string, string>,
): Promise<Uint8Array> {
    const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/git/blobs/${sha}`;
    const result = await apiGet<BlobResponse>(url, headers);
    if (!result.ok) {
        throw new Error(`Failed to fetch blob ${sha}: ${result.message}`);
    }
    if (result.data.encoding !== "base64") {
        throw new Error(`Unexpected blob encoding for ${sha}: ${result.data.encoding}`);
    }
    return new Uint8Array(Buffer.from(result.data.content, "base64"));
}

/** Resolve a ref (branch, tag, or commit SHA) to its commit's root tree SHA. */
async function resolveRootTreeSha(
    owner: string,
    repo: string,
    ref: string,
    headers: Record<string, string>,
): Promise<string> {
    const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/commits/${encodeRefPath(ref)}`;
    const result = await apiGet<CommitResponse>(url, headers);
    if (!result.ok) {
        throw new Error(`Failed to resolve ref '${ref}': ${result.message}`);
    }
    return result.data.commit.tree.sha;
}

/** Walk down `path` from the root tree, returning the target directory's tree SHA. */
async function resolveSubtreeSha(
    owner: string,
    repo: string,
    rootTreeSha: string,
    path: string,
    headers: Record<string, string>,
): Promise<string> {
    const segments = path.split("/").filter((s) => s.length > 0);
    let currentSha = rootTreeSha;
    for (const segment of segments) {
        const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/git/trees/${currentSha}`;
        const result = await apiGet<TreeResponse>(url, headers);
        if (!result.ok) {
            throw new Error(`Failed to list tree ${currentSha}: ${result.message}`);
        }
        const match = result.data.tree.find((entry) => entry.path === segment && entry.type === "tree");
        if (match === undefined) {
            throw new Error(`Path '${path}' not found (missing directory '${segment}').`);
        }
        currentSha = match.sha;
    }
    return currentSha;
}

/** Build the plan for a `/tree/` (directory) URL. */
async function planTree(
    owner: string,
    repo: string,
    resolved: ResolvedRef,
    headers: Record<string, string>,
): Promise<RemoteFile[]> {
    const rootTreeSha = await resolveRootTreeSha(owner, repo, resolved.ref, headers);
    const targetTreeSha = await resolveSubtreeSha(owner, repo, rootTreeSha, resolved.path, headers);

    const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/git/trees/${targetTreeSha}?recursive=1`;
    const result = await apiGet<TreeResponse>(url, headers);
    if (!result.ok) {
        throw new Error(`Failed to list tree '${resolved.ref}:${resolved.path}': ${result.message}`);
    }
    if (result.data.truncated === true) {
        console.warn("Warning: GitHub truncated the tree listing; some files may be missing.");
    }

    // Entries in a subtree listing use paths relative to that subtree, which is
    // exactly what we want in the output directory.
    const files: RemoteFile[] = [];
    for (const entry of result.data.tree) {
        if (entry.type !== "blob") {
            continue;
        }
        files.push({
            relativePath: entry.path,
            load: () => fetchBlob(owner, repo, entry.sha, headers),
        });
    }
    return files;
}

/** Build the plan for a `/blob/` (single file) URL. */
async function planBlob(
    owner: string,
    repo: string,
    resolved: ResolvedRef,
    headers: Record<string, string>,
): Promise<RemoteFile[]> {
    if (resolved.path.length === 0) {
        throw new Error("Blob URL is missing a file path.");
    }
    const url = `${GITHUB_API_BASE}/repos/${owner}/${repo}/contents/${encodeRefPath(resolved.path)}?ref=${encodeURIComponent(resolved.ref)}`;
    const result = await apiGet<ContentEntry | ContentEntry[]>(url, headers);
    if (!result.ok) {
        throw new Error(`Failed to resolve file '${resolved.path}': ${result.message}`);
    }
    if (Array.isArray(result.data)) {
        throw new Error(`'${resolved.path}' is a directory; use a /tree/ URL instead.`);
    }

    const entry = result.data;
    return [{
        relativePath: basename(entry.path),
        load: () => fetchBlob(owner, repo, entry.sha, headers),
    }];
}

export const githubRemote: RemoteSource = {
    name: "github",
    description: "Download a directory or file from a github.com URL.",
    envVars: [GITHUB_PAT_ENV_VAR],
    tokenEnvVar: GITHUB_PAT_ENV_VAR,

    matches(url: string): boolean {
        return parseGithubUrl(url) !== null;
    },

    async plan(url: string, env: EnvVars): Promise<DownloadPlan> {
        const parsed = parseGithubUrl(url);
        if (parsed === null) {
            throw new Error(`Not a supported GitHub URL: ${url}`);
        }

        const token = env[GITHUB_PAT_ENV_VAR];
        if (token === undefined || token.trim().length === 0) {
            console.warn(
                `Note: ${GITHUB_PAT_ENV_VAR} is not set; only public repositories can be downloaded.`,
            );
        }
        const headers = buildHeaders(token);

        const resolved = await resolveRefAndPath(parsed.owner, parsed.repo, parsed.refAndPath, headers);
        const files = parsed.mode === "tree"
            ? await planTree(parsed.owner, parsed.repo, resolved, headers)
            : await planBlob(parsed.owner, parsed.repo, resolved, headers);

        const location = resolved.path.length > 0
            ? `${resolved.ref}:${resolved.path}`
            : resolved.ref;
        return {
            rootLabel: `${parsed.owner}/${parsed.repo}@${location}`,
            files,
        };
    },
};

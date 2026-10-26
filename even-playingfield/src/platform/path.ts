/**
 * POSIX path helpers.
 *
 * The core never imports `node:path`, so these are the only path utilities it
 * uses. Forward slashes are canonical — the Bun filesystem adapter passes them
 * straight to node:fs (which accepts them on Windows too).
 */

/** Convert Windows separators to forward slashes. */
export function toPosixPath(path: string): string {
    return path.replace(/\\/g, "/");
}

/** True for `/foo`, `C:/foo`, and `//server/share`. */
export function isAbsolutePath(path: string): boolean {
    const normalized = toPosixPath(path);
    return normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized);
}

/**
 * Collapse `.`, `..` and duplicate separators. Never adds a trailing slash
 * (except for the bare root), and preserves a leading drive letter or `/`.
 */
export function normalizePath(path: string): string {
    const posix = toPosixPath(path);
    const driveMatch = /^([A-Za-z]:)(?=\/|$)/.exec(posix);
    const drive = driveMatch ? driveMatch[1]! : "";
    const rest = drive.length > 0 ? posix.slice(drive.length) : posix;
    const absolute = rest.startsWith("/");

    const segments: string[] = [];
    for (const segment of rest.split("/")) {
        if (segment.length === 0 || segment === ".") {
            continue;
        }
        if (segment === "..") {
            if (segments.length > 0 && segments[segments.length - 1] !== "..") {
                segments.pop();
            } else if (!absolute) {
                segments.push("..");
            }
            continue;
        }
        segments.push(segment);
    }

    const body = segments.join("/");
    if (absolute) {
        return `${drive}/${body}`;
    }
    if (body.length === 0) {
        return drive.length > 0 ? `${drive}/` : ".";
    }
    return `${drive}${body}`;
}

/** Join path segments, ignoring empty ones. */
export function joinPath(...parts: string[]): string {
    const filtered = parts.filter((part) => part !== undefined && part !== null && part.length > 0);
    if (filtered.length === 0) {
        return ".";
    }
    return normalizePath(filtered.join("/"));
}

/** Resolve `path` against `base` when it is relative. */
export function resolvePath(base: string, path: string): string {
    if (isAbsolutePath(path)) {
        return normalizePath(path);
    }
    return normalizePath(`${base}/${path}`);
}

/** Parent directory of an absolute path. */
export function dirnamePath(path: string): string {
    const normalized = normalizePath(path);
    const withoutTrailing = normalized.endsWith("/") && normalized.length > 1
        ? normalized.slice(0, -1)
        : normalized;
    const index = withoutTrailing.lastIndexOf("/");
    if (index === -1) {
        return ".";
    }
    if (index === 0) {
        return "/";
    }
    return withoutTrailing.slice(0, index);
}

/** Final segment of a path. */
export function basenamePath(path: string): string {
    const normalized = normalizePath(path);
    const withoutTrailing = normalized.endsWith("/") && normalized.length > 1
        ? normalized.slice(0, -1)
        : normalized;
    const index = withoutTrailing.lastIndexOf("/");
    return index === -1 ? withoutTrailing : withoutTrailing.slice(index + 1);
}

/** Extension including the dot, or an empty string. */
export function extnamePath(path: string): string {
    const base = basenamePath(path);
    const index = base.lastIndexOf(".");
    return index <= 0 ? "" : base.slice(index);
}

/** Relative path from `from` to `to`, or `to` itself when they share no prefix. */
export function relativePath(from: string, to: string): string {
    const fromParts = normalizePath(from).split("/").filter((part) => part.length > 0);
    const toParts = normalizePath(to).split("/").filter((part) => part.length > 0);

    let shared = 0;
    while (shared < fromParts.length && shared < toParts.length && fromParts[shared] === toParts[shared]) {
        shared++;
    }

    const upwards = new Array(fromParts.length - shared).fill("..");
    const downwards = toParts.slice(shared);
    const result = [...upwards, ...downwards].join("/");
    return result.length === 0 ? "." : result;
}

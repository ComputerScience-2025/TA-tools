/**
 * Config file naming rules shared by the browser host and its UI.
 *
 * The library is flat (`/epf/home/<name>.toml`); workspace configs may live in
 * a subdirectory (`eval/epf.toml`), but a rename never moves a file between
 * directories.
 */

export const CONFIG_EXTENSION = ".toml";
const MAX_CONFIG_NAME_LENGTH = 120;

function withExtension(name: string): string {
    return name.toLowerCase().endsWith(CONFIG_EXTENSION) ? name : `${name}${CONFIG_EXTENSION}`;
}

/** Why a flat config file name is unusable, or null when it is fine. */
export function configFileNameProblem(value: string): string | null {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
        return "Enter a file name.";
    }
    if (trimmed.startsWith(".")) {
        return "File names cannot start with a dot.";
    }
    if (trimmed.includes("/") || trimmed.includes("\\")) {
        return "Use a plain file name, without folders.";
    }
    if (trimmed === "." || trimmed === "..") {
        return "That is not a valid file name.";
    }
    if (trimmed.length > MAX_CONFIG_NAME_LENGTH) {
        return `Keep the file name below ${MAX_CONFIG_NAME_LENGTH} characters.`;
    }
    return null;
}

/** Normalize a flat config file name, appending `.toml` when omitted. */
export function normalizeConfigFileName(value: string): string {
    const problem = configFileNameProblem(value);
    if (problem !== null) {
        throw new Error(problem);
    }
    return withExtension(value.trim());
}

/** Why a workspace-relative config path is unusable, or null when it is fine. */
export function configRelativePathProblem(value: string): string | null {
    const normalized = value.replace(/\\/g, "/").trim();
    if (normalized.length === 0) {
        return "Enter a file name.";
    }
    if (normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
        return "Use a path relative to the workspace, not an absolute path.";
    }
    const segments = normalized.split("/").filter((segment) => segment.length > 0 && segment !== ".");
    if (segments.includes("..")) {
        return "The path is outside the workspace.";
    }
    if (segments.some((segment) => segment.startsWith("."))) {
        return "Folder and file names cannot start with a dot.";
    }
    const base = segments[segments.length - 1] ?? "";
    if (base.length === 0) {
        return "Enter a file name.";
    }
    if (base.length > MAX_CONFIG_NAME_LENGTH) {
        return `Keep the file name below ${MAX_CONFIG_NAME_LENGTH} characters.`;
    }
    return null;
}

/** Normalize a workspace-relative config path, appending `.toml` when omitted. */
export function normalizeConfigRelativePath(value: string): string {
    const problem = configRelativePathProblem(value);
    if (problem !== null) {
        throw new Error(problem);
    }
    const segments = value
        .replace(/\\/g, "/")
        .trim()
        .split("/")
        .filter((segment) => segment.length > 0 && segment !== ".");
    const base = segments.pop()!;
    segments.push(withExtension(base));
    return segments.join("/");
}

export function isTomlFileName(name: string): boolean {
    return name.toLowerCase().endsWith(CONFIG_EXTENSION);
}

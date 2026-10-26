/**
 * Platform abstraction boundary.
 *
 * Everything under `engine/`, `workflow/` and `util/` reaches the outside world
 * only through these interfaces, which is what lets the same code run under Bun
 * (CLI / compiled binary) and in a browser (ta-dashboard).
 *
 * Paths are POSIX-style (forward slashes). Relative paths resolve against the
 * platform's workspace root, mirroring how the CLI resolves them against its
 * working directory.
 */

export type FileKind = "file" | "directory";

export type FileStat = {
    kind: FileKind;
    size: number;
    mtimeMs: number;
};

export type DirEntry = {
    name: string;
    kind: FileKind;
    size: number;
    mtimeMs: number;
};

/**
 * Narrow slice of the `node:fs/promises` surface that the core actually uses.
 * Implemented by `BunFileSystem` (node:fs) and `ZenFileSystem` (@zenfs/core).
 */
export interface VirtualFileSystem {
    /** Absolute, POSIX-style root that relative paths resolve against. */
    readonly root: string;
    readText(path: string): Promise<string>;
    readBytes(path: string): Promise<Uint8Array>;
    writeText(path: string, content: string): Promise<void>;
    writeBytes(path: string, bytes: Uint8Array): Promise<void>;
    exists(path: string): Promise<boolean>;
    /** Follows nothing: symlinks report as `file`, so walking cannot loop. */
    stat(path: string): Promise<FileStat | null>;
    list(path: string): Promise<DirEntry[]>;
    mkdir(path: string): Promise<void>;
    remove(path: string, opts?: { recursive?: boolean }): Promise<void>;
}

export type EnvSetOptions = {
    /**
     * Web only: keep the value for this session instead of writing it to
     * persistent storage. Ignored where the environment is already process-wide.
     */
    persist?: boolean;
};

export interface EnvProvider {
    get(name: string): string | undefined;
    set(name: string, value: string, opts?: EnvSetOptions): void;
    all(): Record<string, string>;
}

export type ShellResult = {
    stdout: string;
    stderr: string;
    exitCode: number;
};

export interface ShellRunner {
    readonly available: boolean;
    /** `cwd` follows the same path rules as {@link VirtualFileSystem}. */
    run(command: string, opts: { cwd: string }): Promise<ShellResult>;
}

/** Thrown when a workflow needs a shell on a platform that has none. */
export class ShellUnavailableError extends Error {
    constructor(message = "Shell execution is not available on this platform.") {
        super(message);
        this.name = "ShellUnavailableError";
    }
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export type LogMeta = {
    /** Workflow slug, rendered as a prefix by the CLI logger. */
    slug?: string;
    /** Extra values appended to the message (objects, arrays, tables). */
    data?: unknown[];
};

export interface Logger {
    log(level: LogLevel, message: string, meta?: LogMeta): void;
}

/** One captured log line. Hosts that keep a log (the web console) store these. */
export type LogEntry = {
    level: LogLevel;
    message: string;
    /** Extra values the caller passed, flattened for display. */
    detail?: string;
    slug?: string;
    time: number;
};

export type TomlCodec = {
    parse(text: string): Record<string, unknown>;
};

export type Platform = {
    fs: VirtualFileSystem;
    env: EnvProvider;
    shell: ShellRunner;
    logger: Logger;
    toml: TomlCodec;
    /** Bun: os.homedir(). Web: undefined — there is no home directory. */
    homeDir?: string;
};

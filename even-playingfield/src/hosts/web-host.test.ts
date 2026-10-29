/**
 * Integration test for the browser host: GitHub fetching, workspace files,
 * config adoption, the console dispatcher and a full analysis run — all with
 * `fetch` stubbed so no network or real provider is involved.
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";

import { WebEPF } from "./web-host.ts";
import { createMemoryStorage } from "../platform/web/web-state.ts";

const REPO_CONFIG = `version = 5

[output_viewing]
mode = "webui"
api_port = 0
webui_base_url = "https://ta-dashboard.test"

[llm.providers.mock]
sdk = "openai"
endpoint = "https://provider.test/v1"
api_key = "test-key"

[llm.models.general_analysis]
provider = "mock"
model_name = "mock-model"

[llm.prompt_replacement]
role = "a C# grader"

[[analysis_workflows]]
slug = "repo_analysis"
model = "general_analysis"
runs = 1
output_filename = "[slug].epf.md"
prompt = "Review the attached files."

[[analysis_workflows.input_files_searches]]
file_glob = "*.cs"
search_directory = "src"
`;

const REPO_FILES: Record<string, string> = {
    "epf.toml": REPO_CONFIG,
    "README.md": "# Demo repository",
    "src/Program.cs": "class Program { static void Main() {} }",
    "src/Helper.cs": "class Helper {}",
};

/** Blob SHAs look like real (hex) hashes, so no path separator ends up in a URL. */
const BLOB_SHA: Record<string, string> = {
    "epf.toml": "a1b2c3epf",
    "README.md": "a1b2c3readme",
    "src/Program.cs": "a1b2c3program",
    "src/Helper.cs": "a1b2c3helper",
};
const PATH_BY_SHA = new Map(Object.entries(BLOB_SHA).map(([path, sha]) => [sha, path]));

type FakeTreeEntry = { path: string; type: "blob" | "tree"; sha: string; size?: number };

function blobs(paths: string[]): FakeTreeEntry[] {
    return paths.map((path) => ({
        path,
        type: "blob",
        sha: BLOB_SHA[path]!,
        size: REPO_FILES[path]?.length ?? 0,
    }));
}

/** Non-recursive listings, as GitHub returns them for a directory. */
const DIRECT_TREES: Record<string, FakeTreeEntry[]> = {
    "tree-root": [
        ...blobs(["epf.toml", "README.md"]),
        { path: "src", type: "tree", sha: "tree-src" },
    ],
    "tree-src": blobs(["src/Program.cs", "src/Helper.cs"]).map((entry) => ({
        ...entry,
        path: entry.path.replace(/^src\//, ""),
    })),
};

/** `?recursive=1` listings: nested paths, relative to the listed subtree. */
const RECURSIVE_TREES: Record<string, FakeTreeEntry[]> = {
    "tree-root": [...blobs(["epf.toml", "README.md"]), ...blobs(["src/Program.cs", "src/Helper.cs"])],
    "tree-src": DIRECT_TREES["tree-src"]!,
};

const MOCK_COMPLETION = "# Review\n\nLooks reasonable.\n";

function json(data: unknown): Response {
    return new Response(JSON.stringify(data), { headers: { "Content-Type": "application/json" } });
}

const requestedPaths: string[] = [];

async function fakeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    const parsed = new URL(url);
    const path = parsed.pathname;
    requestedPaths.push(path);

    // --- GitHub REST API ---
    if (path === "/repos/acme/demo") {
        return json({ default_branch: "main" });
    }
    if (path.startsWith("/repos/acme/demo/git/matching-refs/")) {
        return json([{ ref: "refs/heads/main" }]);
    }
    if (path.startsWith("/repos/acme/demo/commits/")) {
        return json({ sha: "commit-1", commit: { tree: { sha: "tree-root" } } });
    }
    if (path.startsWith("/repos/acme/demo/git/trees/")) {
        const sha = path.slice(path.lastIndexOf("/") + 1);
        const recursive = parsed.searchParams.get("recursive") === "1";
        const trees = recursive ? RECURSIVE_TREES : DIRECT_TREES;
        return json({ tree: trees[sha] ?? [] });
    }
    if (path.startsWith("/repos/acme/demo/git/blobs/")) {
        const sha = decodeURIComponent(path.slice(path.lastIndexOf("/") + 1));
        const filePath = PATH_BY_SHA.get(sha);
        if (filePath === undefined) {
            return new Response(JSON.stringify({ message: "not found" }), { status: 404 });
        }
        return json({ content: btoa(REPO_FILES[filePath]!), encoding: "base64" });
    }

    // --- Provider (OpenAI-compatible) ---
    if (path.endsWith("/chat/completions") || path.endsWith("/responses")) {
        const model = "mock-model";
        const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, input_tokens: 10, output_tokens: 5 };
        if (path.endsWith("/chat/completions")) {
            return json({
                id: "chatcmpl-1",
                object: "chat.completion",
                created: 1,
                model,
                choices: [{ index: 0, message: { role: "assistant", content: MOCK_COMPLETION }, finish_reason: "stop" }],
                usage,
            });
        }
        return json({
            id: "resp-1",
            object: "response",
            created_at: 1,
            status: "completed",
            model,
            output: [{ type: "message", id: "msg-1", status: "completed", role: "assistant", content: [{ type: "output_text", text: MOCK_COMPLETION, annotations: [] }] }],
            usage,
        });
    }

    void init;
    return new Response(JSON.stringify({ message: `unexpected path ${path}` }), { status: 404 });
}

let originalFetch: typeof globalThis.fetch;
let epf: WebEPF;

beforeAll(() => {
    originalFetch = globalThis.fetch;
    globalThis.fetch = fakeFetch as typeof globalThis.fetch;
});

afterAll(() => {
    globalThis.fetch = originalFetch;
});

beforeEach(async () => {
    requestedPaths.length = 0;
    epf = await WebEPF.create({
        persist: false,
        skipSessionLock: true,
        storage: createMemoryStorage(),
        root: "/host-test",
    });
});

describe("WebEPF", () => {
    test("starts with one empty workspace and no config", async () => {
        expect(epf.hasConfig()).toBe(false);
        expect(epf.getConfigError()).toBeNull();
        expect(epf.listWorkspaces()).toHaveLength(1);
        expect(epf.getActiveWorkspace()?.origin).toBe("empty");

        const result = await epf.executeCommand("list");
        expect(result.kind).toBe("error");
        expect(result.message).toContain("No config loaded");
    });

    test("fetches a repository into a workspace and adopts its config", async () => {
        const fetched = await epf.fetchSource({ owner: "acme", repo: "demo", kind: "repo" });

        expect(fetched.summary.downloaded).toBe(4);
        expect(fetched.summary.failed).toBe(0);
        expect(fetched.plan.rootLabel).toBe("acme/demo@main");
        expect(fetched.configCandidates).toEqual(["epf.toml"]);
        expect(fetched.configLoaded).toBe("epf.toml");
        expect(epf.hasConfig()).toBe(true);
        expect(epf.getEngine()?.listWorkflows()).toEqual({ analysis: ["repo_analysis"], testing: [] });

        const files = await epf.listFiles(fetched.workspace.path);
        // Sorted with localeCompare, so case-insensitive ordering.
        expect(files.map((file) => file.path)).toEqual([
            "epf.toml",
            "README.md",
            "src/Helper.cs",
            "src/Program.cs",
        ]);
        expect(epf.getActiveWorkspace()?.path).toBe(fetched.workspace.path);
        expect(epf.getActiveWorkspace()?.origin).toBe("github");
    });

    test("fetches a subdirectory from a pasted URL and resolves its ref", async () => {
        const fetched = await epf.fetchSource({
            kind: "url",
            url: "https://github.com/acme/demo/tree/main/src",
        });

        expect(fetched.summary.downloaded).toBe(2);
        expect(fetched.plan.rootLabel).toBe("acme/demo@main:src");
        expect((await epf.listFiles(fetched.workspace.path)).map((file) => file.path)).toEqual([
            "Helper.cs",
            "Program.cs",
        ]);
        expect(requestedPaths.some((path) => path.includes("matching-refs/heads/main"))).toBe(true);
    });

    test("runs an analysis workflow with workspace-relative globs and writes the output", async () => {
        const fetched = await epf.fetchSource({ owner: "acme", repo: "demo", kind: "repo" });
        await epf.setActiveWorkspace(fetched.workspace.path);

        const results = await epf.runWorkflows({ only: ["repo_analysis"] });

        expect(results).toHaveLength(1);
        expect(results[0]?.status).toBe("succeeded");
        expect(results[0]?.outputs?.[0]?.filename).toBe("repo_analysis.epf.md");

        const files = await epf.listFiles(fetched.workspace.path);
        expect(files.map((file) => file.path)).toContain("repo_analysis.epf.md");
        expect(requestedPaths.some((path) => path.endsWith("/responses") || path.endsWith("/chat/completions"))).toBe(true);
    });

    test("console commands share the CLI dispatcher and clear removes output files", async () => {
        const fetched = await epf.fetchSource({ owner: "acme", repo: "demo", kind: "repo" });
        await epf.setActiveWorkspace(fetched.workspace.path);
        await epf.runWorkflows({ only: ["repo_analysis"] });

        const listResult = await epf.executeCommand("list");
        expect(listResult.kind).toBe("output");
        expect(listResult.message).toContain("repo_analysis");

        const statusResult = await epf.executeCommand("status");
        expect(statusResult.message).toContain("Output files: 1");

        const clearResult = await epf.executeCommand("clear");
        expect(clearResult.kind).toBe("output");
        expect((await epf.listFiles(fetched.workspace.path)).map((file) => file.path)).not.toContain("repo_analysis.epf.md");

        const exitResult = await epf.executeCommand("exit");
        expect(exitResult.message).toContain("close the tab");
    });

    test("clear removes the recorded outputs and nothing else", async () => {
        const fetched = await epf.fetchSource({ owner: "acme", repo: "demo", kind: "repo" });
        await epf.setActiveWorkspace(fetched.workspace.path);
        await epf.runWorkflows({ only: ["repo_analysis"] });

        expect(epf.getRecordedOutputs()).toEqual(["repo_analysis.epf.md"]);
        const removed = await epf.clearRecordedOutputs();

        expect(removed).toEqual(["repo_analysis.epf.md"]);
        expect(epf.getRecordedOutputs()).toEqual([]);
        // The workspace's own files are not "outputs" and must survive.
        expect((await epf.listFiles(fetched.workspace.path)).map((file) => file.path)).toEqual([
            "epf.toml",
            "README.md",
            "src/Helper.cs",
            "src/Program.cs",
        ]);
        expect(await epf.executeCommand("clear")).toMatchObject({ kind: "output" });
        expect((await epf.listFiles(fetched.workspace.path)).length).toBe(4);
    });

    test("clearing with nothing recorded deletes nothing", async () => {
        const fetched = await epf.fetchSource({ owner: "acme", repo: "demo", kind: "repo" });
        await epf.setActiveWorkspace(fetched.workspace.path);

        expect(epf.getRecordedOutputs()).toEqual([]);
        expect(await epf.clearOutputFiles([])).toEqual([]);
        expect(await epf.clearRecordedOutputs()).toEqual([]);
        expect((await epf.listFiles(fetched.workspace.path)).length).toBe(4);
    });

    test("rerun removes only outputs and produces them again", async () => {
        const fetched = await epf.fetchSource({ owner: "acme", repo: "demo", kind: "repo" });
        await epf.setActiveWorkspace(fetched.workspace.path);
        await epf.runWorkflows({ only: ["repo_analysis"] });

        const rerun = await epf.executeCommand("rerun");
        expect(rerun.message).toContain("Succeeded: 1");

        const files = (await epf.listFiles(fetched.workspace.path)).map((file) => file.path);
        expect(files).toContain("repo_analysis.epf.md");
        expect(files).toContain("epf.toml");
        expect(files).toContain("src/Program.cs");
        expect(epf.getRecordedOutputs()).toEqual(["repo_analysis.epf.md"]);
    });

    test("outputs recorded for one workspace are not cleared from another", async () => {
        const first = await epf.fetchSource({ owner: "acme", repo: "demo", kind: "repo" });
        await epf.setActiveWorkspace(first.workspace.path);
        await epf.runWorkflows({ only: ["repo_analysis"] });

        const second = await epf.fetchSource({
            kind: "url",
            url: "https://github.com/acme/demo/tree/main/src",
        });
        expect(second.workspace.path).not.toBe(first.workspace.path);
        expect(epf.getRecordedOutputs(second.workspace.path)).toEqual([]);

        await epf.clearRecordedOutputs();
        expect((await epf.listFiles(first.workspace.path)).map((file) => file.path)).toContain("repo_analysis.epf.md");
        expect(epf.getRecordedOutputs(first.workspace.path)).toEqual(["repo_analysis.epf.md"]);
    });

    test("rejects upload targets outside the workspace", async () => {
        const workspace = epf.requireActiveWorkspace();
        const files = [{ name: "a.txt", bytes: new TextEncoder().encode("x") }];

        await expect(epf.uploadFiles(files, "../..")).rejects.toThrow(/inside the workspace/);
        await expect(epf.uploadFiles(files, "/absolute")).rejects.toThrow(/relative to the workspace/);
        await expect(epf.uploadFiles(files, "notes/../sub")).rejects.toThrow(/inside the workspace/);
        expect(await epf.listFiles(workspace.path)).toEqual([]);

        await epf.uploadFiles(files, "notes/extra");
        expect((await epf.listFiles(workspace.path)).map((file) => file.path)).toEqual(["notes/extra/a.txt"]);
    });

    test("rejects saving a config outside the active workspace", async () => {
        const workspace = epf.requireActiveWorkspace();
        await expect(epf.saveConfigText(REPO_CONFIG, "../escape.toml")).rejects.toThrow(/outside the workspace/);
        expect(await epf.web.storageFs.exists(`${workspace.path}/../escape.toml`)).toBe(false);
    });

    test("an unknown workspace is rejected instead of silently created", async () => {
        await expect(epf.fetchSource({ owner: "acme", repo: "demo", kind: "repo", workspacePath: "/nope" }))
            .rejects.toThrow(/Unknown workspace/);
        await expect(epf.removeWorkspace("/nope")).rejects.toThrow(/Unknown workspace/);
        await expect(epf.clearWorkspace("/nope")).rejects.toThrow(/Unknown workspace/);
        expect(epf.listWorkspaces()).toHaveLength(1);
    });

    test("status still lists recorded outputs after the engine is replaced", async () => {
        const fetched = await epf.fetchSource({ owner: "acme", repo: "demo", kind: "repo" });
        await epf.setActiveWorkspace(fetched.workspace.path);
        await epf.runWorkflows({ only: ["repo_analysis"] });
        expect(epf.getRecordedOutputs()).toEqual(["repo_analysis.epf.md"]);

        // Replacing the engine (as `reload` and a config apply do) must not make
        // the recorded outputs disappear from `status`.
        await epf.applyConfigText(REPO_CONFIG, "reloaded config");
        const status = await epf.executeCommand("status");
        expect(status.message).toContain("Output files: 1");
        expect(status.message).toContain("repo_analysis.epf.md");
    });

    test("removing the workspace that owns the config unloads the engine", async () => {
        const fetched = await epf.fetchSource({ owner: "acme", repo: "demo", kind: "repo" });
        expect(epf.hasConfig()).toBe(true);
        expect(epf.getConfigSource()?.kind).toBe("path");

        await epf.removeWorkspace(fetched.workspace.path);

        expect(epf.hasConfig()).toBe(false);
        expect(epf.getConfigSource()).toBeNull();
        expect(await epf.getConfigText()).toBeNull();
        expect(epf.getRecordedOutputs(fetched.workspace.path)).toEqual([]);
    });

    test("creating a workspace clears the previous workspace's results", async () => {
        const fetched = await epf.fetchSource({ owner: "acme", repo: "demo", kind: "repo" });
        await epf.setActiveWorkspace(fetched.workspace.path);
        await epf.runWorkflows({ only: ["repo_analysis"] });
        expect(epf.getEngine()?.getStatus().completedFiles).toEqual(["repo_analysis.epf.md"]);

        const created = await epf.createWorkspace("second", "empty");

        expect(epf.getActiveWorkspace()?.path).toBe(created.path);
        expect(epf.getEngine()?.getStatus().completedFiles).toEqual([]);
        expect(epf.getRecordedOutputs(created.path)).toEqual([]);
        expect((await epf.executeCommand("status")).message).toContain("Output files: 0");
    });

    test("clearing one workflow leaves another workflow's similarly named output", async () => {
        const overlapConfig = `version = 5

[output_viewing]
mode = "webui"
api_port = 0
webui_base_url = "https://ta-dashboard.test"

[llm.providers.mock]
sdk = "openai"
endpoint = "https://provider.test/v1"
api_key = "test-key"

[llm.models.general_analysis]
provider = "mock"
model_name = "mock-model"

[llm.prompt_replacement]
role = "a C# grader"

[[analysis_workflows]]
slug = "first"
model = "general_analysis"
runs = 1
output_filename = "result.md"
prompt = "Review the attached files."

[[analysis_workflows.input_files_searches]]
file_glob = "*.cs"
search_directory = "src"

[[analysis_workflows]]
slug = "second"
model = "general_analysis"
runs = 1
output_filename = "x-result.md-evil.md"
prompt = "Review the attached files."

[[analysis_workflows.input_files_searches]]
file_glob = "*.cs"
search_directory = "src"
`;
        const fetched = await epf.fetchSource({ owner: "acme", repo: "demo", kind: "repo" });
        await epf.setActiveWorkspace(fetched.workspace.path);
        await epf.applyConfigText(overlapConfig, "overlap config");
        await epf.runWorkflows();

        const recorded = epf.getRecordedOutputs();
        expect(recorded).toContain("result.md");
        expect(recorded).toContain("x-result.md-evil.md");

        const cleared = await epf.executeCommand("clear first");
        expect(cleared.kind).toBe("output");

        const files = (await epf.listFiles(fetched.workspace.path)).map((file) => file.path);
        expect(files).not.toContain("result.md");
        expect(files).toContain("x-result.md-evil.md");
        expect(epf.getRecordedOutputs()).toEqual(["x-result.md-evil.md"]);
    });

    test("fetching a new repository adopts its config even when one was loaded", async () => {
        await epf.fetchSource({ owner: "acme", repo: "demo", kind: "repo" });
        await epf.applyConfigText(REPO_CONFIG.replace("repo_analysis", "custom_analysis"), "custom config");
        expect(epf.getEngine()?.listWorkflows().analysis).toEqual(["custom_analysis"]);

        const fetched = await epf.fetchSource({ owner: "acme", repo: "demo", kind: "repo" });

        expect(fetched.configLoaded).toBe("epf.toml");
        expect(fetched.configError).toBeNull();
        expect(epf.getEngine()?.listWorkflows().analysis).toEqual(["repo_analysis"]);
        expect(epf.getConfigSource()).toMatchObject({ kind: "path" });
    });

    test("a read-only session starts with one stored workspace and writes nothing", async () => {
        const storage = createMemoryStorage();
        const writer = await WebEPF.create({ persist: false, skipSessionLock: true, storage, root: "/ro-writer" });
        const workspace = writer.requireActiveWorkspace();
        await writer.uploadFiles([{ name: "notes.md", bytes: new TextEncoder().encode("hello") }]);

        const blob = storage.getItem("epf.platform");
        expect(blob).toContain(workspace.path);

        const viewer = await WebEPF.create({
            persist: false,
            skipSessionLock: true,
            storage,
            root: "/ro-viewer",
            access: "read-only",
        });

        expect(viewer.web.readOnly).toBe(true);
        expect(viewer.listWorkspaces().map((entry) => entry.path)).toEqual([workspace.path]);
        expect(viewer.getViewWorkspace()?.path).toBe(workspace.path);
        // No writable mount, so a viewer reports an empty view instead of failing.
        expect(await viewer.listFiles()).toEqual([]);
        expect(await viewer.detectConfigCandidates()).toEqual([]);
        expect(viewer.getRecordedOutputs()).toEqual([]);
        await expect(viewer.uploadFiles([{ name: "x.txt", bytes: new Uint8Array() }])).rejects.toThrow(/read-only/);

        viewer.web.state.saveNow();
        expect(storage.getItem("epf.platform")).toBe(blob);
    });

    test("validates pasted config text with readable issues", async () => {
        const badVersion = epf.validateConfigText("version = 4\n", "pasted");
        expect(badVersion.ok).toBe(false);
        if (!badVersion.ok) {
            expect(badVersion.issues[0]).toContain("outdated");
        }

        const brokenToml = epf.validateConfigText("version = = 5", "pasted");
        expect(brokenToml.ok).toBe(false);

        const missingFields = epf.validateConfigText("version = 5\n", "pasted");
        expect(missingFields.ok).toBe(false);
        if (!missingFields.ok) {
            expect(missingFields.issues.some((issue) => issue.startsWith("llm"))).toBe(true);
        }

        expect(epf.validateConfigText(REPO_CONFIG, "pasted").ok).toBe(true);

        await expect(epf.applyConfigText("version = 5\n", "pasted")).rejects.toThrow(/llm/);
        expect(epf.hasConfig()).toBe(false);
    });

    test("applies, edits and saves config text in the workspace", async () => {
        await epf.applyConfigText(REPO_CONFIG, "pasted config");
        expect(epf.hasConfig()).toBe(true);
        expect(epf.getConfigText()).resolves.toBe(REPO_CONFIG);

        const savedSource = await epf.saveConfigText(REPO_CONFIG, "eval/epf.toml");
        expect(savedSource).toEqual({
            kind: "path",
            path: `${epf.requireActiveWorkspace().path}/eval/epf.toml`,
        });
        expect(await epf.detectConfigCandidates()).toEqual(["eval/epf.toml"]);
    });

    test("uploads files, lists them and clears the workspace", async () => {
        const summary = await epf.uploadFiles([
            { name: "notes/extra.md", bytes: new TextEncoder().encode("hello") },
            { name: "/absolute/../escape.txt", bytes: new TextEncoder().encode("nope") },
        ]);

        expect(summary.written).toBe(2);
        const files = await epf.listFiles(summary.workspace.path);
        // `..` segments are dropped so uploads cannot escape the workspace.
        expect(files.map((file) => file.path)).toEqual(["absolute/escape.txt", "notes/extra.md"]);

        await epf.clearWorkspace(summary.workspace.path);
        expect(await epf.listFiles(summary.workspace.path)).toEqual([]);
    });

    test("reports storage usage against the configured cap", async () => {
        const fetched = await epf.fetchSource({ owner: "acme", repo: "demo", kind: "repo" });
        await epf.setActiveWorkspace(fetched.workspace.path);

        const usage = await epf.getUsage();
        expect(usage.used).toBeGreaterThan(0);
        expect(usage.cap).toBe(128 * 1024 * 1024);
        // No StorageManager in Bun, so browser figures are absent rather than wrong.
        expect(usage.browserQuota).toBeNull();
    });

    test("pins and removes workspaces through the state store", async () => {
        const bootstrapWorkspace = epf.requireActiveWorkspace().path;
        const first = await epf.fetchSource({ owner: "acme", repo: "demo", kind: "repo" });
        const second = await epf.fetchSource({
            kind: "url",
            url: "https://github.com/acme/demo/tree/main/src",
        });

        epf.setWorkspacePinned(first.workspace.path, true);
        expect(epf.listWorkspaces().find((w) => w.path === first.workspace.path)?.pinned).toBe(true);

        await epf.removeWorkspace(second.workspace.path);
        expect(epf.listWorkspaces().map((w) => w.path).sort()).toEqual([
            bootstrapWorkspace,
            first.workspace.path,
        ].sort());
        expect(await epf.listFiles(second.workspace.path)).toEqual([]);
    });
});

describe("config library and editor support", () => {
    test("opens invalid and outdated configs without loading them", async () => {
        const workspace = epf.requireActiveWorkspace();
        const path = `${workspace.path}/broken.toml`;
        await epf.web.storageFs.writeText(
            path,
            'version = 5\n[output_viewing]\nmode = "not-a-mode"\n',
        );

        const document = await epf.openConfigDocument({ kind: "path", path });
        expect(document.version).toBe(5);
        expect(document.raw["output_viewing"]).toEqual({ mode: "not-a-mode" });

        await expect(epf.loadConfigSource({ kind: "path", path })).rejects.toThrow(/invalid/i);
        expect(epf.hasConfig()).toBe(false);
        expect(epf.getAttemptedConfigSource()).toEqual({ kind: "path", path });

        const outdatedPath = `${workspace.path}/old.toml`;
        await epf.web.storageFs.writeText(outdatedPath, "version = 4\n");
        const outdated = await epf.openConfigDocument({ kind: "path", path: outdatedPath });
        expect(outdated.version).toBe(4);
    });

    test("saves, renames and defaults a library config", async () => {
        const source = await epf.saveConfigToHome(REPO_CONFIG, "library.toml", {
            overwrite: true,
            makeDefault: true,
        });
        expect(source.kind).toBe("path");
        expect(epf.getDefaultHomeConfig()).toBe("library.toml");
        expect(epf.getConfigSource()).toEqual(source);

        const edited = REPO_CONFIG.replace("Review the attached files.", "Review the library files.");
        await epf.saveConfigToCurrentSource(edited);
        await expect(epf.readHomeConfig("library.toml")).resolves.toBe(edited);

        const renamed = await epf.renameHomeConfig("library.toml", "renamed.toml");
        expect(renamed).toEqual({
            kind: "path",
            path: `${epf.getHomeDir()}/renamed.toml`,
        });
        expect(epf.getDefaultHomeConfig()).toBe("renamed.toml");
        expect(epf.getConfigSource()).toEqual(renamed);
        expect((await epf.listHomeConfigs()).map((file) => file.name)).toEqual(["renamed.toml"]);
        await expect(epf.readHomeConfig("library.toml")).rejects.toThrow();
    });

    test("finds the library as a fallback when the workspace has no config", async () => {
        await epf.saveConfigToHome(REPO_CONFIG, "epf.toml", { overwrite: true });
        const workspace = await epf.createWorkspace("empty", "empty");
        epf.web.state.setStoredConfigSource(null);
        expect(await epf.findConfigSource()).toEqual({
            kind: "path",
            path: `${epf.getHomeDir()}/epf.toml`,
        });

        // A priority workspace config wins over the library file.
        await epf.saveConfigToWorkspace(REPO_CONFIG, "epf.toml", { overwrite: true });
        epf.web.state.setStoredConfigSource(null);
        expect(await epf.findConfigSource()).toEqual({
            kind: "path",
            path: `${workspace.path}/epf.toml`,
        });
    });

    test("copies a library config into the active workspace", async () => {
        await epf.saveConfigToHome(REPO_CONFIG, "library.toml", { overwrite: true });
        const workspace = epf.requireActiveWorkspace();
        const source = await epf.copyHomeConfigToWorkspace("library.toml", "epf.toml");
        expect(source).toEqual({
            kind: "path",
            path: `${workspace.path}/epf.toml`,
        });
        expect(await epf.readHomeConfig("library.toml")).toBe(REPO_CONFIG);
    });

    test("lists custom workspace TOML files for the picker", async () => {
        await epf.saveConfigToWorkspace(REPO_CONFIG, "strict.toml", { overwrite: true });
        expect(await epf.listWorkspaceConfigFiles()).toEqual(["strict.toml"]);
        expect(await epf.detectConfigCandidates()).toEqual([]);
    });

    test("keeps the library when workspaces are cleaned up", async () => {
        await epf.saveConfigToHome(REPO_CONFIG, "library.toml", { overwrite: true });
        const workspace = await epf.createWorkspace("old", "empty");
        const other = epf.listWorkspaces().find((entry) => entry.path !== workspace.path);
        expect(other).toBeDefined();
        epf.web.state.setActiveWorkspace(other!.path);
        await epf.web.quota.cleanupExpired(Date.now() + 8 * 24 * 60 * 60 * 1000);
        expect(epf.listWorkspaces().some((entry) => entry.path === workspace.path)).toBe(false);
        await expect(epf.readHomeConfig("library.toml")).resolves.toBe(REPO_CONFIG);
    });

    test("saves an explicit path even when the engine is on another file", async () => {
        const homeSource = await epf.saveConfigToHome(REPO_CONFIG, "explicit.toml", { overwrite: true });
        await epf.saveConfigToWorkspace(REPO_CONFIG, "workspace.toml", { overwrite: true });
        expect(epf.getConfigSource()?.kind).toBe("path");

        const edited = REPO_CONFIG.replace("Review the attached files.", "Review the explicit file.");
        const saved = await epf.saveConfigToPath(
            homeSource.kind === "path" ? homeSource.path : "",
            edited,
        );
        expect(saved).toEqual(homeSource);
        expect(await epf.readHomeConfig("explicit.toml")).toBe(edited);
        expect(epf.getConfigSource()).toEqual(homeSource);
    });

    test("moves a draft when its file is renamed and drops it when deleted", async () => {
        const source = await epf.saveConfigToHome(REPO_CONFIG, "draft.toml", { overwrite: true });
        const oldPath = source.kind === "path" ? source.path : "";
        await epf.saveEditorDraft({
            sourceKey: `path:${oldPath}`,
            sourceLabel: "draft.toml",
            baseHash: "abc",
            configVersion: 5,
            migratedFrom: null,
            text: REPO_CONFIG,
            savedAt: Date.now(),
        });

        const renamed = await epf.renameHomeConfig("draft.toml", "renamed-draft.toml");
        const newPath = renamed.kind === "path" ? renamed.path : "";
        const drafts = await epf.readEditorDrafts();
        expect(drafts.drafts[`path:${oldPath}`]).toBeUndefined();
        expect(drafts.drafts[`path:${newPath}`]?.sourceKey).toBe(`path:${newPath}`);

        await epf.deleteHomeConfig("renamed-draft.toml");
        expect((await epf.readEditorDrafts()).drafts[`path:${newPath}`]).toBeUndefined();
    });

    test("persists and clears editor drafts", async () => {
        const draft = {
            sourceKey: "path:test",
            sourceLabel: "test.toml",
            baseHash: "abc",
            configVersion: 5,
            migratedFrom: null,
            text: REPO_CONFIG,
            savedAt: Date.now(),
        };
        await epf.saveEditorDraft(draft);
        const file = await epf.readEditorDrafts();
        expect(file.drafts["path:test"]?.text).toBe(REPO_CONFIG);

        await epf.deleteEditorDraft("path:test");
        expect((await epf.readEditorDrafts()).drafts["path:test"]).toBeUndefined();

        await epf.saveEditorDraft(draft);
        await epf.clearEditorDrafts();
        expect((await epf.readEditorDrafts()).drafts).toEqual({});
    });
});

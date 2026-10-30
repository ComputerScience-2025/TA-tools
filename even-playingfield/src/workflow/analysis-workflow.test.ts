import { describe, expect, test } from "bun:test";

import { CURRENT_CONFIG_VERSION, ConfigSchema } from "../util/config-schema.ts";
import { OutputViewer } from "../util/output-viewer.ts";
import { createZenFileSystem } from "../platform/web/zen-vfs.ts";
import { executeAnalysisWorkflow } from "./analysis-workflow.ts";
import type { CompletionClient, WorkflowDependencies } from "./index.ts";
import type { Config } from "../util/config-schema.ts";

type CapturedCall = {
    model: string;
    systemPrompt: string;
    content: { type: "text"; text: string }[];
};

/** Stands in for `LlmClient`: records the request, returns canned output. */
function createFakeClient(text = "## Review\n\nLooks fine."): { client: CompletionClient; calls: CapturedCall[] } {
    const calls: CapturedCall[] = [];
    const client: CompletionClient = {
        async generateCompletion(_log, _warn, model, systemPrompt, content) {
            calls.push({
                model,
                systemPrompt,
                content: content as { type: "text"; text: string }[],
            });
            return {
                text,
                model: "test/model-name",
                metrics: {
                    model,
                    provider: "test",
                    promptTokens: 10,
                    completionTokens: 5,
                    totalTokens: 15,
                    finishReason: "stop",
                    latencyMs: 1,
                    attempts: 1,
                },
            };
        },
    };
    return { client, calls };
}

function buildConfig(): Config {
    return ConfigSchema.parse({
        version: CURRENT_CONFIG_VERSION,
        output_viewing: {
            mode: "webui",
            api_port: 0,
            webui_base_url: "https://example.test",
        },
        llm: {
            providers: { test: { sdk: "openai", endpoint: "", api_key: "test-key" } },
            models: {
                general_analysis: {
                    provider: "test",
                    model_name: "test-model",
                    seed: 42,
                },
            },
            prompt_replacement: { role: "a C# grader" },
        },
        analysis_workflows: [
            {
                slug: "analysis",
                model: "general_analysis",
                runs: 1,
                output_filename: "[slug]-[model]-[seed].epf.md",
                prompt: "You are an expert {{role}}.",
                input_files_searches: [
                    { file_glob: "*.cs", search_directory: "src", excluded_files: ["Helper.cs"] },
                ],
            },
        ],
    });
}

async function buildDeps(
    config: Config,
    client: CompletionClient,
): Promise<{ deps: WorkflowDependencies; fs: WorkflowDependencies["fs"]; captured: string[]; warnings: string[] }> {
    const mount = await createZenFileSystem({ persist: false, root: "/analysis-test" });
    const fs = mount.fs;
    await fs.writeText("src/Program.cs", "class Program {}");
    await fs.writeText("src/Helper.cs", "class Helper {}");
    await fs.writeText("src/readme.md", "not source");
    const captured: string[] = [];
    const warnings: string[] = [];
    const deps: WorkflowDependencies = {
        outputViewer: new OutputViewer(fs),
        config,
        llmClient: client,
        fs,
        env: { get: () => undefined, set: () => {}, all: () => ({}) },
        shell: {
            available: false,
            run: async () => {
                throw new Error("shell should not be used by analysis workflows");
            },
        },
        logger: {
            log: (level, message) => {
                captured.push(`${level}: ${message}`);
                if (level === "warn") {
                    warnings.push(message);
                }
            },
        },
    };
    return { deps, fs, captured, warnings };
}

describe("executeAnalysisWorkflow", () => {
    test("collects files, calls the model and writes the output file", async () => {
        const config = buildConfig();
        const { client, calls } = createFakeClient();
        const { deps, fs, captured } = await buildDeps(config, client);

        const result = await executeAnalysisWorkflow(config.analysis_workflows[0]!, 1, deps);

        expect(result.status).toBe("succeeded");
        expect(result.error).toBeUndefined();
        expect(result.completions).toHaveLength(1);

        // The workflow passes the configured prompt through untouched —
        // {{placeholder}} replacement happens inside LlmClient.
        expect(calls).toHaveLength(1);
        expect(calls[0]!.systemPrompt).toBe("You are an expert {{role}}.");
        expect(calls[0]!.model).toBe("general_analysis");

        // Only matching, non-excluded files are sent, with the language fence.
        const payload = calls[0]!.content.map((part) => part.text).join("\n");
        expect(payload).toContain("src/Program.cs");
        expect(payload).toContain("```csharp");
        expect(payload).not.toContain("Helper.cs");
        expect(payload).not.toContain("readme.md");

        // Output filename placeholders are resolved.
        const expectedName = "analysis-(test--model-name)-42.epf.md";
        expect(result.outputs?.[0]?.filename).toBe(expectedName);
        expect(await fs.readText(expectedName)).toBe("## Review\n\nLooks fine.");
        expect(deps.outputViewer.getFileList().map((file) => file.name)).toEqual([expectedName]);
        expect(captured.some((line) => line.includes("Excluding file: Helper.cs"))).toBe(true);
    });

    test("fails without calling the model when nothing matches", async () => {
        const config = buildConfig();
        const { client, calls } = createFakeClient();
        const { deps } = await buildDeps(config, client);

        const workflow = { ...config.analysis_workflows[0]!, input_files_searches: [{ file_glob: "*.java", search_directory: "src", excluded_files: [] }] };
        const result = await executeAnalysisWorkflow(workflow, 1, deps);

        expect(result.status).toBe("failed");
        expect(result.error).toBe("No files found for workflow, skipping... Searched: *.java in src");
        expect(calls).toHaveLength(0);
    });

    test("finds files for a single-alternative brace glob and a trailing-slash directory", async () => {
        // Reproduces the browser report: `*.{cs}` in `src/` was read as literal
        // text by picomatch and reported "No files found for workflow".
        const config = buildConfig();
        const { client, calls } = createFakeClient();
        const { deps } = await buildDeps(config, client);

        const workflow = {
            ...config.analysis_workflows[0]!,
            input_files_searches: [{ file_glob: "*.{cs}", search_directory: "src/", excluded_files: ["Helper.cs"] }],
        };
        const result = await executeAnalysisWorkflow(workflow, 1, deps);

        expect(result.status).toBe("succeeded");
        expect(result.error).toBeUndefined();
        const payload = calls[0]!.content.map((part) => part.text).join("\n");
        expect(payload).toContain("Program.cs");
        expect(payload).not.toContain("Helper.cs");
    });

    test("reports model failures as a failed run", async () => {
        const config = buildConfig();
        const failing: CompletionClient = {
            async generateCompletion() {
                throw new Error("provider exploded");
            },
        };
        const { deps } = await buildDeps(config, failing);

        const result = await executeAnalysisWorkflow(config.analysis_workflows[0]!, 1, deps);

        expect(result.status).toBe("failed");
        expect(result.error).toBe("provider exploded");
        expect(result.latencyMs).toBeGreaterThanOrEqual(0);
    });
});

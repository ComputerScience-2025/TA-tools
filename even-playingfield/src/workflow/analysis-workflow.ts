import { scanGlob } from "../platform/glob.ts";
import { joinPath } from "../platform/path.ts";
import { FilePayloadGenerator } from "../util/file-payload.ts";
import { resolveOutputFilename } from "../util/output-filename.ts";
import type { WorkflowDependencies } from "./index.ts";
import type { CompletionMetrics } from "../util/llm.ts";
import type { AnalysisWorkflow } from "../util/config-schema.ts";

export type AnalysisWorkflowResult = {
    slug: string;
    runNumber: number;
    status: "succeeded" | "failed";
    error?: string;
    latencyMs: number;
    outputs: { filename: string; content: string }[];
    completions: CompletionMetrics[];
};

export async function executeAnalysisWorkflow(workflow: AnalysisWorkflow, runNum: number, deps: WorkflowDependencies): Promise<AnalysisWorkflowResult> {
    const startTime = Date.now();
    const resultBase: Omit<AnalysisWorkflowResult, "status" | "error" | "latencyMs"> = {
        slug: workflow.slug,
        runNumber: runNum,
        outputs: [],
        completions: [],
    };

    deps.logger.log("info", `Executing analysis workflow: ${workflow.slug}`);
    const log = (message: string, ...data: unknown[]) => {
        deps.logger.log("info", message, { slug: workflow.slug, data });
    }
    const warn = (message: string, ...data: unknown[]) => {
        deps.logger.log("warn", message, { slug: workflow.slug, data });
    }

    // File searches and their matches, resolved through the platform filesystem
    // (relative paths resolve against the workspace root on every platform).
    let allFiles = (
        await Promise.all(
            workflow.input_files_searches.map(async (fileSearch) => {
                const fileExclusionsSet = new Set(fileSearch.excluded_files);
                const matches: string[] = [];
                for (const relativePath of await scanGlob(deps.fs, fileSearch.file_glob, fileSearch.search_directory)) {
                    if (fileExclusionsSet.has(relativePath)) {
                        log(`Excluding file: ${relativePath}`);
                        continue;
                    }
                    matches.push(joinPath(fileSearch.search_directory, relativePath));
                }
                log(`Found ${matches.length} files for search: ${fileSearch.file_glob} in ${fileSearch.search_directory}`, matches);
                return matches;
            })
        )
    ).flat();

    if (allFiles.length === 0) {
        const error = "No files found for workflow, skipping...";
        warn(error);
        return {
            ...resultBase,
            status: "failed",
            error,
            latencyMs: Date.now() - startTime,
        };
    }

    try {
        log(`Found ${allFiles.length} files for workflow`);
        const fileContentsPayload = await FilePayloadGenerator.generatePayloads(allFiles, deps.fs);
        const completion = await deps.llmClient.generateCompletion(log, warn, workflow.model, workflow.prompt, fileContentsPayload.map((file) => {
            return {
                type: "text",
                text: file,
            }
        }));

        const outputFileName = resolveOutputFilename(workflow.output_filename, {
            slug: workflow.slug,
            model: `(${completion.model.replaceAll("/", "--")})`,
            seed: deps.config.llm.models[workflow.model]!.seed.toString(),
            run: runNum.toString(),
        });

        await deps.outputViewer.addFile(outputFileName, { type: "markdown", content: completion.text });
        log(`Completion saved as ${outputFileName}`);

        return {
            ...resultBase,
            status: "succeeded",
            latencyMs: Date.now() - startTime,
            outputs: [{ filename: outputFileName, content: completion.text }],
            completions: [completion.metrics],
        };
    } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        warn(`Workflow failed: ${errorMsg}`);
        return {
            ...resultBase,
            status: "failed",
            error: errorMsg,
            latencyMs: Date.now() - startTime,
        };
    }
}

import { Glob } from "bun";

import chalk from "chalk";

import { CONFIG } from "../util/config.ts";
import { FilePayloadGenerator } from "../util/file-payload.ts";
import type { WorkflowDependencies } from "./index.ts";
import { generateCompletion, type CompletionMetrics } from "../util/llm.ts";


export type AnalysisWorkflowResult = {
    slug: string;
    runNumber: number;
    status: "succeeded" | "failed";
    error?: string;
    latencyMs: number;
    outputs: { filename: string; content: string }[];
    completions: CompletionMetrics[];
};

export async function executeAnalysisWorkflow(workflow: typeof CONFIG.analysis_workflows[number], runNum: number, deps: WorkflowDependencies): Promise<AnalysisWorkflowResult> {
    const startTime = Date.now();
    const resultBase: Omit<AnalysisWorkflowResult, "status" | "error" | "latencyMs"> = {
        slug: workflow.slug,
        runNumber: runNum,
        outputs: [],
        completions: [],
    };

    console.log(`Executing analysis workflow: ${workflow.slug}`);
    const log = (...args: Parameters<typeof console.log>) => {
        console.log(chalk.cyan(`[${workflow.slug}]`), ...args);
    }
    const warn = (...args: Parameters<typeof console.warn>) => {
        console.warn(chalk.red(`[${workflow.slug}]`), ...args);
    }

    let allFiles = (
        await Promise.all(
            workflow.input_files_searches.map(async (fileSearch) => {
                const fileExclusionsSet = new Set(fileSearch.excluded_files);
                const glob = new Glob(fileSearch.file_glob);
                const matches: string[] = [];
                for await (const file of glob.scan(fileSearch.search_directory)) {
                    if (fileExclusionsSet.has(file)) {
                        log(`Excluding file: ${file}`);
                        continue;
                    }
                    matches.push(file);
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
        const fileContentsPayload = await FilePayloadGenerator.generatePayloads(allFiles);
        const completion = await generateCompletion(deps, log, warn, workflow.model, workflow.prompt, fileContentsPayload.map((file) => {
            return {
                type: "text",
                text: file,
            }
        }));

        const outputFileName = workflow.output_filename
            .replaceAll("[seed]", CONFIG.llm.models[workflow.model]!.seed.toString())
            .replaceAll("[slug]", workflow.slug)
            .replaceAll("[model]", `(${completion.model.replaceAll("/", "--")})`)
            .replaceAll("[run]", runNum.toString());

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

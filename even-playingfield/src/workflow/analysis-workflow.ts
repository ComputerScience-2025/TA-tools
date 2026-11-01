import { scanGlob } from "../platform/glob.ts";
import { joinPath } from "../platform/path.ts";
import { FilePayloadGenerator } from "../util/file-payload.ts";
import { resolveOutputFilename } from "../util/output-filename.ts";
import { errorMessage } from "../util/errors.ts";
import {
    createSessionId,
    stripReasoning,
} from "../util/chat-session.ts";
import type { SessionMessageMeta } from "../util/chat-session.ts";
import type { WorkflowDependencies } from "./index.ts";
import type { CompletionMetrics, CompletionResult } from "../util/llm.ts";
import type { AnalysisWorkflow } from "../util/config-schema.ts";

export type AnalysisWorkflowResult = {
    slug: string;
    runNumber: number;
    status: "succeeded" | "failed";
    error?: string;
    latencyMs: number;
    outputs: { filename: string; content: string }[];
    completions: CompletionMetrics[];
    /** Recorded chat session, when session storage is enabled. */
    sessionId?: string;
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
    };
    const warn = (message: string, ...data: unknown[]) => {
        deps.logger.log("warn", message, { slug: workflow.slug, data });
    };

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
        // Name what was searched: a pattern that cannot match (a single-item
        // brace, a directory the fetched tree does not have, a non-recursive
        // glob) otherwise looks identical to an empty workspace.
        const searched = workflow.input_files_searches
            .map((fileSearch) => `${fileSearch.file_glob} in ${fileSearch.search_directory}`)
            .join(", ");
        const error = `No files found for workflow, skipping... Searched: ${searched.length > 0 ? searched : "(no file searches configured)"}`;
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

        const sessionId = await recordSession(deps, workflow, runNum, completion, allFiles, outputFileName, log, warn);

        return {
            ...resultBase,
            status: "succeeded",
            latencyMs: Date.now() - startTime,
            outputs: [{ filename: outputFileName, content: completion.text }],
            completions: [completion.metrics],
            sessionId,
        };
    } catch (error) {
        const errorMsg = errorMessage(error);
        warn(`Workflow failed: ${errorMsg}`);
        return {
            ...resultBase,
            status: "failed",
            error: errorMsg,
            latencyMs: Date.now() - startTime,
        };
    }
}

/**
 * Persist the run as a chat session. A failure here is logged but never fails
 * the workflow: the markdown output is the primary artifact.
 */
async function recordSession(
    deps: WorkflowDependencies,
    workflow: AnalysisWorkflow,
    runNum: number,
    completion: CompletionResult,
    allFiles: readonly string[],
    outputFileName: string,
    log: (message: string, ...data: unknown[]) => void,
    warn: (message: string, ...data: unknown[]) => void,
): Promise<string | undefined> {
    const store = deps.sessionStore;
    if (store === undefined) {
        return undefined;
    }

    try {
        const now = new Date();
        const at = now.toISOString();
        const responseMessages = deps.config.sessions.retain_reasoning
            ? completion.responseMessages
            : stripReasoning(completion.responseMessages);
        const meta: SessionMessageMeta[] = [
            { at, initial: true, files: [...allFiles] },
        ];
        for (let index = 0; index < responseMessages.length; index += 1) {
            meta.push({
                at,
                ...(index === 0 ? { metrics: completion.metrics } : {}),
            });
        }

        const session = await store.create({
            id: createSessionId(workflow.slug, runNum, now),
            origin: store.origin,
            workspace: deps.fs.root,
            workflow: {
                slug: workflow.slug,
                kind: "analysis",
                run: runNum,
                model: workflow.model,
                provider_model: completion.model,
                output_filename: outputFileName,
            },
            system_prompt: completion.system,
            messages: [...completion.requestMessages, ...responseMessages],
            meta,
            outputs: [{ filename: outputFileName }],
            created_at: at,
        });
        log(`Chat session saved as ${session.id}`);
        return session.id;
    } catch (error) {
        const message = errorMessage(error);
        warn(`Could not save the chat session: ${message}`);
        return undefined;
    }
}

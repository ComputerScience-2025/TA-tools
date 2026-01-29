import {Glob} from "bun";

import {CONFIG} from "../util/config.ts";
import {FilePayloadGenerator} from "../util/file-payload.ts";
import type {WorkflowDependencies} from "./index.ts";


export async function executeAnalysisWorkflow(workflow: typeof CONFIG.analysis_workflows[number], runNum: number, deps: WorkflowDependencies) {
    console.log(`Executing analysis workflow: ${workflow.slug}`);
    const log = (...args: Parameters<typeof console.log>) => {
        console.log(`[${workflow.slug}]`, ...args);
    }
    const warn = (...args: Parameters<typeof console.warn>) => {
        console.warn(`[${workflow.slug}]`, ...args);
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
        warn(`No files found for workflow, skipping...`);
        return;
    }
    log(`Found ${allFiles.length} files for workflow`);
    const fileContentsPayload = await FilePayloadGenerator.generatePayloads(allFiles);
    
    log("Sending chat completion request...");
    let startTime = Date.now();
    const seed = Math.floor(Date.now() / 1000);
    let completion = await deps.openRouter.chat.send({
        model: CONFIG.openrouter.model,
        maxCompletionTokens: CONFIG.hyperparameters.max_completion_tokens,
        messages: [
            {
                role: "system",
                content: workflow.prompt,
            },
            {
                role: "user",
                content: fileContentsPayload.map((file) => {
                    return {
                        type: "text",
                        text: file,
                    }
                }),
            }
        ],
        stream: false,
        seed: seed,
        frequencyPenalty: CONFIG.hyperparameters.frequency_penalty,
        presencePenalty: CONFIG.hyperparameters.presence_penalty,
        temperature: CONFIG.hyperparameters.temperature,
        reasoning: {
            effort: CONFIG.hyperparameters.reasoning_effort,
        },
    });
    log(`Completion response generated in ${(Date.now() - startTime) / 1000} seconds`);
    log(completion);
    log(completion.usage);
    log(completion.choices);
    if (completion.choices.length < 1){
        warn("No choices returned from completion");
    }
    const completionText = completion.choices[0]?.message.content?.toString() ?? "";
    // TODO: Add more template variables
    const outputFileName = workflow.output_filename
        .replaceAll("[seed]", seed.toString())
        .replaceAll("[slug]", workflow.slug)
        .replaceAll("[model]", `(${completion.model.replaceAll("/", "--")})`)
        .replaceAll("[run]", runNum.toString());
    await Bun.write(outputFileName, completionText);
    log(`Completion written to ${outputFileName}`);
}

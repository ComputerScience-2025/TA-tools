import {Glob} from "bun";

import {OpenRouter} from "@openrouter/sdk";

import {CONFIG} from "./util/config.ts";
import {FilePayloadGenerator} from "./util/file-payload.ts";


console.log("index.ts");

const openRouter = new OpenRouter({
    apiKey: CONFIG.openrouter.api_key,
});


async function executeBasicWorkflow(workflow: typeof CONFIG.basic_workflows[number]) {
    console.log(`Executing workflow: ${workflow.slug}`);
    const log = (...args: Parameters<typeof console.log>) => {
        console.log(`[${workflow.slug}]`, ...args);
    }
    const warn = (...args: Parameters<typeof console.warn>) => {
        console.warn(`[${workflow.slug}]`, ...args);
    }
    
    const fileExclusionsSet = new Set(workflow.excluded_files);
    const glob = new Glob(workflow.file_glob);
    let files = [];
    for await (const file of glob.scan(workflow.search_directory)) {
        if (fileExclusionsSet.has(file)) {
            log(`Excluding file: ${file}`);
            continue;
        }
        
        files.push(file);
    }
    if (files.length === 0) {
        warn(`No files found for workflow in "${workflow.search_directory}" directory, skipping...`);
        return;
    }
    
    log("Files found:", files);
    const fileContentsPayload = await FilePayloadGenerator.generatePayloads(files);
    
    log("Sending chat completion request...");
    let startTime = Date.now();
    let completion = await openRouter.chat.send({
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
    const outputFileName = workflow.output_filename;
    await Bun.write(outputFileName, completionText);
}

// Parallelize workflows with Promise.allSettled
const workflows = CONFIG.basic_workflows;
const results = await Promise.allSettled(
    workflows.map((workflow) => executeBasicWorkflow(workflow))
);

// Summarize with indices to include slugs in failure logs
const failedIndices: number[] = [];
const succeededIndices: number[] = [];
results.forEach((r, i) => {
    if (r.status === "rejected") failedIndices.push(i);
    else succeededIndices.push(i);
});

console.log(`Workflows completed. Succeeded: ${succeededIndices.length}; Failed: ${failedIndices.length}`);
if (failedIndices.length > 0) {
    failedIndices.forEach((i) => {
        const r = results[i] as PromiseRejectedResult;
        const slug = workflows[i]?.slug ?? `#${i + 1}`;
        console.warn(`Workflow '${slug}' failed:`, r.reason);
    });
}

console.log("index.ts done");

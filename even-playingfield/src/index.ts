import {Glob} from "bun";

import {OpenRouter} from "@openrouter/sdk";

import {CONFIG} from "./util/config.ts";
import {FilePayloadGenerator} from "./util/file-payload.ts";


console.log("index.ts");

const openRouter = new OpenRouter({
    apiKey: CONFIG.openrouter.api_key,
});


async function executeWorkflow(workflow: typeof CONFIG.basic_workflows[number]) {
    console.log(`Executing workflow: ${workflow.slug}`);
    
    const fileExclusionsSet = new Set(workflow.excluded_files);
    const glob = new Glob(workflow.file_glob);
    let files = [];
    for await (const file of glob.scan(workflow.search_directory)) {
        if (fileExclusionsSet.has(file)) {
            console.log(`Excluding file: ${file}`);
            continue;
        }
        
        files.push(file);
    }
    if (files.length === 0) {
        console.warn(`No files found for workflow in "${workflow.search_directory}" directory, skipping...`);
        return;
    }
    
    console.log("Files found:", files);
    const fileContentsPayload = await FilePayloadGenerator.generatePayloads(files);
    
    console.log("Sending chat completion request...");
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
    console.log(`Completion response generated in ${(Date.now() - startTime) / 1000} seconds`);
    console.log(completion);
    console.log(completion.usage);
    console.log(completion.choices);
    if (completion.choices.length < 1){
        console.warn("No choices returned from completion");
    }
    const completionText = completion.choices[0]?.message.content?.toString() ?? "";
    const outputFileName = workflow.output_filename;
    await Bun.file(outputFileName).write(completionText);
}

// TODO: Parallelize workflows?
for (const workflow of CONFIG.basic_workflows) {
    await executeWorkflow(workflow);
}

console.log("index.ts done");

import type {SystemMessage, UserMessage} from "@openrouter/sdk/models";

import {CONFIG} from "./config.ts";
import type {WorkflowDependencies} from "../workflow";
import {recordCompletionInput} from "./eval-harness.ts";


export async function generateCompletion(deps: WorkflowDependencies,
                                         log: (..._: any[])=>void,
                                         warn: (..._: any[])=>void,
                                         model: string,
                                         systemPrompt: string,
                                         content: UserMessage["content"]) {
    let modelSettings = CONFIG.llm.models[model];
    if (!modelSettings) {
        throw new Error(`No model settings found for model "${model}"`);
    }
    
    let replacedCount = 0;
    for (const [replacementKey, replacementValue] of Object.entries(CONFIG.llm.prompt_replacement)) {
        if (systemPrompt.includes(replacementKey)) {replacedCount++}
        systemPrompt = systemPrompt.replaceAll(`{{${replacementKey}}}`, replacementValue);
        if (typeof content === "string") {
            if (content.includes(replacementKey)) {replacedCount++}
            content = content.replaceAll(`{{${replacementKey}}}`, replacementValue);
        }
        else {
            for (let i = 0; i < content.length; i++) {
                const element = content[i];
                if (element && "type" in element && element.type === "text" && typeof element.text === "string") {
                    if (element.text.includes(replacementKey)) {replacedCount++}
                    content[i] = {
                        ...element,
                        text: element.text.replaceAll(`{{${replacementKey}}}`, replacementValue),
                    }
                }
            }
            
        }
    }
    log(`Replaced ${replacedCount} instances of prompt variables in system prompt and content`);
    
    let messages: (SystemMessage | UserMessage)[] = [
        {
            role: "system",
            content: systemPrompt,
        },
        {
            role: "user",
            content: content,
        }
    ];
    setTimeout(async ()=> await recordCompletionInput(messages), 5);
    
    log("Sending chat completion request...");
    let startTime = Date.now();
    let completion = await deps.openRouter.chat.send({
        model: modelSettings.model_name,
        maxCompletionTokens: modelSettings.max_completion_tokens,
        messages: messages,
        stream: false,
        seed: deps.seed,
        frequencyPenalty: modelSettings.frequency_penalty,
        presencePenalty: modelSettings.presence_penalty,
        temperature: modelSettings.temperature,
        reasoning: {
            effort: modelSettings.reasoning_effort,
        },
    });
    log(`Completion response generated in ${(Date.now() - startTime) / 1000} seconds`);
    if (completion.choices.length < 1){
        warn("No choices returned from completion");
        console.log(completion);
    }
    
    return {
        text: completion.choices[0]?.message.content?.toString() ?? "",
        model: completion.model,
    };
}

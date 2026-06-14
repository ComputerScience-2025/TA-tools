import type {ChatSystemMessage, ChatUserMessage} from "@openrouter/sdk/models";

import {CONFIG} from "./config.ts";
import type {WorkflowDependencies} from "../workflow";
import {recordCompletionInput} from "./eval-harness.ts";


async function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function generateCompletion(deps: WorkflowDependencies,
                                         log: (..._: any[])=>void,
                                         warn: (..._: any[])=>void,
                                         model: string,
                                         systemPrompt: string,
                                         content: ChatUserMessage["content"]) {
    let modelSettings = CONFIG.llm.models[model];
    if (!modelSettings) {
        throw new Error(`No model settings found for model "${model}"`);
    }

    let replacedCount = 0;
    for (const [replacementKey, replacementValue] of Object.entries(CONFIG.llm.prompt_replacement)) {
        if (systemPrompt.includes(replacementKey)) {replacedCount++;}
        systemPrompt = systemPrompt.replaceAll(`{{${replacementKey}}}`, replacementValue);
        if (typeof content === "string") {
            if (content.includes(replacementKey)) {replacedCount++;}
            content = content.replaceAll(`{{${replacementKey}}}`, replacementValue);
        }
        else {
            for (let i = 0; i < content.length; i++) {
                const element = content[i];
                if (element && "type" in element && element.type === "text" && typeof element.text === "string") {
                    if (element.text.includes(replacementKey)) {replacedCount++;}
                    content[i] = {
                        ...element,
                        text: element.text.replaceAll(`{{${replacementKey}}}`, replacementValue),
                    };
                }
            }
        }
    }
    log(`Replaced ${replacedCount} instances of prompt variables in system prompt and content`);

    let messages: (ChatSystemMessage | ChatUserMessage)[] = [
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

    const maxRetries = modelSettings.max_retries;
    const retryDelayMs = modelSettings.retry_delay_ms;
    const totalAttempts = maxRetries + 1;

    let lastError: unknown = null;

    for (let attempt = 0; attempt < totalAttempts; attempt++) {
        const attemptLabel = `${attempt + 1}/${totalAttempts}`;

        if (attempt > 0) {
            const backoffMs = retryDelayMs * (2 ** (attempt - 1)) + Math.random() * 200;
            warn(`Retrying after ${Math.round(backoffMs)}ms (attempt ${attemptLabel})...`);
            await delay(backoffMs);
        }

        log(`Sending chat completion request (attempt ${attemptLabel})...`);
        let startTime = Date.now();

        try {
            let completion = await deps.openRouter.chat.send({chatRequest: {
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
            }});
            log(`Completion response received in ${(Date.now() - startTime) / 1000}s (attempt ${attemptLabel})`);

            const text = completion.choices[0]?.message.content?.toString() ?? "";

            if (completion.choices.length < 1 || text.length === 0) {
                warn(`Empty completion on attempt ${attemptLabel}`);
                console.log(completion);
                // Retry if attempts remain; otherwise return empty
                if (attempt < maxRetries) {
                    continue;
                }
                warn("Exhausted all retries — returning empty completion");
                return {text: "", model: completion.model};
            }

            return {text, model: completion.model};

        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            warn(`Chat completion error on attempt ${attemptLabel}: ${message}`);
            lastError = error;
            // Loop continues to next attempt (or exits if this was the last)
        }
    }

    warn("Exhausted all retries due to errors — re-throwing last error");
    throw lastError;
}

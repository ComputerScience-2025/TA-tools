import { generateText, type JSONValue, type LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

import { CONFIG } from "./config.ts";
import { ProviderSDKEnum } from "./config-schema.ts";
import type { WorkflowDependencies } from "../workflow/index.ts";


type UserContent = string | Array<{ type: "text"; text: string }>;

type Provider = (modelId: string) => LanguageModel;

const providerCache = new Map<string, Provider>();

export function clearProviderCache(): void {
    providerCache.clear();
}

function createProvider(providerName: string): Provider {
    const cached = providerCache.get(providerName);
    if (cached) {
        return cached;
    }

    const providerConfig = CONFIG.llm.providers[providerName];
    if (!providerConfig) {
        throw new Error(`No provider config found for provider "${providerName}"`);
    }

    // api_key is intentionally required in TOML. We deliberately pass it here
    // so the Vercel AI SDK does not fall back to its env-var defaults.
    const options: { apiKey: string; baseURL?: string } = {
        apiKey: providerConfig.api_key,
    };
    if (providerConfig.endpoint.length > 0) {
        options.baseURL = providerConfig.endpoint;
    }

    let provider: Provider;
    switch (providerConfig.sdk) {
        case ProviderSDKEnum.OpenAI:
            provider = createOpenAI(options);
            break;
        case ProviderSDKEnum.Anthropic:
            provider = createAnthropic(options);
            break;
        case ProviderSDKEnum.Google:
            provider = createGoogleGenerativeAI(options);
            break;
        default:
            throw new Error(`Unsupported SDK "${providerConfig.sdk}" for provider "${providerName}"`);
    }

    providerCache.set(providerName, provider);
    return provider;
}

function buildProviderOptions(modelSettings: typeof CONFIG.llm.models[string],
                              sdk: ProviderSDKEnum): Record<string, Record<string, JSONValue>> {
    // We intentionally support only provider-native reasoning-level options.
    // Budget-based thinking (Anthropic thinking.budgetTokens / Google thinkingConfig.thinkingBudget)
    // is not supported because those models are considered old for this project.
    switch (sdk) {
        case ProviderSDKEnum.OpenAI:
            return { openai: { reasoningEffort: modelSettings.reasoning_effort } };
        case ProviderSDKEnum.Anthropic:
            return { anthropic: { effort: modelSettings.reasoning_effort } };
        case ProviderSDKEnum.Google:
            if (modelSettings.reasoning_effort === "xhigh") {
                throw new Error(`Google provider does not support reasoning_effort "xhigh"; use "low", "medium", or "high"`);
            }
            return { google: { thinkingConfig: { thinkingLevel: modelSettings.reasoning_effort } } };
    }
}

async function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export async function generateCompletion(deps: WorkflowDependencies,
                                         log: (..._: any[]) => void,
                                         warn: (..._: any[]) => void,
                                         model: string,
                                         systemPrompt: string,
                                         content: UserContent) {
    const modelSettings = CONFIG.llm.models[model];
    if (!modelSettings) {
        throw new Error(`No model settings found for model "${model}"`);
    }

    const providerConfig = CONFIG.llm.providers[modelSettings.provider];
    if (!providerConfig) {
        throw new Error(`Model "${model}" references unknown provider "${modelSettings.provider}"`);
    }

    let replacedCount = 0;
    for (const [replacementKey, replacementValue] of Object.entries(CONFIG.llm.prompt_replacement)) {
        if (systemPrompt.includes(replacementKey)) { replacedCount++; }
        systemPrompt = systemPrompt.replaceAll(`{{${replacementKey}}}`, replacementValue);
        if (typeof content === "string") {
            if (content.includes(replacementKey)) { replacedCount++; }
            content = content.replaceAll(`{{${replacementKey}}}`, replacementValue);
        }
        else {
            for (let i = 0; i < content.length; i++) {
                const element = content[i];
                if (element && element.type === "text" && typeof element.text === "string") {
                    if (element.text.includes(replacementKey)) { replacedCount++; }
                    content[i] = {
                        ...element,
                        text: element.text.replaceAll(`{{${replacementKey}}}`, replacementValue),
                    };
                }
            }
        }
    }
    log(`Replaced ${replacedCount} instances of prompt variables in system prompt and content`);

    const userMessage: { role: "user"; content: UserContent } = {
        role: "user",
        content: content,
    };

    const provider = createProvider(modelSettings.provider);
    const languageModel = provider(modelSettings.model_name);
    const providerOptions = buildProviderOptions(modelSettings, providerConfig.sdk);

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
        const startTime = Date.now();

        try {
            const result = await generateText({
                model: languageModel,
                system: systemPrompt,
                messages: [userMessage],
                maxOutputTokens: modelSettings.max_completion_tokens,
                temperature: modelSettings.temperature,
                topP: modelSettings.top_p,
                frequencyPenalty: modelSettings.frequency_penalty,
                presencePenalty: modelSettings.presence_penalty,
                seed: deps.seed,
                maxRetries: 0,
                providerOptions,
            });
            log(`Completion response received in ${(Date.now() - startTime) / 1000}s (attempt ${attemptLabel})`);

            const text = result.text;
            if (text.length === 0) {
                warn(`Empty completion on attempt ${attemptLabel}`);
                console.log(result);
                if (attempt < maxRetries) {
                    continue;
                }
                warn("Exhausted all retries — returning empty completion");
                return { text: "", model: result.response.modelId };
            }

            return { text, model: result.response.modelId };

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

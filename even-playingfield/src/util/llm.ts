import { generateText, type JSONValue, type LanguageModel } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import { createGoogleGenerativeAI } from "@ai-sdk/google";

import { ProviderSDKEnum, type LLMConfig, type ModelConfig } from "./config-schema.ts";


type UserContent = string | Array<{ type: "text"; text: string }>;

type Provider = (modelId: string) => LanguageModel;

export type CompletionMetrics = {
    model: string;
    provider: string;
    promptTokens: number;
    completionTokens: number;
    totalTokens: number;
    finishReason: string;
    latencyMs: number;
    attempts: number;
};

/**
 * Instance-scoped LLM client. Owns its own provider cache keyed by provider
 * name, so a fresh LlmClient (built on config reload) starts with an empty
 * cache. Reads all settings from the injected LLMConfig rather than any
 * module-level global.
 */
export class LlmClient {
    private readonly llm: LLMConfig;
    private readonly providerCache: Map<string, Provider> = new Map();

    constructor(llm: LLMConfig) {
        this.llm = llm;
    }

    private createProvider(providerName: string): Provider {
        const cached = this.providerCache.get(providerName);
        if (cached) {
            return cached;
        }

        const providerConfig = this.llm.providers[providerName];
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

        this.providerCache.set(providerName, provider);
        return provider;
    }

    private buildProviderOptions(modelSettings: ModelConfig,
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

    async generateCompletion(log: (..._: any[]) => void,
                             warn: (..._: any[]) => void,
                             model: string,
                             systemPrompt: string,
                             content: UserContent): Promise<{ text: string; model: string; metrics: CompletionMetrics }> {
        const modelSettings = this.llm.models[model];
        if (!modelSettings) {
            throw new Error(`No model settings found for model "${model}"`);
        }

        const providerConfig = this.llm.providers[modelSettings.provider];
        if (!providerConfig) {
            throw new Error(`Model "${model}" references unknown provider "${modelSettings.provider}"`);
        }

        let replacedCount = 0;
        for (const [replacementKey, replacementValue] of Object.entries(this.llm.prompt_replacement)) {
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

        const provider = this.createProvider(modelSettings.provider);
        const languageModel = provider(modelSettings.model_name);
        const providerOptions = this.buildProviderOptions(modelSettings, providerConfig.sdk);

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
                    seed: modelSettings.seed,
                    maxRetries: 0,
                    providerOptions,
                });
                const latencyMs = Date.now() - startTime;
                log(`Completion response received in ${latencyMs / 1000}s (attempt ${attemptLabel})`);

                const text = result.text;
                const metrics: CompletionMetrics = {
                    model,
                    provider: modelSettings.provider,
                    promptTokens: result.usage.inputTokens ?? 0,
                    completionTokens: result.usage.outputTokens ?? 0,
                    totalTokens: result.usage.totalTokens ?? 0,
                    finishReason: result.finishReason,
                    latencyMs,
                    attempts: attempt + 1,
                };
                if (text.length === 0) {
                    warn(`Empty completion on attempt ${attemptLabel}`);
                    console.log(result);
                    if (attempt < maxRetries) {
                        continue;
                    }
                    warn("Exhausted all retries — returning empty completion");
                    return { text: "", model: result.response.modelId, metrics };
                }

                return { text, model: result.response.modelId, metrics };

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
}

async function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

import { generateText, streamText, type JSONValue, type LanguageModel, type ModelMessage } from "ai";
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

/** What `generateCompletion` returns. Extra fields let a host persist the run. */
export type CompletionResult = {
    text: string;
    model: string;
    metrics: CompletionMetrics;
    /** System prompt after prompt replacement. */
    system: string;
    /** The messages that were sent (user content after prompt replacement). */
    requestMessages: ModelMessage[];
    /** The assistant message(s) that were generated, including reasoning parts. */
    responseMessages: ModelMessage[];
};

/** Progress callbacks for a streamed chat turn. */
export type ChatStreamHandlers = {
    onText?: (delta: string) => void;
    onReasoning?: (delta: string) => void;
};

/** Result of one streamed chat turn. Failures keep their partial output. */
export type ChatStreamResult = {
    status: "succeeded" | "failed";
    text: string;
    reasoning: string;
    /** Assistant messages from a successful turn (empty when it failed). */
    responseMessages: ModelMessage[];
    metrics: CompletionMetrics | null;
    error?: string;
};

type ModelContext = {
    modelSettings: ModelConfig;
    providerConfig: LLMConfig["providers"][string];
    languageModel: LanguageModel;
    providerOptions: Record<string, Record<string, JSONValue>>;
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
        // `headers` carries provider-specific requirements (e.g. Anthropic's
        // browser-access header) without the SDK inventing its own.
        const options: { apiKey: string; baseURL?: string; headers?: Record<string, string> } = {
            apiKey: providerConfig.api_key,
        };
        if (providerConfig.endpoint.length > 0) {
            options.baseURL = providerConfig.endpoint;
        }
        if (Object.keys(providerConfig.headers).length > 0) {
            options.headers = { ...providerConfig.headers };
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

    /** Resolve a model key into everything a completion request needs. */
    private resolveModelContext(model: string): ModelContext {
        const modelSettings = this.llm.models[model];
        if (!modelSettings) {
            throw new Error(`No model settings found for model "${model}"`);
        }

        const providerConfig = this.llm.providers[modelSettings.provider];
        if (!providerConfig) {
            throw new Error(`Model "${model}" references unknown provider "${modelSettings.provider}"`);
        }

        const provider = this.createProvider(modelSettings.provider);
        return {
            modelSettings,
            providerConfig,
            languageModel: provider(modelSettings.model_name),
            providerOptions: this.buildProviderOptions(modelSettings, providerConfig.sdk),
        };
    }

    /**
     * Replace `{{name}}` placeholders in the system prompt and user content.
     * Workflow runs use this; chat turns replay already-resolved text verbatim.
     */
    private applyPromptReplacements(systemPrompt: string,
                                    content: UserContent): { systemPrompt: string; content: UserContent; replacedCount: number } {
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
        return { systemPrompt, content, replacedCount };
    }

    private buildMetrics(model: string,
                         modelSettings: ModelConfig,
                         usage: { inputTokens?: number | null; outputTokens?: number | null; totalTokens?: number | null },
                         finishReason: string,
                         latencyMs: number,
                         attempts: number): CompletionMetrics {
        return {
            model,
            provider: modelSettings.provider,
            promptTokens: usage.inputTokens ?? 0,
            completionTokens: usage.outputTokens ?? 0,
            totalTokens: usage.totalTokens ?? 0,
            finishReason,
            latencyMs,
            attempts,
        };
    }

    async generateCompletion(log: (..._: any[]) => void,
                             warn: (..._: any[]) => void,
                             model: string,
                             systemPrompt: string,
                             content: UserContent): Promise<CompletionResult> {
        const context = this.resolveModelContext(model);
        const replaced = this.applyPromptReplacements(systemPrompt, content);
        systemPrompt = replaced.systemPrompt;
        content = replaced.content;
        log(`Replaced ${replaced.replacedCount} instances of prompt variables in system prompt and content`);

        const userMessage: { role: "user"; content: UserContent } = {
            role: "user",
            content: content,
        };
        const requestMessages: ModelMessage[] = [userMessage as ModelMessage];

        const { modelSettings, providerOptions } = context;
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
                    model: context.languageModel,
                    system: systemPrompt,
                    messages: requestMessages,
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
                const metrics = this.buildMetrics(
                    model,
                    modelSettings,
                    result.usage,
                    result.finishReason,
                    latencyMs,
                    attempt + 1,
                );
                const responseMessages = result.response.messages as ModelMessage[];
                if (text.length === 0) {
                    warn(`Empty completion on attempt ${attemptLabel}`);
                    if (attempt < maxRetries) {
                        continue;
                    }
                    warn("Exhausted all retries — returning empty completion");
                    return {
                        text: "",
                        model: result.response.modelId,
                        metrics,
                        system: systemPrompt,
                        requestMessages,
                        responseMessages,
                    };
                }

                return {
                    text,
                    model: result.response.modelId,
                    metrics,
                    system: systemPrompt,
                    requestMessages,
                    responseMessages,
                };

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

    /**
     * Stream one chat turn. Tokens are handed to `handlers` as they arrive; the
     * final assistant messages (including reasoning parts) are returned for the
     * caller to persist.
     *
     * Retries happen only while nothing has been emitted, because replaying a
     * partially visible answer would duplicate output in the transcript.
     */
    async chatStream(log: (..._: any[]) => void,
                     warn: (..._: any[]) => void,
                     model: string,
                     systemPrompt: string,
                     messages: ModelMessage[],
                     handlers: ChatStreamHandlers = {},
                     signal?: AbortSignal): Promise<ChatStreamResult> {
        const context = this.resolveModelContext(model);
        const { modelSettings, providerOptions } = context;
        const maxRetries = modelSettings.max_retries;
        const retryDelayMs = modelSettings.retry_delay_ms;
        const totalAttempts = maxRetries + 1;

        let partialText = "";
        let partialReasoning = "";
        let emitted = 0;
        let lastError: unknown = null;

        for (let attempt = 0; attempt < totalAttempts; attempt++) {
            const attemptLabel = `${attempt + 1}/${totalAttempts}`;

            if (attempt > 0) {
                const backoffMs = retryDelayMs * (2 ** (attempt - 1)) + Math.random() * 200;
                warn(`Retrying after ${Math.round(backoffMs)}ms (attempt ${attemptLabel})...`);
                await delay(backoffMs);
            }

            log(`Sending streamed chat request (attempt ${attemptLabel})...`);
            const startTime = Date.now();

            try {
                const result = streamText({
                    model: context.languageModel,
                    system: systemPrompt,
                    messages,
                    maxOutputTokens: modelSettings.max_completion_tokens,
                    temperature: modelSettings.temperature,
                    topP: modelSettings.top_p,
                    frequencyPenalty: modelSettings.frequency_penalty,
                    presencePenalty: modelSettings.presence_penalty,
                    seed: modelSettings.seed,
                    maxRetries: 0,
                    providerOptions,
                    abortSignal: signal,
                });

                for await (const part of result.fullStream) {
                    switch (part.type) {
                        case "text-delta":
                            partialText += part.text;
                            emitted += 1;
                            handlers.onText?.(part.text);
                            break;
                        case "reasoning-delta":
                            partialReasoning += part.text;
                            emitted += 1;
                            handlers.onReasoning?.(part.text);
                            break;
                        case "error":
                            throw part.error instanceof Error ? part.error : new Error(String(part.error));
                        case "abort":
                            throw new ChatAbortedError(part.reason);
                        default:
                            break;
                    }
                }

                const [response, usage, finishReason] = await Promise.all([
                    result.response,
                    result.usage,
                    result.finishReason,
                ]);
                const latencyMs = Date.now() - startTime;
                log(`Stream finished in ${latencyMs / 1000}s (attempt ${attemptLabel})`);

                return {
                    status: "succeeded",
                    text: partialText,
                    reasoning: partialReasoning,
                    responseMessages: response.messages as ModelMessage[],
                    metrics: this.buildMetrics(model, modelSettings, usage, finishReason, latencyMs, attempt + 1),
                };
            } catch (error) {
                const aborted = signal?.aborted === true || error instanceof ChatAbortedError;
                const message = aborted
                    ? "Stopped."
                    : error instanceof Error ? error.message : String(error);
                warn(`Streamed chat error on attempt ${attemptLabel}: ${message}`);
                lastError = error;

                // Once output is visible, a retry would duplicate it in the
                // transcript. Keep the partial answer and report the failure.
                if (emitted > 0 || aborted) {
                    return {
                        status: "failed",
                        text: partialText,
                        reasoning: partialReasoning,
                        responseMessages: [],
                        metrics: null,
                        error: message,
                    };
                }
            }
        }

        const message = lastError instanceof Error ? lastError.message : String(lastError ?? "Unknown error");
        warn("Exhausted all retries due to errors — returning the failure to the caller");
        return {
            status: "failed",
            text: partialText,
            reasoning: partialReasoning,
            responseMessages: [],
            metrics: null,
            error: message,
        };
    }
}

/** Thrown internally when the caller aborts a streamed turn. */
export class ChatAbortedError extends Error {
    constructor(reason?: string) {
        super(reason !== undefined && reason.length > 0 ? reason : "Chat stream aborted");
        this.name = "ChatAbortedError";
    }
}

async function delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
}

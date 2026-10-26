import { OutputViewer } from "../util/output-viewer.ts";
import { executeAnalysisWorkflow, type AnalysisWorkflowResult } from "../workflow/analysis-workflow.ts";
import { executeTestingWorkflow, type TestingWorkflowResult } from "../workflow/testing-workflow.ts";
import type { WorkflowDependencies } from "../workflow/index.ts";
import { loadConfig } from "../util/config-loader.ts";
import { LlmClient, type CompletionMetrics } from "../util/llm.ts";
import type { Config, ConfigSource } from "../util/config-loader.ts";
import type { LogLevel, Logger, Platform } from "../platform/types.ts";

export type WorkflowRunResult = {
    slug: string;
    runNumber: number;
    status: "succeeded" | "failed" | "rejected";
    error?: string;
    latencyMs?: number;
    outputs?: { filename: string; content: string }[];
    completions?: CompletionMetrics[];
    testCases?: { name: string; passed: boolean; explanation?: string }[];
};

export type EngineStatus = {
    inFlight: string[];
    completedFiles: string[];
};

/**
 * Observable events for hosts that need live progress (the web console pane).
 * The CLI ignores them and keeps printing through the platform logger.
 */
export type EngineEvent =
    | { type: "log"; level: LogLevel; message: string; slug?: string }
    | { type: "run-started"; slug: string; runNumber: number }
    | { type: "run-finished"; result: WorkflowRunResult }
    | { type: "files-changed" };

export type EngineListener = (event: EngineEvent) => void;

/**
 * Stateful core that owns the OutputViewer, WorkflowDependencies, and
 * in-flight tracking.  Runtime-agnostic — no process.stdin / stdout,
 * no HTTP server.  Input channels (CLI REPL, HTTP API, web console) call into
 * this via the CommandHandler.
 */
export class Engine {
    readonly outputViewer: OutputViewer;
    private config: Config;
    private llmClient: LlmClient;
    private deps: WorkflowDependencies;
    private readonly platform: Platform;
    private readonly inFlightSlugs: Set<string> = new Set();
    private readonly listeners: Set<EngineListener> = new Set();
    // Resolved config source from the initial load, so reloadConfig() can
    // re-read from the same place without the host re-supplying it.
    private configSource: ConfigSource | undefined;

    constructor(config: Config, platform: Platform, configSource?: ConfigSource) {
        this.config = config;
        this.platform = platform;
        this.configSource = configSource;
        this.outputViewer = new OutputViewer(platform.fs);
        this.llmClient = new LlmClient(config.llm);
        this.deps = this.buildDependencies();
    }

    /** Platform logger plus an event for every line, so hosts can mirror it. */
    private readonly logger: Logger = {
        log: (level: LogLevel, message: string, meta): void => {
            this.platform.logger.log(level, message, meta);
            this.emit({ type: "log", level, message, slug: meta?.slug });
        },
    };

    private buildDependencies(): WorkflowDependencies {
        return {
            outputViewer: this.outputViewer,
            config: this.config,
            llmClient: this.llmClient,
            fs: this.platform.fs,
            env: this.platform.env,
            shell: this.platform.shell,
            logger: this.logger,
        };
    }

    /** Subscribe to engine events. Returns an unsubscribe function. */
    addEventListener(listener: EngineListener): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    private emit(event: EngineEvent): void {
        for (const listener of this.listeners) {
            try {
                listener(event);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                this.platform.logger.log("error", `Engine event listener failed: ${message}`);
            }
        }
    }

    /**
     * Run workflows matching the given filters.
     * If `only` is provided, only run slugs in that list.
     * If `skip` is provided, skip slugs in that list.
     * Rejects any slug that is already in-flight.
     */
    async runWorkflows(filters?: { only?: string[]; skip?: string[] }): Promise<WorkflowRunResult[]> {
        const onlySlugs = filters?.only;
        const skipSlugs = filters?.skip;

        let analysisWorkflows = this.applyFilters(this.config.analysis_workflows, onlySlugs, skipSlugs);
        let testingWorkflows = this.applyFilters(this.config.testing_workflows, onlySlugs, skipSlugs);

        this.logger.log("info", `Starting execution of ${analysisWorkflows.length} analysis + ${testingWorkflows.length} testing workflows...`);
        const selectedSlugs = [...analysisWorkflows, ...testingWorkflows].map((w) => w.slug);
        this.logger.log("info", `Workflows: ${selectedSlugs.length > 0 ? selectedSlugs.join(", ") : "(none)"}`);

        const runs: { slug: string; runNumber: number; promise: Promise<AnalysisWorkflowResult | TestingWorkflowResult> }[] = [];
        const results: WorkflowRunResult[] = [];

        // Build run list, rejecting in-flight duplicates
        for (const workflow of analysisWorkflows) {
            if (this.inFlightSlugs.has(workflow.slug)) {
                results.push({ slug: workflow.slug, runNumber: 0, status: "rejected", error: "already running" });
                continue;
            }
            this.inFlightSlugs.add(workflow.slug);
            for (let i = 0; i < workflow.runs; i++) {
                this.emit({ type: "run-started", slug: workflow.slug, runNumber: i + 1 });
                runs.push({
                    slug: workflow.slug,
                    runNumber: i + 1,
                    promise: executeAnalysisWorkflow(workflow, i + 1, this.deps),
                });
            }
        }

        for (const workflow of testingWorkflows) {
            if (this.inFlightSlugs.has(workflow.slug)) {
                results.push({ slug: workflow.slug, runNumber: 0, status: "rejected", error: "already running" });
                continue;
            }
            this.inFlightSlugs.add(workflow.slug);
            for (let i = 0; i < workflow.runs; i++) {
                this.emit({ type: "run-started", slug: workflow.slug, runNumber: i + 1 });
                runs.push({
                    slug: workflow.slug,
                    runNumber: i + 1,
                    promise: executeTestingWorkflow(workflow, i + 1, this.deps),
                });
            }
        }

        // Execute all non-rejected runs in parallel
        const settled = await Promise.allSettled(runs.map((r) => r.promise));

        // Collect results and clear in-flight tracking
        const completedSlugs = new Set<string>();
        for (let i = 0; i < settled.length; i++) {
            const run = runs[i]!;
            const outcome = settled[i]!;
            completedSlugs.add(run.slug);
            if (outcome.status === "fulfilled") {
                const value = outcome.value;
                const result: WorkflowRunResult = {
                    slug: run.slug,
                    runNumber: run.runNumber,
                    status: value.status,
                    error: value.error,
                    latencyMs: value.latencyMs,
                    outputs: "outputs" in value ? value.outputs : undefined,
                    completions: value.completions,
                    testCases: "testCases" in value ? value.testCases : undefined,
                };
                results.push(result);
                this.emit({ type: "run-finished", result });
            } else {
                const errorMsg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
                this.logger.log("warn", `Workflow '${run.slug}' run ${run.runNumber} failed: ${errorMsg}`, { data: [outcome.reason] });
                const result: WorkflowRunResult = { slug: run.slug, runNumber: run.runNumber, status: "failed", error: errorMsg };
                results.push(result);
                this.emit({ type: "run-finished", result });
            }
        }

        // Remove completed slugs from in-flight set
        for (const slug of completedSlugs) {
            this.inFlightSlugs.delete(slug);
        }

        this.emit({ type: "files-changed" });
        return results;
    }

    /**
     * Reload config from the same source as the initial run.
     * Reinitializes LLM settings and workflow lists.
     * Does not affect output_viewing settings or in-flight workflows.
     */
    async reloadConfig(): Promise<void> {
        const resolved = await loadConfig(this.platform, this.configSource);
        this.config = resolved.config;
        this.configSource = resolved.source;
        // Rebuild the LlmClient so its provider cache resets to the new keys.
        this.llmClient = new LlmClient(this.config.llm);
        this.deps = this.buildDependencies();
    }

    /** Clear output files. If slugs provided, only clear matching filenames. */
    clearResults(slugFilter?: string[]): void {
        this.outputViewer.clearFiles(slugFilter);
        this.emit({ type: "files-changed" });
    }

    /** Clear exactly these output filenames from the in-memory result list. */
    clearResultFiles(names: readonly string[]): void {
        this.outputViewer.clearFileNames(names);
        this.emit({ type: "files-changed" });
    }

    /**
     * Resolve the static filename prefix for each workflow matched by the slug filter.
     * Uses the literal portion of `output_filename` before the first `[` placeholder,
     * which is the stable, config-defined part of the filename regardless of runtime
     * values ([seed], [model], [run], etc.).
     * Pass the result to clearResults() to accurately target the right output files.
     *
     * Filenames that start with a placeholder yield an empty prefix, which would
     * match every file; those are dropped instead of returned.
     */
    resolveOutputFilePatterns(slugs?: string[]): string[] {
        const onlySlugs = slugs && slugs.length > 0 ? slugs : undefined;
        const allWorkflows = [
            ...this.applyFilters(this.config.analysis_workflows, onlySlugs),
            ...this.applyFilters(this.config.testing_workflows, onlySlugs),
        ];
        return allWorkflows
            .map((w) => {
                const bracketIdx = w.output_filename.indexOf("[");
                return bracketIdx === -1 ? w.output_filename : w.output_filename.slice(0, bracketIdx);
            })
            .filter((prefix) => prefix.length > 0);
    }

    /**
     * Select the recorded output filenames that belong to the workflows matched
     * by the slug filter.
     *
     * `knownOutputs` is the host's list of files that finished runs actually
     * wrote (the browser keeps it across reloads). Each configured filename is
     * matched as an anchored glob where `[slug]`, `[model]`, `[seed]` and
     * `[run]` are wildcards, so similarly named workflows stay distinguishable.
     *
     * Returns [] when nothing is known, so callers never fall back to matching
     * every file in the working directory.
     */
    resolveOutputFileNames(knownOutputs: readonly string[], slugs?: string[]): string[] {
        const onlySlugs = slugs && slugs.length > 0 ? slugs : undefined;
        const matchedWorkflows = [
            ...this.applyFilters(this.config.analysis_workflows, onlySlugs),
            ...this.applyFilters(this.config.testing_workflows, onlySlugs),
        ];

        const patterns = matchedWorkflows.map((workflow) => outputFilenamePattern(workflow.output_filename));
        if (patterns.length === 0) {
            return [];
        }

        const unique = [...new Set(knownOutputs)];
        return unique.filter((name) => patterns.some((pattern) => pattern.test(name)));
    }

    /** Return current engine state snapshot. */
    getStatus(): EngineStatus {
        return {
            inFlight: [...this.inFlightSlugs],
            completedFiles: this.outputViewer.getFileList().map((f) => f.name),
        };
    }

    /**
     * Current config snapshot. Always fresh — updated by reloadConfig().
     * Use this rather than caching a copy, which would go stale on reload.
     */
    getConfig(): Config {
        return this.config;
    }

    /** Where the current config was loaded from (undefined for injected configs). */
    getConfigSource(): ConfigSource | undefined {
        return this.configSource;
    }

    /** List all configured workflow slugs grouped by type. */
    listWorkflows(): { analysis: string[]; testing: string[] } {
        return {
            analysis: this.config.analysis_workflows.map((w) => w.slug),
            testing: this.config.testing_workflows.map((w) => w.slug),
        };
    }

    /** Apply --only / --skip filters to a workflow list. */
    private applyFilters<T extends { slug: string }>(workflows: T[], onlySlugs?: string[], skipSlugs?: string[]): T[] {
        let filtered = workflows;
        if (onlySlugs && onlySlugs.length > 0) {
            filtered = filtered.filter((w) => {
                if (onlySlugs.includes(w.slug)) {
                    return true;
                }
                this.logger.log("info", `Skipping workflow '${w.slug}' (not in --only_workflows list)`);
                return false;
            });
        }
        if (skipSlugs && skipSlugs.length > 0) {
            filtered = filtered.filter((w) => {
                if (skipSlugs.includes(w.slug)) {
                    this.logger.log("info", `Skipping workflow '${w.slug}' (matched --skip_workflow)`);
                    return false;
                }
                return true;
            });
        }
        return filtered;
    }
}

/**
 * Build an anchored matcher for a configured output filename. Placeholders are
 * replaced at run time; treating each as a wildcard distinguishes workflows
 * whose literal filename prefixes overlap (the old substring heuristic could
 * delete another workflow's results).
 */
function outputFilenamePattern(pattern: string): RegExp {
    const placeholders = new Set(["[slug]", "[model]", "[seed]", "[run]"]);
    const body = pattern
        .split(/(\[(?:slug|model|seed|run)\])/)
        .map((part) => placeholders.has(part) ? ".+" : part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
        .join("");
    return new RegExp(`^${body}$`);
}

import { OutputViewer } from "../util/output-viewer.ts";
import { executeAnalysisWorkflow, type AnalysisWorkflowResult } from "../workflow/analysis-workflow.ts";
import { executeTestingWorkflow, type TestingWorkflowResult } from "../workflow/testing-workflow.ts";
import type { WorkflowDependencies } from "../workflow/index.ts";
import { readConfig } from "../util/config.ts";
import { LlmClient, type CompletionMetrics } from "../util/llm.ts";
import type { Config } from "../util/config.ts";

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
 * Stateful core that owns the OutputViewer, WorkflowDependencies, and
 * in-flight tracking.  Runtime-agnostic — no process.stdin / stdout,
 * no HTTP server.  Input channels (CLI REPL, HTTP API) call into this
 * via the CommandHandler.
 */
export class Engine {
    readonly outputViewer: OutputViewer;
    private config: Config;
    private llmClient: LlmClient;
    private deps: WorkflowDependencies;
    private readonly inFlightSlugs: Set<string> = new Set();
    // Resolved config path/URL from the initial load, so reloadConfig() can
    // re-read from the same source without the host re-supplying it.
    private resolvedConfigPath: string | undefined;

    constructor(config: Config, resolvedConfigPath?: string) {
        this.config = config;
        this.resolvedConfigPath = resolvedConfigPath;
        this.outputViewer = new OutputViewer();
        this.llmClient = new LlmClient(config.llm);
        this.deps = {
            outputViewer: this.outputViewer,
            config: this.config,
            llmClient: this.llmClient,
        };
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

        console.log(`Starting execution of ${analysisWorkflows.length} analysis + ${testingWorkflows.length} testing workflows...`);
        console.log([...analysisWorkflows, ...testingWorkflows].map((w) => w.slug));

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
                results.push({
                    slug: run.slug,
                    runNumber: run.runNumber,
                    status: value.status,
                    error: value.error,
                    latencyMs: value.latencyMs,
                    outputs: "outputs" in value ? value.outputs : undefined,
                    completions: value.completions,
                    testCases: "testCases" in value ? value.testCases : undefined,
                });
            } else {
                const errorMsg = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
                console.warn(`Workflow '${run.slug}' run ${run.runNumber} failed:`, outcome.reason);
                results.push({ slug: run.slug, runNumber: run.runNumber, status: "failed", error: errorMsg });
            }
        }

        // Remove completed slugs from in-flight set
        for (const slug of completedSlugs) {
            this.inFlightSlugs.delete(slug);
        }

        return results;
    }

    /**
     * Reload config from the same source as the initial run.
     * Reinitializes LLM settings and workflow lists.
     * Does not affect output_viewing settings or in-flight workflows.
     */
    async reloadConfig(): Promise<void> {
        const resolved = await readConfig(this.resolvedConfigPath);
        this.config = resolved.config;
        this.resolvedConfigPath = resolved.path;
        // Rebuild the LlmClient so its provider cache resets to the new keys.
        this.llmClient = new LlmClient(this.config.llm);
        this.deps = {
            outputViewer: this.outputViewer,
            config: this.config,
            llmClient: this.llmClient,
        };
    }

    /** Clear output files. If slugs provided, only clear matching filenames. */
    clearResults(slugFilter?: string[]): void {
        this.outputViewer.clearFiles(slugFilter);
    }

    /**
     * Resolve the static filename prefix for each workflow matched by the slug filter.
     * Uses the literal portion of `output_filename` before the first `[` placeholder,
     * which is the stable, config-defined part of the filename regardless of runtime
     * values ([seed], [model], [run], etc.).
     * Pass the result to clearResults() to accurately target the right output files.
     */
    resolveOutputFilePatterns(slugs?: string[]): string[] {
        const onlySlugs = slugs && slugs.length > 0 ? slugs : undefined;
        const allWorkflows = [
            ...this.applyFilters(this.config.analysis_workflows, onlySlugs),
            ...this.applyFilters(this.config.testing_workflows, onlySlugs),
        ];
        return allWorkflows.map((w) => {
            const bracketIdx = w.output_filename.indexOf("[");
            return bracketIdx === -1 ? w.output_filename : w.output_filename.slice(0, bracketIdx);
        });
    }

    /** Return current engine state snapshot. */
    getStatus(): EngineStatus {
        return {
            inFlight: [...this.inFlightSlugs],
            completedFiles: this.outputViewer.getFileList().map((f) => f.name),
        };
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
                console.log(`Skipping workflow '${w.slug}' (not in --only_workflows list)`);
                return false;
            });
        }
        if (skipSlugs && skipSlugs.length > 0) {
            filtered = filtered.filter((w) => {
                if (skipSlugs.includes(w.slug)) {
                    console.log(`Skipping workflow '${w.slug}' (matched --skip_workflow)`);
                    return false;
                }
                return true;
            });
        }
        return filtered;
    }
}

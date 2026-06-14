import { OpenRouter } from "@openrouter/sdk";

import { OutputViewer } from "../util/output-viewer.ts";
import { executeAnalysisWorkflow } from "../workflow/analysis-workflow.ts";
import { executeTestingWorkflow } from "../workflow/testing-workflow.ts";
import type { WorkflowDependencies } from "../workflow/index.ts";
import type { Config } from "../util/config.ts";

export type WorkflowRunResult = {
    slug: string;
    runNumber: number;
    status: "succeeded" | "failed" | "rejected";
    error?: string;
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
    private readonly config: Config;
    private readonly deps: WorkflowDependencies;
    private readonly inFlightSlugs: Set<string> = new Set();

    constructor(config: Config) {
        this.config = config;
        this.outputViewer = new OutputViewer();
        this.deps = {
            seed: Math.floor(Date.now() / 1000),
            openRouter: new OpenRouter({
                apiKey: config.vendors.openrouter.api_key,
            }),
            outputViewer: this.outputViewer,
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

        const runs: { slug: string; runNumber: number; promise: Promise<void> }[] = [];
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
                results.push({ slug: run.slug, runNumber: run.runNumber, status: "succeeded" });
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

    /** Clear output files. If slugs provided, only clear matching filenames. */
    clearResults(slugFilter?: string[]): void {
        this.outputViewer.clearFiles(slugFilter);
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

#!/usr/bin/env bun

import "./version.ts";

import { OpenRouter } from "@openrouter/sdk";

import { ARGS } from "./util/args.ts";
import { CONFIG } from "./util/config.ts";
import { executeTestingWorkflow } from "./workflow/testing-workflow.ts";
import { executeAnalysisWorkflow } from "./workflow/analysis-workflow.ts";
import type { WorkflowDependencies } from "./workflow";
import { OutputViewer } from "./util/output-viewer.ts";


const workflowDependencies: WorkflowDependencies = {
    seed: Math.floor(Date.now() / 1000),
    openRouter: new OpenRouter({
        apiKey: CONFIG.vendors.openrouter.api_key,
    }),
    outputViewer: new OutputViewer(),
}

// Parallelize workflows with Promise.allSettled
const onlySlugs: string[] | undefined = ARGS.values.only_workflows;
const skipSlugs: string[] | undefined = ARGS.values.skip_workflow;

function applyWorkflowFilters<T extends { slug: string }>(workflows: T[]): T[] {
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

const analysisWorkflows = applyWorkflowFilters(CONFIG.analysis_workflows);
const testingWorkflows = applyWorkflowFilters(CONFIG.testing_workflows);
console.log(`Starting execution of ${analysisWorkflows.length} analysis + ${testingWorkflows.length} testing workflows...`);
console.log([...analysisWorkflows, ...testingWorkflows].map((w) => w.slug));
const workflowRuns: Promise<void>[] = [];
const workflowRunSlugs: string[] = [];
analysisWorkflows.forEach((workflow) => {
    for (let i = 0; i < workflow.runs; i++) {
        workflowRuns.push(executeAnalysisWorkflow(workflow, i + 1, workflowDependencies));
        workflowRunSlugs.push(workflow.slug);
    }
});
testingWorkflows.forEach((workflow) => {
    for (let i = 0; i < workflow.runs; i++) {
        workflowRuns.push(executeTestingWorkflow(workflow, i + 1, workflowDependencies));
        workflowRunSlugs.push(workflow.slug);
    }
});
workflowDependencies.outputViewer.display();  // Start the server early.
const workflowsResults = await Promise.allSettled(workflowRuns);
// Summarize with indices to include slugs in failure logs
const failedIndices: number[] = [];
const succeededIndices: number[] = [];
workflowsResults.forEach((r, i) => {
    if (r.status === "rejected") { failedIndices.push(i); }
    else { succeededIndices.push(i); }
});

console.log(`Workflows completed. Succeeded: ${succeededIndices.length}; Failed: ${failedIndices.length}`);
if (failedIndices.length > 0) {
    failedIndices.forEach((i) => {
        const r = workflowsResults[i] as PromiseRejectedResult;
        const slug = workflowRunSlugs[i] ?? `#${i + 1}`;
        console.warn(`Workflow '${slug}' failed:`, r.reason);
    });
}

workflowDependencies.outputViewer.display();

console.log(`index.ts done at ${new Date().toLocaleTimeString()}`);

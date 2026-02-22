#!/usr/bin/env bun

import "./version.ts";

import {OpenRouter} from "@openrouter/sdk";

import {CONFIG} from "./util/config.ts";
import {executeTestingWorkflow} from "./workflow/testing-workflow.ts";
import {executeAnalysisWorkflow} from "./workflow/analysis-workflow.ts";
import type {WorkflowDependencies} from "./workflow";
import {OutputViewer} from "./util/output-viewer.ts";


const workflowDependencies: WorkflowDependencies = {
    seed: Math.floor(Date.now() / 1000),
    openRouter: new OpenRouter({
        apiKey: CONFIG.vendors.openrouter.api_key,
    }),
    outputViewer: new OutputViewer(),
}

// Parallelize workflows with Promise.allSettled
const analysisWorkflows = CONFIG.analysis_workflows;
const testingWorkflows = CONFIG.testing_workflows;
console.log(`Starting execution of ${analysisWorkflows.length} workflows...`);
console.log(analysisWorkflows.map((w) => w.slug));
let workflowRuns: Promise<void>[] = [];
analysisWorkflows.forEach((workflow) => {
    for (let i = 0; i < workflow.runs; i++) {
        workflowRuns.push(executeAnalysisWorkflow(workflow, i+1, workflowDependencies));
    }
});
testingWorkflows.forEach((workflow) => {
    for (let i = 0; i < workflow.runs; i++) {
        workflowRuns.push(executeTestingWorkflow(workflow, i+1, workflowDependencies));
    }
});

const workflowsResults = await Promise.allSettled(workflowRuns);
// Summarize with indices to include slugs in failure logs
const failedIndices: number[] = [];
const succeededIndices: number[] = [];
workflowsResults.forEach((r, i) => {
    if (r.status === "rejected") failedIndices.push(i);
    else succeededIndices.push(i);
});

console.log(`Workflows completed. Succeeded: ${succeededIndices.length}; Failed: ${failedIndices.length}`);
if (failedIndices.length > 0) {
    failedIndices.forEach((i) => {
        const r = workflowsResults[i] as PromiseRejectedResult;
        const slug = analysisWorkflows[i]?.slug ?? `#${i + 1}`;
        console.warn(`Workflow '${slug}' failed:`, r.reason);
    });
}

workflowDependencies.outputViewer.display();

console.log("index.ts done");

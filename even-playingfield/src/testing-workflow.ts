import {$} from "bun";

import {CONFIG} from "./util/config.ts";

export async function executeTestingWorkflow(workflow: typeof CONFIG.testing_workflows[number], runNum: number) {
    console.log(`Executing testing workflow: ${workflow.slug}`);
    const log = (...args: Parameters<typeof console.log>) => {
        console.log(`[${workflow.slug}]`, ...args);
    }
    const warn = (...args: Parameters<typeof console.warn>) => {
        console.warn(`[${workflow.slug}]`, ...args);
    }

    for (const command of workflow.setup_commands){
        log(`Running setup command: ${command}`);
        await $`${{raw: command}}`.nothrow();
    }

    // for (let i = 0; i < workflow.test_cases.length; i++) {
    //     const testCase = workflow.test_cases[i]!;
    //     log(`Running test case ${i + 1}/${workflow.test_cases.length}: ${testCase.name}`);
    // }

    log(`Finished testing workflow: ${workflow.slug}`);
}
import {$} from "bun";

import {CONFIG} from "../util/config.ts";

export async function executeTestingWorkflow(workflow: typeof CONFIG.testing_workflows[number], runNum: number) {
    console.log(`Executing testing workflow: ${workflow.slug}`);
    const log = (...args: Parameters<typeof console.log>) => {
        console.log(`[${workflow.slug}]`, ...args);
    }
    const warn = (...args: Parameters<typeof console.warn>) => {
        console.warn(`[${workflow.slug}]`, ...args);
    }

    log(`$PATH: ${process.env.PATH}`);
    
    for (const command of workflow.setup_commands){
        log(`Running setup command: ${command}`);
        await $`${{raw: command}}`.nothrow();
    }

    for (let i = 0; i < workflow.test_cases.length; i++) {
        const testCase = workflow.test_cases[i]!;
        log(`Running test case ${i + 1}/${workflow.test_cases.length}: ${testCase.name}`);
        
        if (testCase.interactive_steps.length > 0) {
            warn("Interactive steps are not supported in this version. Skipping interactive steps.");
            continue;
        }
        
        let {stdout, stderr, exitCode} = await $`${{raw: testCase.single_run_command}}`.cwd(testCase.work_directory).nothrow();
        console.log();  // Blank line for readability
        log(`Test case stdout (${stdout.length}):\n${stdout}`);
        log(`Test case stderr (${stderr.length}):\n${stderr}`);
        log(`Exit code: ${exitCode}`);
    }

    log(`Finished testing workflow: ${workflow.slug}`);
}

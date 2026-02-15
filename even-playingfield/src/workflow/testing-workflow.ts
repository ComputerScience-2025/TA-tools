import {$} from "bun";

import {CONFIG} from "../util/config.ts";
import chalk from "chalk";
import {LLMJudgeInputModeEnum} from "../util/config-schema.ts";
import type {WorkflowDependencies} from "./index.ts";
import {generateCompletion} from "../util/llm.ts";

export async function executeTestingWorkflow(workflow: typeof CONFIG.testing_workflows[number], runNum: number, deps: WorkflowDependencies) {
    console.log(`Executing testing workflow: ${workflow.slug}`);
    const log = (...args: Parameters<typeof console.log>) => {
        console.log(chalk.cyan(`[${workflow.slug}]`), ...args);
    }
    const warn = (...args: Parameters<typeof console.warn>) => {
        console.warn(chalk.red(`[${workflow.slug}]`), ...args);
    }
    const debug = (...args: Parameters<typeof console.debug>) => {
        console.debug(chalk.gray(`[${workflow.slug}]`), ...args.map(e => typeof e === "string" ? chalk.gray(e) : e));
    }

    log(`$PATH: ${process.env.PATH}`);
    
    for (const command of workflow.setup_commands){
        log(`Running setup command: ${command}`);
        await $`${{raw: command}}`.nothrow();
    }

    let testCasesResults: boolean[] = new Array(workflow.test_cases.length);
    let testCasesResultsExplanation: string[] = new Array(workflow.test_cases.length);
    for (let i = 0; i < workflow.test_cases.length; i++) {
        try {
            const testCase = workflow.test_cases[i]!;
            log(`Running test case ${i + 1}/${workflow.test_cases.length}: ${testCase.name}`);
            
            if (testCase.interactive_steps.length > 0) {
                warn("Interactive steps are not supported in this version. Skipping interactive steps.");
                continue;
            }
            
            let {stdout, stderr, exitCode} = await $`${{raw: testCase.single_run_command}}`.cwd(testCase.work_directory).nothrow().quiet();
            console.log();  // Blank line for readability
            debug(`Test case stdout (${stdout.length}):\n${stdout}`);
            debug(`Test case stderr (${stderr.length}):\n${stderr}`);
            debug(`Exit code: ${exitCode}`);
            
            let commandOutput = stdout.toString();
            if (testCase.single_run_expected_output.prefix_strip_string.length > 0) {
                let prefixIndex = commandOutput.indexOf(testCase.single_run_expected_output.prefix_strip_string);
                if (prefixIndex !== -1) {
                    commandOutput = commandOutput.substring(prefixIndex + testCase.single_run_expected_output.prefix_strip_string.length);
                }
            }
            if (testCase.single_run_expected_output.postfix_strip_string.length > 0) {
                let postfixIndex = commandOutput.lastIndexOf(testCase.single_run_expected_output.postfix_strip_string);
                if (postfixIndex !== -1) {
                    commandOutput = commandOutput.substring(0, postfixIndex);
                }
            }
            debug("Sanitized command output for evaluation:\n", commandOutput);
            
            if (testCase.single_run_expected_output.llm_judge_input_mode == LLMJudgeInputModeEnum.None){
                if (stdout.includes(testCase.single_run_expected_output.substring)) {
                    log(`Test case '${testCase.name}' passed: expected substring found in output.`);
                    testCasesResults[i] = true;
                }
                else {
                    warn(`Test case '${testCase.name}' failed: expected substring NOT found in output.`);
                    testCasesResults[i] = false;
                }
            }
            else {
                switch (testCase.single_run_expected_output.llm_judge_input_mode) {
                    case LLMJudgeInputModeEnum.Full:
                        log("Evaluating full output with LLM judge...");
                        const completion = await generateCompletion(deps, log, warn, workflow.model, testCase.single_run_expected_output.llm_judge_prompt, JSON.stringify({
                            "expected_output_substring": testCase.single_run_expected_output.substring,
                            "actual_output": commandOutput,
                        }));
                        const completionText = completion.text;
                        log(`LLM judge completion:\n${completionText}`);
                        const llmJudgeResult = completionText.toLowerCase().includes("pass");  // TODO: More robust parsing
                        if (llmJudgeResult) {
                            log(chalk.green(`Test case '${testCase.name}' passed according to LLM judge.`));
                            testCasesResults[i] = true;
                        }
                        else {
                            warn(chalk.yellowBright(`Test case '${testCase.name}' failed according to LLM judge.`));
                            testCasesResults[i] = false;
                        }
                        
                        try {
                            const judgeResultObject = JSON.parse(completionText);
                            
                            if ("summary" in judgeResultObject) {
                                testCasesResultsExplanation[i] = judgeResultObject.summary;
                            }
                        } catch (e) {
                            warn("Failed to parse LLM judge output as JSON. Make sure the LLM prompt requests JSON output.");
                        }
                        break;
                    default:
                        warn(`LLM judge input mode '${testCase.single_run_expected_output.llm_judge_input_mode}' is not supported in this version. Skipping LLM judging.`);
                        break;
                }
            }
        } catch (e) {
            warn(`Error occurred while executing test case ${i + 1}:`, e);
            testCasesResults[i] = false;
        }
    }
    for (const command of workflow.cleanup_commands){
        log(`Running cleanup command: ${command}`);
        await $`${{raw: command}}`.nothrow();
    }
    
    const passedCount = testCasesResults.filter((r) => r).length;
    log(`Testing workflow completed. Passed ${passedCount}/${workflow.test_cases.length} test cases.`);
    console.table(testCasesResults.map((entry, idx) => {
        return [
            workflow.test_cases[idx]?.name,
            entry ? chalk.green("PASS") : chalk.red("FAIL"),
            testCasesResultsExplanation[idx] || "",
        ];
    }));

    log(`Finished testing workflow: ${workflow.slug}`);
}

import {$} from "bun";

import {CONFIG} from "../util/config.ts";
import chalk from "chalk";
import {LLMJudgeInputModeEnum} from "../util/config-schema.ts";
import type {WorkflowDependencies} from "./index.ts";

export async function executeTestingWorkflow(workflow: typeof CONFIG.testing_workflows[number], runNum: number, deps: WorkflowDependencies) {
    console.log(`Executing testing workflow: ${workflow.slug}`);
    const log = (...args: Parameters<typeof console.log>) => {
        console.log(chalk.cyan(`[${workflow.slug}]`), ...args);
    }
    const warn = (...args: Parameters<typeof console.warn>) => {
        console.warn(chalk.red(`[${workflow.slug}]`), ...args);
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
        
        let {stdout, stderr, exitCode} = await $`${{raw: testCase.single_run_command}}`.cwd(testCase.work_directory).nothrow().quiet();
        console.log();  // Blank line for readability
        log(`Test case stdout (${stdout.length}):\n${stdout}`);
        log(`Test case stderr (${stderr.length}):\n${stderr}`);
        log(`Exit code: ${exitCode}`);
        
        if (testCase.single_run_expected_output.llm_judge_input_mode == LLMJudgeInputModeEnum.None){
            if (stdout.includes(testCase.single_run_expected_output.substring)) {
                log(`Test case '${testCase.name}' passed: expected substring found in output.`);
            }
            else {
                warn(`Test case '${testCase.name}' failed: expected substring NOT found in output.`);
            }
        }
        else {
            switch (testCase.single_run_expected_output.llm_judge_input_mode) {
                case LLMJudgeInputModeEnum.Full:
                    log("Evaluating full output with LLM judge...");
                    const seed = Math.floor(Date.now() / 1000);
                    let completion = await deps.openRouter.chat.send({
                        model: CONFIG.openrouter.model,
                        maxCompletionTokens: CONFIG.hyperparameters.max_completion_tokens,
                        messages: [
                            {
                                role: "system",
                                content: testCase.single_run_expected_output.llm_judge_prompt,
                            },
                            {
                                role: "user",
                                content: JSON.stringify({
                                    "expected_output_substring": testCase.single_run_expected_output.substring,
                                    "actual_output": stdout.toString(),
                                }),
                            }
                        ],
                        stream: false,
                        seed: seed,
                        frequencyPenalty: CONFIG.hyperparameters.frequency_penalty,
                        presencePenalty: CONFIG.hyperparameters.presence_penalty,
                        temperature: 0,
                        reasoning: {
                            effort: CONFIG.hyperparameters.reasoning_effort,
                        },
                    });
                    if (completion.choices.length < 1){
                        warn("No choices returned from completion");
                        console.log(completion);
                    }
                    const completionText = completion.choices[0]?.message.content?.toString() ?? "";
                    log(`LLM judge completion:\n${completionText}`);
                    const llmJudgeResult = completionText.toLowerCase().includes("pass");  // TODO: More robust parsing
                    if (llmJudgeResult) {
                        log(chalk.green(`Test case '${testCase.name}' passed according to LLM judge.`));
                    }
                    else {
                        warn(chalk.yellowBright(`Test case '${testCase.name}' failed according to LLM judge.`));
                    }
                    break;
                default:
                    warn(`LLM judge input mode '${testCase.single_run_expected_output.llm_judge_input_mode}' is not supported in this version. Skipping LLM judging.`);
                    break;
                    continue;
            }
        }
    }

    log(`Finished testing workflow: ${workflow.slug}`);
}

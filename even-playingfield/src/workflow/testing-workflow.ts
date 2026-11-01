import { LLMJudgeInputModeEnum } from "../util/config-schema.ts";
import type { TestingWorkflow } from "../util/config-schema.ts";
import type { WorkflowDependencies } from "./index.ts";
import type { CompletionMetrics } from "../util/llm.ts";

export type TestingWorkflowResult = {
    slug: string;
    runNumber: number;
    status: "succeeded" | "failed";
    error?: string;
    latencyMs: number;
    completions: CompletionMetrics[];
    testCases: { name: string; passed: boolean; explanation?: string }[];
};

/**
 * Message shown when a testing workflow is attempted on a platform without a
 * shell (the browser). Analysis workflows are unaffected.
 */
export const SHELL_REQUIRED_MESSAGE =
    "Testing workflows run shell commands, which this platform does not provide. Run them with the CLI (even-pf).";

/** Minimal fixed-width table for the per-test-case summary. */
function formatTable(rows: string[][]): string {
    if (rows.length === 0) {
        return "";
    }
    const widths = rows[0]!.map((_, columnIndex) =>
        Math.max(...rows.map((row) => (row[columnIndex] ?? "").length)));
    return rows
        .map((row) => row.map((cell, index) => cell.padEnd(widths[index] ?? 0)).join("  ").trimEnd())
        .join("\n");
}

export async function executeTestingWorkflow(workflow: TestingWorkflow, runNum: number, deps: WorkflowDependencies): Promise<TestingWorkflowResult> {
    const startTime = Date.now();
    const resultBase: Omit<TestingWorkflowResult, "status" | "error" | "latencyMs" | "testCases"> = {
        slug: workflow.slug,
        runNumber: runNum,
        completions: [],
    };
    const completions: CompletionMetrics[] = [];
    const testCases: { name: string; passed: boolean; explanation?: string }[] = [];

    deps.logger.log("info", `Executing testing workflow: ${workflow.slug}`);
    const log = (message: string, ...data: unknown[]) => {
        deps.logger.log("info", message, { slug: workflow.slug, data });
    };
    const warn = (message: string, ...data: unknown[]) => {
        deps.logger.log("warn", message, { slug: workflow.slug, data });
    };
    const debug = (message: string, ...data: unknown[]) => {
        deps.logger.log("debug", message, { slug: workflow.slug, data });
    };

    if (!deps.shell.available) {
        warn(SHELL_REQUIRED_MESSAGE);
        return {
            ...resultBase,
            status: "failed",
            error: SHELL_REQUIRED_MESSAGE,
            latencyMs: Date.now() - startTime,
            testCases: [],
        };
    }

    debug(`$PATH: ${deps.env.get("PATH") ?? ""}`);

    for (const command of workflow.setup_commands){
        log(`Running setup command: ${command}`);
        await deps.shell.run(command, { cwd: deps.fs.root });
    }

    let testCasesResults: boolean[] = new Array(workflow.test_cases.length);
    let testCasesResultsExplanation: string[] = new Array(workflow.test_cases.length);
    for (let i = 0; i < workflow.test_cases.length; i++) {
        try {
            const testCase = workflow.test_cases[i]!;
            log(`Running test case ${i + 1}/${workflow.test_cases.length}: ${testCase.name}`);

            if (testCase.interactive_steps.length > 0) {
                warn("Interactive steps are not supported in this version. Skipping interactive steps.");
                testCasesResults[i] = false;
                continue;
            }

            let {stdout, stderr, exitCode} = await deps.shell.run(testCase.single_run_command, { cwd: testCase.work_directory });
            log("");  // Blank line for readability
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
                        const completion = await deps.llmClient.generateCompletion(log, warn, workflow.model, testCase.single_run_expected_output.llm_judge_prompt, JSON.stringify({
                            "expected_output_substring": testCase.single_run_expected_output.substring,
                            "actual_output": commandOutput,
                        }));
                        completions.push(completion.metrics);
                        const completionText = completion.text;
                        log(`LLM judge completion:\n${completionText}`);
                        const llmJudgeResult = completionText.toLowerCase().includes("pass");  // TODO: More robust parsing
                        if (llmJudgeResult) {
                            log(`Test case '${testCase.name}' passed according to LLM judge.`);
                            testCasesResults[i] = true;
                        }
                        else {
                            warn(`Test case '${testCase.name}' failed according to LLM judge.`);
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
                        testCasesResults[i] = false;
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
        await deps.shell.run(command, { cwd: deps.fs.root });
    }

    for (let i = 0; i < workflow.test_cases.length; i++) {
        const testCase = workflow.test_cases[i]!;
        testCases.push({
            name: testCase.name,
            passed: testCasesResults[i] ?? false,
            explanation: testCasesResultsExplanation[i],
        });
    }

    const passedCount = testCasesResults.filter((r) => r).length;
    log(`Testing workflow completed. Passed ${passedCount}/${workflow.test_cases.length} test cases.`);
    log(`\n${formatTable(testCases.map((entry) => [
        entry.name,
        entry.passed ? "PASS" : "FAIL",
        entry.explanation || "",
    ]))}`);

    log(`Finished testing workflow: ${workflow.slug}`);

    const allPassed = testCases.every((tc) => tc.passed);
    return {
        ...resultBase,
        status: allPassed ? "succeeded" : "failed",
        latencyMs: Date.now() - startTime,
        completions,
        testCases,
    };
}

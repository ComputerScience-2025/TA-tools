import {stringify} from "smol-toml";
import {getDefaultsForSchema} from "zod-defaults";

import {
    ConfigSchema,
    AnalysisWorkflowEntrySchema,
    FileSearchEntrySchema,
    TestingWorkflowEntrySchema, TestCaseSchema, LLMConfigSchema, ModelConfigSchema
} from "./util/config-schema.ts";


console.log("generate-config.ts");

let defaultConfig = getDefaultsForSchema(ConfigSchema);

let defaultLLMConfig = getDefaultsForSchema(LLMConfigSchema);
defaultLLMConfig.prompt_replacement["role"] = "role_placeholder";
let defaultModelConfig = getDefaultsForSchema(ModelConfigSchema);
defaultLLMConfig.models["general_analysis"] = defaultModelConfig;
defaultLLMConfig.models["output_comparison"] = structuredClone(defaultModelConfig);
defaultLLMConfig.models["output_comparison"].temperature = 0;
defaultConfig.llm = defaultLLMConfig;

let defaultAnalysisWorkflowEntry = getDefaultsForSchema(AnalysisWorkflowEntrySchema);
let defaultFileSearchEntry = getDefaultsForSchema(FileSearchEntrySchema);
defaultAnalysisWorkflowEntry.input_files_searches = [defaultFileSearchEntry];
defaultConfig.analysis_workflows = [defaultAnalysisWorkflowEntry];

let defaultTestingWorkflowEntry = getDefaultsForSchema(TestingWorkflowEntrySchema);
defaultTestingWorkflowEntry.test_cases = [getDefaultsForSchema(TestCaseSchema)];
defaultConfig.testing_workflows = [defaultTestingWorkflowEntry];

console.log(defaultConfig);

const tomlString = stringify(defaultConfig);
const outputFilename = "epf.example.toml";
await Bun.file(outputFilename).write(tomlString);
console.log(`Default config written to ${outputFilename}`);

console.log("generate-config.ts done");

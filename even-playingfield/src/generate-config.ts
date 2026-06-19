import {stringify} from "smol-toml";
import {getDefaultsForSchema} from "zod-defaults";

import {
    ConfigSchema,
    AnalysisWorkflowEntrySchema,
    FileSearchEntrySchema,
    TestingWorkflowEntrySchema,
    TestCaseSchema,
    LLMConfigSchema,
    ModelConfigSchema,
    ProviderConfigSchema,
    ProviderSDKEnum,
} from "./util/config-schema.ts";


console.log("generate-config.ts");

let defaultConfig = getDefaultsForSchema(ConfigSchema);

let defaultLLMConfig = getDefaultsForSchema(LLMConfigSchema);
defaultLLMConfig.prompt_replacement["role"] = "role_placeholder";

let defaultProviderConfig = getDefaultsForSchema(ProviderConfigSchema);
defaultLLMConfig.providers["openrouter"] = structuredClone(defaultProviderConfig);
defaultLLMConfig.providers["openrouter"].sdk = ProviderSDKEnum.OpenAI;
defaultLLMConfig.providers["openrouter"].endpoint = "https://openrouter.ai/api/v1";
defaultLLMConfig.providers["openai"] = structuredClone(defaultProviderConfig);
defaultLLMConfig.providers["openai"].sdk = ProviderSDKEnum.OpenAI;
defaultLLMConfig.providers["anthropic"] = structuredClone(defaultProviderConfig);
defaultLLMConfig.providers["anthropic"].sdk = ProviderSDKEnum.Anthropic;
defaultLLMConfig.providers["google"] = structuredClone(defaultProviderConfig);
defaultLLMConfig.providers["google"].sdk = ProviderSDKEnum.Google;

let defaultModelConfig = getDefaultsForSchema(ModelConfigSchema);
defaultLLMConfig.models["general_analysis"] = defaultModelConfig;
defaultLLMConfig.models["general_analysis"].provider = "openrouter";
defaultLLMConfig.models["output_comparison"] = structuredClone(defaultModelConfig);
defaultLLMConfig.models["output_comparison"].provider = "openrouter";
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

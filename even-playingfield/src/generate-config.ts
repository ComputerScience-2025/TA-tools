import {stringify} from "smol-toml";
import {getDefaultsForSchema} from "zod-defaults";

import {ConfigSchema, ConfigWorkflowEntrySchema} from "./util/config-schema.ts";


console.log("generate-config.ts");

const defaultConfig = getDefaultsForSchema(ConfigSchema);
const defaultBasicWorkflowEntry = getDefaultsForSchema(ConfigWorkflowEntrySchema);
defaultConfig.basic_workflows = [defaultBasicWorkflowEntry];

const tomlString = stringify(defaultConfig);
const outputFilename = "epf.example.toml";
await Bun.file(outputFilename).write(tomlString);
console.log(`Default config written to ${outputFilename}`);

console.log("generate-config.ts done");

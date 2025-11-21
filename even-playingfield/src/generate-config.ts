import {stringify} from "smol-toml";
import {getDefaultsForSchema} from "zod-defaults";

import {ConfigSchema, ConfigWorkflowEntrySchema, FileSearchEntrySchema} from "./util/config-schema.ts";


console.log("generate-config.ts");

let defaultConfig = getDefaultsForSchema(ConfigSchema);
let defaultBasicWorkflowEntry = getDefaultsForSchema(ConfigWorkflowEntrySchema);
let defaultFileSearchEntry = getDefaultsForSchema(FileSearchEntrySchema);
defaultBasicWorkflowEntry.input_files_searches = [defaultFileSearchEntry];
defaultConfig.basic_workflows = [defaultBasicWorkflowEntry];

console.log(defaultConfig);

const tomlString = stringify(defaultConfig);
const outputFilename = "epf.example.toml";
await Bun.file(outputFilename).write(tomlString);
console.log(`Default config written to ${outputFilename}`);

console.log("generate-config.ts done");

import { createDefaultConfigDocument } from "./util/config-defaults.ts";
import { stringifyToml } from "./util/toml-stringify.ts";

console.log("generate-config.ts");

const defaultConfig = createDefaultConfigDocument();
console.log(defaultConfig);

const tomlString = stringifyToml(defaultConfig);
const outputFilename = "epf.example.toml";
await Bun.file(outputFilename).write(tomlString);
console.log(`Default config written to ${outputFilename}`);

console.log("generate-config.ts done");

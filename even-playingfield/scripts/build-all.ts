#!/usr/bin/env bun
// scripts/build-all.ts
// Cross-compile even-pf for all supported platforms using Bun.build().
// Usage: bun scripts/build-all.ts

import { join, dirname } from "path";
import { mkdirSync, chmodSync } from "fs";

type BunCompileTarget = Bun.Build.CompileTarget;

const root = join(import.meta.dir, "..");
const entrypoint = join(root, "src", "hosts", "cli-host.ts");

const { version } = JSON.parse(await Bun.file(join(root, "package.json")).text()) as { version: string };

console.log(`\x1b[33mStarting build for even-pf v${version}...\x1b[0m\n`);

const targets: { target: BunCompileTarget; outfile: string }[] = [
  { target: "bun-linux-x64",    outfile: join(root, "npm", "even-pf-linux-x64",    "bin", "even-pf")     },
  { target: "bun-linux-arm64",  outfile: join(root, "npm", "even-pf-linux-arm64",  "bin", "even-pf")     },
  { target: "bun-windows-x64",  outfile: join(root, "npm", "even-pf-windows-x64",  "bin", "even-pf.exe") },
  { target: "bun-darwin-x64",   outfile: join(root, "npm", "even-pf-darwin-x64",   "bin", "even-pf")     },
  { target: "bun-darwin-arm64", outfile: join(root, "npm", "even-pf-darwin-arm64", "bin", "even-pf")     },
];

for (const { target, outfile } of targets) {
  console.log(`\x1b[36mBuilding for ${target} -> ${outfile}\x1b[0m`);

  mkdirSync(dirname(outfile), { recursive: true });

  const result = await Bun.build({
    entrypoints: [entrypoint],
    compile: { target, outfile },
    define: { EPF_VERSION: JSON.stringify(version) },
  });

  if (!result.success) {
    console.error(`\x1b[31mBuild failed for target ${target}:\x1b[0m`);
    for (const log of result.logs) console.error(log);
    process.exit(1);
  }

  // Ensure the binary is executable on Unix targets (git and npm both preserve this bit)
  if (!target.includes("windows")) {
    chmodSync(outfile, 0o755);
  }
}

console.log("\x1b[32m\nAll binaries built successfully.\x1b[0m");

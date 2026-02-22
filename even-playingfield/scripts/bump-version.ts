#!/usr/bin/env bun
// scripts/bump-version.ts
// Usage: bun scripts/bump-version.ts <new-version>
// Updates the version field in root package.json and all platform sub-packages.

import { join } from "path";

const root = join(import.meta.dir, "..");

const newVersion = process.argv[2];
if (!newVersion || !/^\d+\.\d+\.\d+/.test(newVersion)) {
  console.error("Usage: bun scripts/bump-version.ts <semver>");
  process.exit(1);
}

const pkgPaths = [
  join(root, "package.json"),
  join(root, "npm", "even-pf-linux-x64",   "package.json"),
  join(root, "npm", "even-pf-linux-arm64",  "package.json"),
  join(root, "npm", "even-pf-windows-x64",  "package.json"),
  join(root, "npm", "even-pf-darwin-x64",   "package.json"),
  join(root, "npm", "even-pf-darwin-arm64", "package.json"),
];

for (const pkgPath of pkgPaths) {
  const json = JSON.parse(await Bun.file(pkgPath).text()) as Record<string, unknown>;
  json["version"] = newVersion;

  // Also update the version pinned in optionalDependencies of the root package
  if (json["optionalDependencies"] && typeof json["optionalDependencies"] === "object") {
    const optDeps = json["optionalDependencies"] as Record<string, string>;
    for (const dep of Object.keys(optDeps)) {
      optDeps[dep] = newVersion;
    }
  }

  await Bun.write(pkgPath, JSON.stringify(json, null, 2) + "\n");
  console.log(`Updated ${pkgPath}`);
}

console.log(`\nVersion bumped to ${newVersion}.`);


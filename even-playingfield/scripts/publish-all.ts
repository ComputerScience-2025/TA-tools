#!/usr/bin/env bun
// scripts/publish-all.ts
// Publishes each platform sub-package and then the root package to npm.
// Usage:
//   bun scripts/publish-all.ts           (live publish)
//   bun scripts/publish-all.ts --dry-run (dry run)

import { spawnSync } from "bun";
import { join as pathJoin } from "path";

const dryRun = process.argv.includes("--dry-run");

const root = pathJoin(import.meta.dir, "..");

const subPackages = [
  "even-pf-linux-x64",
  "even-pf-linux-arm64",
  "even-pf-windows-x64",
  "even-pf-darwin-x64",
  "even-pf-darwin-arm64",
];

function npmPublish(cwd: string, label: string): void {
  const args = ["npm", "publish", "--access", "public"];
  if (dryRun) args.push("--dry-run");

  console.log(`\x1b[36mPublishing ${label}${dryRun ? " (dry run)" : ""}...\x1b[0m`);

  const result = spawnSync(args, { cwd, stdio: ["inherit", "inherit", "inherit"] });

  if (result.exitCode !== 0) {
    console.error(`\x1b[31mFailed to publish ${label}\x1b[0m`);
    process.exit(1);
  }
}

// Publish platform sub-packages first
for (const pkg of subPackages) {
  npmPublish(pathJoin(root, "npm", pkg), pkg);
}

// Publish the root package last
npmPublish(root, "even-pf (root)");

console.log(`\x1b[32m\nAll packages published successfully${dryRun ? " (dry run)" : ""}.\x1b[0m`);


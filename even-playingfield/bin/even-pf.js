#!/usr/bin/env bun
"use strict";

const { spawnSync } = require("child_process");
const path = require("path");

// Map process.platform + process.arch to the sub-package name and binary filename
const PLATFORM_MAP = {
  "linux-x64":   { pkg: "even-pf-linux-x64",   bin: "even-pf" },
  "linux-arm64": { pkg: "even-pf-linux-arm64",  bin: "even-pf" },
  "win32-x64":   { pkg: "even-pf-windows-x64",  bin: "even-pf.exe" },
  "darwin-x64":  { pkg: "even-pf-darwin-x64",   bin: "even-pf" },
  "darwin-arm64":{ pkg: "even-pf-darwin-arm64", bin: "even-pf" },
};

const key = `${process.platform}-${process.arch}`;
const entry = PLATFORM_MAP[key];

if (!entry) {
  console.error(
    `even-pf: Unsupported platform/architecture: ${key}\n` +
    `Supported: ${Object.keys(PLATFORM_MAP).join(", ")}`
  );
  process.exit(1);
}

let binaryPath;
try {
  // resolve the binary inside the optionally-installed platform sub-package
  binaryPath = require.resolve(`${entry.pkg}/bin/${entry.bin}`);
} catch {
  console.error(
    `even-pf: Could not find the platform binary package "${entry.pkg}".\n` +
    `Try reinstalling even-pf, or install the package manually:\n` +
    `  npm install ${entry.pkg}`
  );
  process.exit(1);
}

const result = spawnSync(binaryPath, process.argv.slice(2), { stdio: "inherit" });

if (result.error) {
  console.error(`even-pf: Failed to launch binary: ${result.error.message}`);
  process.exit(1);
}

process.exit(result.status ?? 0);

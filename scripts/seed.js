#!/usr/bin/env node

const { spawnSync } = require("node:child_process");
const { join } = require("node:path");

const result = spawnSync(
  process.execPath,
  ["--env-file=.env", join(__dirname, "..", "dist", "seed.js"), ...process.argv.slice(2)],
  { stdio: "inherit" },
);
if (result.error !== undefined) {
  console.error(`Unable to start seed process: ${result.error.message}`);
  process.exitCode = 1;
} else {
  process.exitCode = result.status ?? 1;
}

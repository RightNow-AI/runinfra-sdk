#!/usr/bin/env node
import { readFileSync } from "node:fs";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

const version = readJson("typescript/package.json").version;
const dryRun = process.env.INPUT_DRY_RUN ?? "true";
const confirmVersion = process.env.INPUT_CONFIRM_VERSION ?? "";
const ref = process.env.GITHUB_REF ?? "";

if (ref && ref !== "refs/heads/main") {
  console.error(`Publish workflow must run from refs/heads/main, got ${ref}`);
  process.exit(1);
}

if (dryRun === "true") {
  console.log(`Verified dry-run publish dispatch for ${version}`);
  process.exit(0);
}

if (dryRun !== "false") {
  console.error(`INPUT_DRY_RUN must be true or false, got ${dryRun}`);
  process.exit(1);
}

if (confirmVersion !== version) {
  console.error(
    `Real publish requires confirm_version=${version}; got ${confirmVersion || "<empty>"}`,
  );
  process.exit(1);
}

console.log(`Verified real publish dispatch for ${version}`);

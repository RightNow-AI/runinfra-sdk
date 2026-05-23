#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { evaluateWorkflowPolicy } from "./workflow-policy.mjs";

const checks = evaluateWorkflowPolicy({
  publish: readFileSync(".github/workflows/publish.yml", "utf8"),
  ci: readFileSync(".github/workflows/ci.yml", "utf8"),
  hasCustomCodeqlWorkflow: existsSync(".github/workflows/codeql.yml"),
});

const failed = checks.filter((check) => !check.ok);
for (const check of checks) {
  console.log(`${check.ok ? "[OK]" : "[FAIL]"} ${check.label}`);
}

if (failed.length) {
  process.exit(1);
}

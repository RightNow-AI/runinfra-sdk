#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";

const expectedFiles = new Set([
  "package/CHANGELOG.md",
  "package/LICENSE",
  "package/README.md",
  "package/dist/index.d.ts",
  "package/dist/index.js",
  "package/package.json",
]);

const forbiddenPatterns = [
  /\.map$/u,
  /\.env$/u,
  /\.test\.[cm]?[jt]sx?$/u,
  /^package\/src\//u,
  /^package\/node_modules\//u,
  /^package\/\.npmrc$/u,
];

function patternToRegex(pattern) {
  return new RegExp(
    `^${basename(pattern)
      .replace(/[.+?^${}()|[\]\\]/gu, "\\$&")
      .replace(/\*/gu, ".*")}$`,
    "u",
  );
}

function expandInputs(inputs) {
  const expanded = [];
  for (const input of inputs) {
    if (!input.includes("*")) {
      expanded.push(input);
      continue;
    }
    const dir = dirname(input);
    const regex = patternToRegex(input);
    for (const entry of readdirSync(dir === "." ? process.cwd() : dir)) {
      if (regex.test(entry)) {
        expanded.push(join(dir, entry));
      }
    }
  }
  return expanded;
}

function listTarball(tarball) {
  return execFileSync("tar", ["-tf", tarball], { encoding: "utf8" })
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort();
}

function verifyTarball(tarball) {
  const actualFiles = listTarball(tarball);
  const actualSet = new Set(actualFiles);
  const missing = [...expectedFiles].filter((file) => !actualSet.has(file));
  const unexpected = actualFiles.filter((file) => !expectedFiles.has(file));
  const forbidden = actualFiles.filter((file) =>
    forbiddenPatterns.some((pattern) => pattern.test(file)),
  );

  if (missing.length || unexpected.length || forbidden.length) {
    console.error(`Package content verification failed for ${tarball}`);
    if (missing.length) console.error(`Missing files:\n${missing.join("\n")}`);
    if (unexpected.length) console.error(`Unexpected files:\n${unexpected.join("\n")}`);
    if (forbidden.length) console.error(`Forbidden files:\n${forbidden.join("\n")}`);
    process.exitCode = 1;
    return;
  }

  console.log(`Verified npm package contents: ${tarball}`);
}

const inputs = expandInputs(process.argv.slice(2));
if (inputs.length === 0) {
  console.error("Usage: node scripts/verify-npm-package.mjs <package.tgz>");
  process.exit(2);
}

for (const input of inputs) {
  verifyTarball(input);
}

#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { findForbiddenContent } from "./secret-scan-policy.mjs";

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
  /^package\/\.github\//u,
  /^package\/\.npmrc$/u,
  /^package\/\.pypirc$/u,
  /^package\/\.netrc$/u,
  /^package\/pip\.(?:conf|ini)$/u,
  /^package\/AGENT-NOTES\.md$/u,
];

const expectedPackageMetadata = {
  name: "@runinfra/sdk",
  version: JSON.parse(
    readFileSync(new URL("../typescript/package.json", import.meta.url), "utf8"),
  ).version,
  type: "module",
  main: "./dist/index.js",
  module: "./dist/index.js",
  types: "./dist/index.d.ts",
  exports: {
    ".": {
      types: "./dist/index.d.ts",
      import: "./dist/index.js",
      default: "./dist/index.js",
    },
  },
};
const runtimeDependencyFields = [
  "dependencies",
  "optionalDependencies",
  "peerDependencies",
  "bundledDependencies",
  "bundleDependencies",
];
const forbiddenLifecycleScripts = [
  "preinstall",
  "install",
  "postinstall",
  "prepare",
  "prepublish",
  "prepublishOnly",
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

function tarOutputLines(tarball, args) {
  return execFileSync("tar", [...args, tarball], { encoding: "utf8" })
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

function listTarballEntries(tarball) {
  const files = tarOutputLines(tarball, ["-tf"]);
  const details = tarOutputLines(tarball, ["-tvf"]);
  return files.map((file, index) => ({
    file,
    type: details[index]?.charAt(0) ?? "",
  }));
}

function readTarballFile(tarball, file) {
  return execFileSync("tar", ["-xOf", tarball, file], {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
}

function duplicateFiles(files) {
  const seen = new Set();
  const duplicates = new Set();
  for (const file of files) {
    if (seen.has(file)) duplicates.add(file);
    seen.add(file);
  }
  return [...duplicates].sort();
}

function sameStringSet(actual, expected) {
  if (actual.length !== expected.length) return false;
  return actual.every((value, index) => value === expected[index]);
}

function hasEntries(value) {
  if (value === undefined) return false;
  if (Array.isArray(value)) return value.length > 0;
  if (value && typeof value === "object") return Object.keys(value).length > 0;
  return true;
}

function validatePackageMetadata(content) {
  let metadata;
  try {
    metadata = JSON.parse(content);
  } catch (error) {
    return [`package.json must be valid JSON: ${error.message}`];
  }

  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) {
    return ["package.json must be a JSON object"];
  }

  const errors = [];
  for (const [field, expected] of Object.entries(expectedPackageMetadata)) {
    if (field === "exports") continue;
    if (metadata[field] !== expected) {
      errors.push(`package.json ${field} must be ${expected}`);
    }
  }

  const packageExports = metadata.exports;
  if (!packageExports || typeof packageExports !== "object" || Array.isArray(packageExports)) {
    errors.push("package.json exports must be an object");
    return errors;
  }

  const expectedExportKeys = Object.keys(expectedPackageMetadata.exports).sort();
  const exportKeys = Object.keys(packageExports).sort();
  if (!sameStringSet(exportKeys, expectedExportKeys)) {
    errors.push('package.json exports must expose only "."');
  }

  const rootExport = packageExports["."];
  if (!rootExport || typeof rootExport !== "object" || Array.isArray(rootExport)) {
    errors.push('package.json exports["."] must be an object');
    return errors;
  }

  const expectedRootExport = expectedPackageMetadata.exports["."];
  const expectedRootExportKeys = Object.keys(expectedRootExport).sort();
  const rootExportKeys = Object.keys(rootExport).sort();
  if (!sameStringSet(rootExportKeys, expectedRootExportKeys)) {
    errors.push('package.json exports["."] must expose only default, import, types');
  }

  for (const [field, expected] of Object.entries(expectedRootExport)) {
    if (rootExport[field] !== expected) {
      errors.push(`package.json exports["."].${field} must be ${expected}`);
    }
  }

  for (const field of runtimeDependencyFields) {
    if (hasEntries(metadata[field])) {
      errors.push(`package.json ${field} must be absent or empty`);
    }
  }

  if (metadata.scripts !== undefined) {
    if (!metadata.scripts || typeof metadata.scripts !== "object" || Array.isArray(metadata.scripts)) {
      errors.push("package.json scripts must be an object when present");
    } else {
      for (const script of forbiddenLifecycleScripts) {
        if (script in metadata.scripts) {
          errors.push(`package.json scripts.${script} is not allowed in published artifacts`);
        }
      }
    }
  }
  return errors;
}

function verifyTarball(tarball) {
  const entries = listTarballEntries(tarball);
  const actualFiles = entries.map((entry) => entry.file).sort();
  const actualSet = new Set(actualFiles);
  const missing = [...expectedFiles].filter((file) => !actualSet.has(file));
  const duplicates = duplicateFiles(actualFiles);
  const nonRegular = entries
    .filter((entry) => entry.type !== "-")
    .map((entry) => entry.file)
    .sort();
  const unexpected = actualFiles.filter((file) => !expectedFiles.has(file));
  const forbidden = actualFiles.filter((file) =>
    forbiddenPatterns.some((pattern) => pattern.test(file)),
  );
  const forbiddenContent = [];
  const regularFiles = entries
    .filter((entry) => entry.type === "-")
    .map((entry) => entry.file)
    .sort();
  for (const file of regularFiles) {
    const content = readTarballFile(tarball, file);
    const matchedPattern = findForbiddenContent(content);
    if (matchedPattern) forbiddenContent.push(`${file}: ${matchedPattern.label}`);
  }
  const metadataErrors = actualSet.has("package/package.json")
    ? validatePackageMetadata(readTarballFile(tarball, "package/package.json"))
    : [];

  if (
    missing.length ||
    duplicates.length ||
    nonRegular.length ||
    unexpected.length ||
    forbidden.length ||
    forbiddenContent.length ||
    metadataErrors.length
  ) {
    console.error(`Package content verification failed for ${tarball}`);
    if (missing.length) console.error(`Missing files:\n${missing.join("\n")}`);
    if (duplicates.length) console.error(`Duplicate files:\n${duplicates.join("\n")}`);
    if (nonRegular.length) console.error(`Non-regular files:\n${nonRegular.join("\n")}`);
    if (unexpected.length) console.error(`Unexpected files:\n${unexpected.join("\n")}`);
    if (forbidden.length) console.error(`Forbidden files:\n${forbidden.join("\n")}`);
    if (forbiddenContent.length) {
      console.error(`Forbidden content:\n${forbiddenContent.join("\n")}`);
    }
    if (metadataErrors.length) {
      console.error(`Invalid package metadata:\n${metadataErrors.join("\n")}`);
    }
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

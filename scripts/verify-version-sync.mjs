#!/usr/bin/env node
import { readFileSync } from "node:fs";

function readJson(path) {
  return JSON.parse(readFileSync(path, "utf8"));
}

function readText(path) {
  return readFileSync(path, "utf8");
}

function matchRequired(path, pattern, label) {
  const match = readText(path).match(pattern);
  if (!match?.[1]) {
    throw new Error(`Could not read ${label} from ${path}`);
  }
  return match[1];
}

const values = {
  "typescript/package.json": readJson("typescript/package.json").version,
  "typescript/src/index.ts": matchRequired(
    "typescript/src/index.ts",
    /RUNINFRA_SDK_VERSION\s*=\s*"([^"]+)"/u,
    "RUNINFRA_SDK_VERSION",
  ),
  "python/pyproject.toml": matchRequired(
    "python/pyproject.toml",
    /^version\s*=\s*"([^"]+)"/mu,
    "Python project version",
  ),
  "python/runinfra/__init__.py": matchRequired(
    "python/runinfra/__init__.py",
    /__version__\s*=\s*"([^"]+)"/u,
    "Python __version__",
  ),
};

const unique = new Set(Object.values(values));
if (unique.size !== 1) {
  console.error("SDK versions are not synchronized:");
  for (const [path, version] of Object.entries(values)) {
    console.error(`${path}: ${version}`);
  }
  process.exit(1);
}

const version = [...unique][0];
const docs = {
  "README.md": readText("README.md"),
  "typescript/README.md": readText("typescript/README.md"),
  "python/README.md": readText("python/README.md"),
  "typescript/CHANGELOG.md": readText("typescript/CHANGELOG.md"),
  "python/CHANGELOG.md": readText("python/CHANGELOG.md"),
};

const missingDocs = Object.entries(docs)
  .filter(([, content]) => !content.includes(version))
  .map(([path]) => path);

if (missingDocs.length) {
  console.error(`Version ${version} is missing from release docs:`);
  for (const path of missingDocs) console.error(path);
  process.exit(1);
}

console.log(`Verified SDK version sync: ${version}`);

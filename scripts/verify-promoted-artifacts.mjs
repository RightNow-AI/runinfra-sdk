#!/usr/bin/env node
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

const root = process.argv[2] ?? "artifacts";

const expected = [
  {
    label: "npm tarball",
    pattern: /^npm-local\/runinfra-sdk-[^/]+\.tgz$/u,
  },
  {
    label: "Python wheel",
    pattern: /^python-local\/runinfra-[^/]+-py3-none-any\.whl$/u,
  },
  {
    label: "Python sdist",
    pattern: /^python-local\/runinfra-[^/]+\.tar\.gz$/u,
  },
];

function collectFiles(directory, prefix = "") {
  const entries = readdirSync(directory, { withFileTypes: true });
  const files = [];
  const errors = [];

  for (const entry of entries) {
    const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
    const absolutePath = join(directory, entry.name);
    if (entry.isDirectory()) {
      const child = collectFiles(absolutePath, relativePath);
      files.push(...child.files);
      errors.push(...child.errors);
    } else if (entry.isFile()) {
      files.push(relativePath.replace(/\\/gu, "/"));
    } else {
      errors.push(`unexpected non-regular promoted artifact entry: ${relativePath}`);
    }
  }

  return { files, errors };
}

const errors = [];

if (!existsSync(root)) {
  errors.push(`promoted artifact root does not exist: ${root}`);
} else {
  let rootStats;
  try {
    rootStats = statSync(root);
  } catch {
    errors.push(`unable to inspect promoted artifact root: ${root}`);
  }

  if (rootStats?.isDirectory() === false) {
    errors.push(`promoted artifact root is not a directory: ${root}`);
  }

  const { files, errors: walkErrors } = rootStats?.isDirectory()
    ? collectFiles(root)
    : { files: [], errors: [] };
  errors.push(...walkErrors);

  for (const file of files) {
    if (!expected.some(({ pattern }) => pattern.test(file))) {
      errors.push(`unexpected promoted artifact file: ${file}`);
    }
  }

  for (const { label, pattern } of expected) {
    const matches = files.filter((file) => pattern.test(file));
    if (matches.length !== 1) {
      errors.push(`expected exactly one ${label}, found ${matches.length}`);
    }
  }
}

if (errors.length) {
  console.error("Invalid promoted artifact download layout:");
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Verified promoted artifact layout in ${root}`);

#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const reportPath = optionValue("--report");
const packageSource = optionValue("--package-source") ?? "artifact";
const tempDir = resolve(".canary-tmp", `${Date.now()}-${process.pid}`);
const tsReport = resolve(tempDir, "typescript.json");
const pyReport = resolve(tempDir, "python.json");
const expectedRows = [
  "models.list",
  "models.retrieve.llm",
  "chat.completions.create",
  "openai.params.chat.completions",
  "chat.completions.stream.final",
  "chat.completions.stream.cancel",
  "responses.create",
  "openai.params.responses",
  "responses.stream.final",
  "responses.stream.cancel",
  "embeddings.create",
  "openai.params.embeddings",
  "images.generate",
  "audio.speech.create",
  "audio.transcriptions.create",
  "voice.pipeline.create",
  "error.auth.invalid_key",
  "error.request.invalid_options",
  "error.body.unsupported_parameter",
  "webhooks.create.unsupported",
  "webhooks.list.unsupported",
  "webhooks.verify_signature.local",
  "webhooks.construct_event.local",
  "idempotency.replay.responses",
];

function optionValue(name) {
  const exact = args.find((arg) => arg.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

if (!["artifact", "source"].includes(packageSource)) {
  console.error(`Unsupported package source "${packageSource}". Use --package-source artifact or --package-source source.`);
  process.exit(2);
}

function newestMatching(dir, pattern, label) {
  const absoluteDir = resolve(dir);
  if (!existsSync(absoluteDir)) {
    throw new Error(`${label} directory does not exist. Build package artifacts first.`);
  }
  const matches = readdirSync(absoluteDir)
    .filter((entry) => pattern.test(entry))
    .map((entry) => {
      const path = join(absoluteDir, entry);
      return { path, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (!matches.length) throw new Error(`${label} artifact not found. Build package artifacts first.`);
  return matches[0].path;
}

function npmCommand() {
  const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(npmCli)) return { command: process.execPath, prefixArgs: [npmCli] };
  return { command: process.platform === "win32" ? "npm.cmd" : "npm", prefixArgs: [] };
}

function pythonExecutable(venvDir) {
  return process.platform === "win32"
    ? join(venvDir, "Scripts", "python.exe")
    : join(venvDir, "bin", "python");
}

function runChecked(command, commandArgs, options = {}) {
  const result = spawnSync(command, commandArgs, {
    cwd: options.cwd,
    stdio: "inherit",
    env: options.env ?? process.env,
    shell: false,
  });
  if (result.error || result.status !== 0) {
    throw new Error("setup command failed");
  }
}

function installArtifactCanaryPackages() {
  const npmDir = resolve(tempDir, "npm-consumer");
  const pythonDir = resolve(tempDir, "python-consumer");
  const venvDir = resolve(pythonDir, "venv");
  mkdirSync(npmDir, { recursive: true });
  mkdirSync(pythonDir, { recursive: true });
  writeFileSync(
    join(npmDir, "package.json"),
    `${JSON.stringify({ private: true, type: "module", dependencies: {} }, null, 2)}\n`,
  );

  const npm = npmCommand();
  runChecked(npm.command, [
    ...npm.prefixArgs,
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    resolve(newestMatching("typescript", /^runinfra-sdk-.+\.tgz$/u, "npm")),
  ], {
    cwd: npmDir,
    env: {
      ...process.env,
      npm_config_audit: "false",
      npm_config_fund: "false",
    },
  });

  runChecked(optionValue("--python") ?? "python", ["-m", "venv", venvDir], { cwd: pythonDir });
  const python = pythonExecutable(venvDir);
  runChecked(python, [
    "-m",
    "pip",
    "install",
    "--no-index",
    "--no-deps",
    resolve(newestMatching("python/dist", /^runinfra-.+\.whl$/u, "Python wheel")),
  ], {
    cwd: pythonDir,
    env: {
      ...process.env,
      PIP_DISABLE_PIP_VERSION_CHECK: "1",
    },
  });

  return {
    python,
    env: {
      RUNINFRA_CANARY_TS_MODULE: resolve(npmDir, "node_modules", "@runinfra", "sdk", "dist", "index.js"),
      RUNINFRA_CANARY_PYTHON_IMPORT_MODE: "installed",
    },
  };
}

function run(label, command, commandArgs, envOverrides = {}) {
  const result = spawnSync(command, commandArgs, {
    stdio: "inherit",
    env: { ...process.env, ...envOverrides },
    shell: false,
  });
  return { label, status: result.status ?? 1 };
}

mkdirSync(tempDir, { recursive: true });

const commonArgs = strict ? ["--strict"] : [];
let artifactRuntime = { python: optionValue("--python") ?? "python", env: {} };
try {
  if (packageSource === "artifact") {
    artifactRuntime = installArtifactCanaryPackages();
  }
} catch {
  const combined = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    strict,
    packageSource,
    expectedRows,
    parity: {
      status: "failed",
      errors: ["artifact canary package setup failed"],
    },
    reports: [],
  };
  if (reportPath) {
    const absolute = resolve(reportPath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, `${JSON.stringify(combined, null, 2)}\n`);
  }
  console.error("Live canary artifact package setup failed. Build npm and Python artifacts first.");
  process.exit(1);
}
const runs = [
  run("typescript", process.execPath, [
    "scripts/sdk-live-canary-typescript.mjs",
    ...commonArgs,
    "--report",
    tsReport,
  ], artifactRuntime.env),
  run("python", artifactRuntime.python, [
    "scripts/sdk-live-canary-python.py",
    ...commonArgs,
    "--report",
    pyReport,
  ], artifactRuntime.env),
];

const reports = [];
for (const { language, path } of [
  { language: "typescript", path: tsReport },
  { language: "python", path: pyReport },
]) {
  try {
    reports.push(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    reports.push({
      language,
      status: "missing",
      error: "child report missing or unreadable",
    });
  }
}

function reportRowErrors(report) {
  if (!report || typeof report !== "object" || !Array.isArray(report.results)) {
    return [`${report?.language ?? "unknown"} report missing results`];
  }
  const names = report.results.map((result) => result.name);
  const unique = new Set(names);
  const missing = expectedRows.filter((row) => !unique.has(row));
  const unexpected = names.filter((row) => !expectedRows.includes(row));
  const duplicates = names.filter((row, index) => names.indexOf(row) !== index);
  const errors = [];
  if (names.length !== unique.size) errors.push(`${report.language} duplicate rows: ${[...new Set(duplicates)].join(", ")}`);
  if (missing.length) errors.push(`${report.language} missing rows: ${missing.join(", ")}`);
  if (unexpected.length) errors.push(`${report.language} unexpected rows: ${unexpected.join(", ")}`);
  if (names.length !== expectedRows.length) errors.push(`${report.language} row count ${names.length} != ${expectedRows.length}`);
  return errors;
}

function sensitiveEnvValues() {
  return Object.entries(process.env)
    .filter(([name, value]) =>
      typeof value === "string" &&
      value.length >= 8 &&
      /(API[_-]?KEY|TOKEN|SECRET|PASSWORD|NPM|PYPI|TWINE|GITHUB|GH_)/iu.test(name)
    )
    .map(([, value]) => value);
}

function assertReportDoesNotLeak(report) {
  const serialized = JSON.stringify(report);
  const forbiddenPatterns = [
    /C:\\Users\\jaber/iu,
    /RightNow-Full/iu,
    /BEGIN (?:RSA |OPENSSH |EC |DSA )?PRIVATE KEY/u,
    /npm_[A-Za-z0-9]{20,}/u,
    /pypi-[A-Za-z0-9_-]{40,}/u,
    /ghp_[A-Za-z0-9_]{20,}/u,
    /sk-ri-[A-Za-z0-9_-]{20,}/u,
    /sourceMappingURL/u,
    /sourcesContent/u,
    /webpack:\/\//u,
    /\.npmrc/u,
  ];
  const matchedPattern = forbiddenPatterns.find((pattern) => pattern.test(serialized));
  if (matchedPattern) {
    throw new Error(`live canary report contains forbidden content: ${matchedPattern}`);
  }
  const leakedEnvValue = sensitiveEnvValues().find((value) => serialized.includes(value));
  if (leakedEnvValue) {
    throw new Error("live canary report contains a sensitive environment value");
  }
}

const parityErrors = [
  ...reportRowErrors(reports.find((report) => report.language === "typescript")),
  ...reportRowErrors(reports.find((report) => report.language === "python")),
];
const reportLanguages = new Set(reports.map((report) => report.language));
if (!reportLanguages.has("typescript")) parityErrors.push("missing TypeScript report");
if (!reportLanguages.has("python")) parityErrors.push("missing Python report");

const combined = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  strict,
  packageSource,
  expectedRows,
  parity: {
    status: parityErrors.length ? "failed" : "passed",
    errors: parityErrors,
  },
  reports,
};

try {
  assertReportDoesNotLeak(combined);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

if (reportPath) {
  const absolute = resolve(reportPath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(combined, null, 2)}\n`);
}

const failed = runs.filter((run) => run.status !== 0);
if (failed.length || parityErrors.length) {
  if (failed.length) console.error(`Live canary failures: ${failed.map((run) => run.label).join(", ")}`);
  if (parityErrors.length) console.error(`Live canary parity failures:\n${parityErrors.join("\n")}`);
  process.exit(1);
}

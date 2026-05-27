#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { productionBaseURL, reportBaseURL } from "./canary-report-base-url.mjs";
import { expectedRows } from "./live-canary-matrix.mjs";
import {
  buildBlockedModelDiscoveryReport,
  buildFailedModelDiscoveryReport,
  buildModelDiscoveryReport,
} from "./live-canary-model-discovery.mjs";
import { sourceDigestFileLabels } from "./live-canary-source-files.mjs";
import { publicSurfaceCoverage } from "./live-canary-surface-coverage.mjs";
import { readinessRowCoverageErrors } from "./live-canary-readiness-policy.mjs";
import { findForbiddenContent } from "./secret-scan-policy.mjs";

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const preflight = args.includes("--preflight");
const verifySurfaceCoverage = args.includes("--verify-surface-coverage");
const discoverModels = args.includes("--discover-models");
const writeEnvTemplate = args.some((arg) => arg === "--write-env-template" || arg.startsWith("--write-env-template="));
const writeMissingEnvTemplate = args.some((arg) =>
  arg === "--write-missing-env-template" || arg.startsWith("--write-missing-env-template=")
);
const forceEnvTemplate = args.includes("--force-env-template");
const reportPath = optionValue("--report");
const packageSource = optionValue("--package-source") ?? "artifact";
const envTemplatePath = optionValue("--write-env-template");
const missingEnvTemplatePath = optionValue("--write-missing-env-template");
const readinessReportPath = optionValue("--readiness-report");
const scriptEnvFilePath = optionValue("--runinfra-env-file") ?? optionValue("--env-file");
const nodeEnvFilePath = optionValueFrom(process.execArgv, "--env-file");
const envFilePath = scriptEnvFilePath ?? nodeEnvFilePath;
const envFileMayAlreadyBeLoaded = !scriptEnvFilePath && Boolean(nodeEnvFilePath);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const expectedSdkVersion = readExpectedSdkVersion();
const tempRoot = resolve(".canary-tmp");
const tempDir = join(tempRoot, `${Date.now()}-${process.pid}`);
const tsReport = resolve(tempDir, "typescript.json");
const pyReport = resolve(tempDir, "python.json");
let resolvedArtifactCandidate;
const sourceDigestFiles = sourceDigestFileLabels.map((label) => [label, join(repositoryRoot, ...label.split("/"))]);

function optionValueFrom(values, name) {
  const exact = values.find((arg) => arg.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const index = values.indexOf(name);
  return index >= 0 ? values[index + 1] : undefined;
}

function optionValue(name) {
  return optionValueFrom(args, name);
}

if (!["artifact", "source"].includes(packageSource)) {
  console.error(`Unsupported package source "${packageSource}". Use --package-source artifact or --package-source source.`);
  process.exit(2);
}

if ([discoverModels, preflight, verifySurfaceCoverage].filter(Boolean).length > 1) {
  console.error("--discover-models cannot be combined with --preflight or --verify-surface-coverage.");
  process.exit(2);
}

if (forceEnvTemplate && !writeEnvTemplate && !writeMissingEnvTemplate) {
  console.error("--force-env-template requires --write-env-template or --write-missing-env-template.");
  process.exit(2);
}

if (writeEnvTemplate) {
  if (!envTemplatePath || envTemplatePath.startsWith("--")) {
    console.error("--write-env-template requires an output path.");
    process.exit(2);
  }
  if ([discoverModels, preflight, verifySurfaceCoverage].some(Boolean)) {
    console.error("--write-env-template cannot be combined with --discover-models, --preflight, or --verify-surface-coverage.");
    process.exit(2);
  }
  if (reportPath) {
    console.error("--write-env-template cannot be combined with --report.");
    process.exit(2);
  }
  if (envFilePath) {
    console.error("--write-env-template cannot be combined with --runinfra-env-file or Node --env-file.");
    process.exit(2);
  }
}

if (writeMissingEnvTemplate) {
  if (!missingEnvTemplatePath || missingEnvTemplatePath.startsWith("--")) {
    console.error("--write-missing-env-template requires an output path.");
    process.exit(2);
  }
  if (!readinessReportPath || readinessReportPath.startsWith("--")) {
    console.error("--write-missing-env-template requires --readiness-report.");
    process.exit(2);
  }
  if ([discoverModels, preflight, verifySurfaceCoverage].some(Boolean)) {
    console.error("--write-missing-env-template cannot be combined with --discover-models, --preflight, or --verify-surface-coverage.");
    process.exit(2);
  }
  if (writeEnvTemplate) {
    console.error("--write-missing-env-template cannot be combined with --write-env-template.");
    process.exit(2);
  }
  if (reportPath) {
    console.error("--write-missing-env-template cannot be combined with --report.");
    process.exit(2);
  }
  if (envFilePath) {
    console.error("--write-missing-env-template cannot be combined with --runinfra-env-file or Node --env-file.");
    process.exit(2);
  }
}

if (readinessReportPath && !writeMissingEnvTemplate) {
  console.error("--readiness-report requires --write-missing-env-template.");
  process.exit(2);
}

function parseEnvFileContent(content) {
  const parsed = {};
  for (const line of content.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const match = trimmed.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/u);
    if (!match) continue;
    const key = match[1];
    parsed[key] = parseEnvFileValue(match[2] ?? "");
  }
  return parsed;
}

function parseEnvFileValue(rawValue) {
  const value = rawValue.trimStart();
  const quote = value[0];
  if (quote === '"' || quote === "'") {
    const end = value.indexOf(quote, 1);
    return end >= 0 ? value.slice(1, end) : value.slice(1);
  }
  const commentIndex = value.indexOf("#");
  return (commentIndex >= 0 ? value.slice(0, commentIndex) : value).trimEnd();
}

const canonicalEnvAliases = new Map([
  ["RUNINFRA_LLM_MODEL", ["TEST_MODEL"]],
  ["RUNINFRA_EMBEDDING_MODEL", ["TEST_EMBEDDING_MODEL"]],
  ["RUNINFRA_IMAGE_MODEL", ["TEST_IMAGE_MODEL"]],
  ["RUNINFRA_TTS_MODEL", ["TEST_TTS_MODEL"]],
  ["RUNINFRA_TTS_VOICE", ["TEST_TTS_VOICE"]],
  ["RUNINFRA_TTS_REF_AUDIO", ["TEST_TTS_REF_AUDIO"]],
  ["RUNINFRA_TTS_REF_TEXT", ["TEST_TTS_REF_TEXT"]],
  ["RUNINFRA_TTS_TASK_TYPE", ["TEST_TTS_TASK_TYPE"]],
  ["RUNINFRA_ASR_MODEL", ["TEST_ASR_MODEL"]],
  ["RUNINFRA_ASR_FIXTURE_PATH", ["TEST_ASR_FILE"]],
  ["RUNINFRA_VOICE_PIPELINE_ID", ["TEST_PIPELINE_ID"]],
]);

function logicalEnvGroup(name) {
  const names = new Set([name]);
  for (const [canonical, aliases] of canonicalEnvAliases.entries()) {
    if (canonical === name || aliases.includes(name)) {
      names.add(canonical);
      for (const alias of aliases) names.add(alias);
    }
  }
  return names;
}

function nonEmptyProcessEnvNames(parsed, envFileMayAlreadyBeLoaded) {
  const names = new Set(Object.keys(process.env).filter((name) => process.env[name]?.trim()));
  if (!envFileMayAlreadyBeLoaded) return names;
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key]?.trim() === value.trim()) names.delete(key);
  }
  return names;
}

function explicitProcessEnvProtectsKey(key, explicitNames) {
  for (const name of logicalEnvGroup(key)) {
    if (explicitNames.has(name)) return true;
  }
  return false;
}

function loadEnvFileIntoProcessEnv(filePath, envFileMayAlreadyBeLoaded) {
  if (!filePath) return;
  const envPath = resolve(filePath);
  if (!existsSync(envPath)) {
    console.error("--runinfra-env-file does not exist");
    process.exit(2);
  }
  const parsed = parseEnvFileContent(readFileSync(envPath, "utf8"));
  const explicitNames = nonEmptyProcessEnvNames(parsed, envFileMayAlreadyBeLoaded);
  for (const [key, value] of Object.entries(parsed)) {
    const loadedByNodeEnvFile = envFileMayAlreadyBeLoaded && process.env[key]?.trim() === value.trim();
    if (explicitProcessEnvProtectsKey(key, explicitNames)) {
      if (loadedByNodeEnvFile && !explicitNames.has(key)) delete process.env[key];
      continue;
    }
    process.env[key] = value;
  }
}

function rawEnv(name) {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

function env(name) {
  const value = rawEnv(name);
  if (value) return value;
  for (const alias of canonicalEnvAliases.get(name) ?? []) {
    const aliasValue = rawEnv(alias);
    if (aliasValue) return aliasValue;
  }
  return undefined;
}

function firstEnv(...names) {
  for (const name of names) {
    const value = env(name);
    if (value) return value;
  }
  return undefined;
}

function redactedEnv(names) {
  return Object.fromEntries(names.map((name) => [name, env(name) ? "set_redacted" : "missing"]));
}

function redactedEnvAliases(names) {
  const aliases = {};
  for (const name of names) {
    if (rawEnv(name)) continue;
    const setAliases = (canonicalEnvAliases.get(name) ?? []).filter((alias) => rawEnv(alias)).sort();
    if (setAliases.length) aliases[name] = setAliases;
  }
  return aliases;
}

const relevantEnv = [
  "RUNINFRA_API_KEY",
  "RUNINFRA_BASE_URL",
  "RUNINFRA_CANARY_TIMEOUT_SECONDS",
  "RUNINFRA_CANARY_CHILD_TIMEOUT_SECONDS",
  "RUNINFRA_CANARY_STREAM_SLOW_CONSUMER_DELAY_MS",
  "RUNINFRA_LLM_MODEL",
  "RUNINFRA_EMBEDDING_MODEL",
  "RUNINFRA_IMAGE_MODEL",
  "RUNINFRA_IMAGE_SIZE",
  "RUNINFRA_IMAGE_RESPONSE_FORMAT",
  "RUNINFRA_TTS_MODEL",
  "RUNINFRA_TTS_VOICE",
  "RUNINFRA_TTS_REF_AUDIO",
  "RUNINFRA_TTS_REF_TEXT",
  "RUNINFRA_TTS_TASK_TYPE",
  "RUNINFRA_TTS_RESPONSE_FORMAT",
  "RUNINFRA_ASR_MODEL",
  "RUNINFRA_ASR_LANGUAGE",
  "RUNINFRA_ASR_RESPONSE_FORMAT",
  "RUNINFRA_ASR_FIXTURE_PATH",
  "RUNINFRA_ASR_FIXTURE_CONTENT_TYPE",
  "RUNINFRA_ASR_EXPECTED_TEXT",
  "RUNINFRA_PIPELINE_API_KEY",
  "RUNINFRA_VOICE_PIPELINE_ID",
  "RUNINFRA_VOICE_PIPELINE_API_KEY",
  "RUNINFRA_VOICE_PIPELINE_AUDIO_PATH",
  "RUNINFRA_VOICE_PIPELINE_AUDIO_CONTENT_TYPE",
  "RUNINFRA_VOICE_PIPELINE_EXPECTED_TEXT",
  "RUNINFRA_CANARY_ENABLE_IDEMPOTENCY",
  "RUNINFRA_CANARY_IDEMPOTENCY_EVIDENCE_FIELD",
];

function buildStrictLiveCanaryEnvTemplate() {
  return [
    "# RunInfra SDK strict live-canary env template.",
    "# Fill values in a private file and pass it with --runinfra-env-file.",
    "# Do not commit this file, paste registry tokens into it, or use it as promotion evidence.",
    "",
    "# Gateway and execution controls.",
    `RUNINFRA_BASE_URL=${productionBaseURL}`,
    "RUNINFRA_API_KEY=",
    "RUNINFRA_CANARY_TIMEOUT_SECONDS=120",
    "RUNINFRA_CANARY_CHILD_TIMEOUT_SECONDS=720",
    "RUNINFRA_CANARY_STREAM_SLOW_CONSUMER_DELAY_MS=25",
    "",
    "# Text, chat, responses, streaming, embeddings, and images.",
    "RUNINFRA_LLM_MODEL=",
    "RUNINFRA_EMBEDDING_MODEL=",
    "RUNINFRA_IMAGE_MODEL=",
    "RUNINFRA_IMAGE_SIZE=",
    "RUNINFRA_IMAGE_RESPONSE_FORMAT=b64_json",
    "",
    "# Text to speech. Use either RUNINFRA_TTS_VOICE or the reference-audio pair.",
    "RUNINFRA_TTS_MODEL=",
    "RUNINFRA_TTS_VOICE=",
    "RUNINFRA_TTS_REF_AUDIO=",
    "RUNINFRA_TTS_REF_TEXT=",
    "RUNINFRA_TTS_TASK_TYPE=Base",
    "RUNINFRA_TTS_RESPONSE_FORMAT=mp3",
    "",
    "# Speech to text. For GitHub Actions, store the fixture as the base64 secret below.",
    "RUNINFRA_ASR_MODEL=",
    "RUNINFRA_ASR_LANGUAGE=en",
    "RUNINFRA_ASR_RESPONSE_FORMAT=json",
    "RUNINFRA_ASR_FIXTURE_PATH=",
    "# RUNINFRA_ASR_FIXTURE_BASE64=",
    "RUNINFRA_ASR_FIXTURE_CONTENT_TYPE=audio/wav",
    "RUNINFRA_ASR_EXPECTED_TEXT=",
    "",
    "# Voice pipeline. The audio fixture falls back to RUNINFRA_ASR_FIXTURE_PATH when unset.",
    "RUNINFRA_PIPELINE_API_KEY=",
    "RUNINFRA_VOICE_PIPELINE_ID=",
    "RUNINFRA_VOICE_PIPELINE_API_KEY=",
    "RUNINFRA_VOICE_PIPELINE_AUDIO_PATH=",
    "# RUNINFRA_VOICE_PIPELINE_AUDIO_BASE64=",
    "RUNINFRA_VOICE_PIPELINE_AUDIO_CONTENT_TYPE=audio/wav",
    "RUNINFRA_VOICE_PIPELINE_EXPECTED_TEXT=",
    "",
    "# Explicitly opt in to replaying an idempotent request during the strict canary.",
    "RUNINFRA_CANARY_ENABLE_IDEMPOTENCY=1",
    "RUNINFRA_CANARY_IDEMPOTENCY_EVIDENCE_FIELD=",
    "",
    "# Legacy RunPipe aliases accepted by the runner. Prefer RUNINFRA_* for new setup.",
    "TEST_MODEL=",
    "TEST_EMBEDDING_MODEL=",
    "TEST_IMAGE_MODEL=",
    "TEST_TTS_MODEL=",
    "TEST_TTS_VOICE=",
    "TEST_TTS_REF_AUDIO=",
    "TEST_TTS_REF_TEXT=",
    "TEST_TTS_TASK_TYPE=",
    "TEST_ASR_MODEL=",
    "TEST_ASR_FILE=",
    "TEST_PIPELINE_ID=",
    "",
  ].join("\n");
}

function assertEnvTemplateDoesNotLeak(template) {
  const matchedPattern = findForbiddenContent(template);
  if (matchedPattern) {
    throw new Error(`strict live-canary env template contains forbidden content: ${matchedPattern.label}`);
  }
  if (sensitiveEnvValues().some((value) => template.includes(value))) {
    throw new Error("strict live-canary env template contains a sensitive environment value");
  }
}

function writeStrictLiveCanaryEnvTemplate(outputPath) {
  const absolute = resolve(outputPath);
  if (existsSync(absolute) && !forceEnvTemplate) {
    throw new Error("strict live-canary env template already exists; pass --force-env-template to replace it.");
  }
  const template = buildStrictLiveCanaryEnvTemplate();
  assertEnvTemplateDoesNotLeak(template);
  try {
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, template);
  } catch {
    throw new Error("failed to write strict live-canary env template.");
  }
}

const missingEnvPatchEntries = [
  {
    section: "Gateway and execution controls.",
    triggers: ["RUNINFRA_BASE_URL safe http(s) URL without credentials, query strings, or fragments"],
    assignments: [{ key: "RUNINFRA_BASE_URL", value: productionBaseURL }],
  },
  {
    section: "Gateway and execution controls.",
    triggers: ["RUNINFRA_API_KEY"],
    assignments: [{ key: "RUNINFRA_API_KEY" }],
  },
  {
    section: "Gateway and execution controls.",
    triggers: ["RUNINFRA_CANARY_TIMEOUT_SECONDS positive finite number <= 600"],
    assignments: [{ key: "RUNINFRA_CANARY_TIMEOUT_SECONDS", value: "120" }],
  },
  {
    section: "Gateway and execution controls.",
    triggers: ["RUNINFRA_CANARY_CHILD_TIMEOUT_SECONDS positive finite number <= 1800"],
    assignments: [{ key: "RUNINFRA_CANARY_CHILD_TIMEOUT_SECONDS", value: "720" }],
  },
  {
    section: "Gateway and execution controls.",
    triggers: ["RUNINFRA_CANARY_STREAM_SLOW_CONSUMER_DELAY_MS non-negative integer <= 5000"],
    assignments: [{ key: "RUNINFRA_CANARY_STREAM_SLOW_CONSUMER_DELAY_MS", value: "25" }],
  },
  {
    section: "Text, chat, responses, streaming, embeddings, and images.",
    triggers: ["RUNINFRA_LLM_MODEL"],
    assignments: [{ key: "RUNINFRA_LLM_MODEL" }],
  },
  {
    section: "Text, chat, responses, streaming, embeddings, and images.",
    triggers: ["RUNINFRA_EMBEDDING_MODEL"],
    assignments: [{ key: "RUNINFRA_EMBEDDING_MODEL" }],
  },
  {
    section: "Text, chat, responses, streaming, embeddings, and images.",
    triggers: ["RUNINFRA_IMAGE_MODEL"],
    assignments: [{ key: "RUNINFRA_IMAGE_MODEL" }],
  },
  {
    section: "Text, chat, responses, streaming, embeddings, and images.",
    triggers: ["RUNINFRA_IMAGE_SIZE"],
    assignments: [{ key: "RUNINFRA_IMAGE_SIZE" }],
  },
  {
    section: "Text, chat, responses, streaming, embeddings, and images.",
    triggers: ["RUNINFRA_IMAGE_RESPONSE_FORMAT", "RUNINFRA_IMAGE_RESPONSE_FORMAT url or b64_json"],
    assignments: [{ key: "RUNINFRA_IMAGE_RESPONSE_FORMAT", value: "b64_json" }],
  },
  {
    section: "Text to speech.",
    triggers: ["RUNINFRA_TTS_MODEL"],
    assignments: [{ key: "RUNINFRA_TTS_MODEL" }],
  },
  {
    section: "Text to speech.",
    triggers: ["RUNINFRA_TTS_VOICE or RUNINFRA_TTS_REF_AUDIO plus RUNINFRA_TTS_REF_TEXT"],
    comments: ["Provide either RUNINFRA_TTS_VOICE or the reference-audio pair."],
    assignments: [
      { key: "RUNINFRA_TTS_VOICE" },
      { key: "RUNINFRA_TTS_REF_AUDIO" },
      { key: "RUNINFRA_TTS_REF_TEXT" },
    ],
  },
  {
    section: "Text to speech.",
    triggers: ["RUNINFRA_TTS_TASK_TYPE"],
    assignments: [{ key: "RUNINFRA_TTS_TASK_TYPE", value: "Base" }],
  },
  {
    section: "Text to speech.",
    triggers: ["RUNINFRA_TTS_RESPONSE_FORMAT", "RUNINFRA_TTS_RESPONSE_FORMAT mp3, opus, aac, flac, wav, or pcm"],
    assignments: [{ key: "RUNINFRA_TTS_RESPONSE_FORMAT", value: "mp3" }],
  },
  {
    section: "Speech to text.",
    triggers: ["RUNINFRA_ASR_MODEL"],
    assignments: [{ key: "RUNINFRA_ASR_MODEL" }],
  },
  {
    section: "Speech to text.",
    triggers: ["RUNINFRA_ASR_LANGUAGE"],
    assignments: [{ key: "RUNINFRA_ASR_LANGUAGE", value: "en" }],
  },
  {
    section: "Speech to text.",
    triggers: ["RUNINFRA_ASR_RESPONSE_FORMAT", "RUNINFRA_ASR_RESPONSE_FORMAT json or verbose_json"],
    assignments: [{ key: "RUNINFRA_ASR_RESPONSE_FORMAT", value: "json" }],
  },
  {
    section: "Speech to text.",
    triggers: ["RUNINFRA_ASR_FIXTURE_PATH", "RUNINFRA_ASR_FIXTURE_PATH readable non-empty file"],
    assignments: [{ key: "RUNINFRA_ASR_FIXTURE_PATH" }],
  },
  {
    section: "Speech to text.",
    triggers: ["RUNINFRA_ASR_FIXTURE_CONTENT_TYPE"],
    assignments: [{ key: "RUNINFRA_ASR_FIXTURE_CONTENT_TYPE", value: "audio/wav" }],
  },
  {
    section: "Speech to text.",
    triggers: ["RUNINFRA_ASR_EXPECTED_TEXT"],
    assignments: [{ key: "RUNINFRA_ASR_EXPECTED_TEXT" }],
  },
  {
    section: "Voice pipeline.",
    triggers: ["RUNINFRA_VOICE_PIPELINE_API_KEY or RUNINFRA_PIPELINE_API_KEY or RUNINFRA_API_KEY"],
    comments: ["Provide a pipeline-scoped key, or rely on RUNINFRA_API_KEY only if the gateway allows it."],
    assignments: [
      { key: "RUNINFRA_PIPELINE_API_KEY" },
      { key: "RUNINFRA_VOICE_PIPELINE_API_KEY" },
    ],
  },
  {
    section: "Voice pipeline.",
    triggers: ["RUNINFRA_VOICE_PIPELINE_ID or TEST_PIPELINE_ID"],
    assignments: [{ key: "RUNINFRA_VOICE_PIPELINE_ID" }],
  },
  {
    section: "Voice pipeline.",
    triggers: [
      "RUNINFRA_VOICE_PIPELINE_AUDIO_PATH or RUNINFRA_ASR_FIXTURE_PATH",
      "RUNINFRA_VOICE_PIPELINE_AUDIO_PATH or RUNINFRA_ASR_FIXTURE_PATH readable non-empty file",
    ],
    comments: ["The voice-pipeline audio fixture can fall back to RUNINFRA_ASR_FIXTURE_PATH."],
    assignments: [
      { key: "RUNINFRA_VOICE_PIPELINE_AUDIO_PATH" },
      { key: "RUNINFRA_ASR_FIXTURE_PATH" },
    ],
  },
  {
    section: "Voice pipeline.",
    triggers: ["RUNINFRA_VOICE_PIPELINE_AUDIO_CONTENT_TYPE"],
    assignments: [{ key: "RUNINFRA_VOICE_PIPELINE_AUDIO_CONTENT_TYPE", value: "audio/wav" }],
  },
  {
    section: "Voice pipeline.",
    triggers: ["RUNINFRA_VOICE_PIPELINE_EXPECTED_TEXT or RUNINFRA_ASR_EXPECTED_TEXT"],
    comments: ["The voice-pipeline expected text can fall back to RUNINFRA_ASR_EXPECTED_TEXT."],
    assignments: [
      { key: "RUNINFRA_VOICE_PIPELINE_EXPECTED_TEXT" },
      { key: "RUNINFRA_ASR_EXPECTED_TEXT" },
    ],
  },
  {
    section: "Idempotency replay.",
    triggers: ["RUNINFRA_CANARY_ENABLE_IDEMPOTENCY=1"],
    assignments: [{ key: "RUNINFRA_CANARY_ENABLE_IDEMPOTENCY", value: "1" }],
  },
  {
    section: "Idempotency replay.",
    triggers: ["RUNINFRA_CANARY_IDEMPOTENCY_EVIDENCE_FIELD dot-separated response field paths"],
    assignments: [{ key: "RUNINFRA_CANARY_IDEMPOTENCY_EVIDENCE_FIELD" }],
  },
];

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((entry) => typeof entry === "string");
}

function isSha256Hex(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function assertStrictPreflightReportEnvelope(report) {
  const candidate = report.candidate;
  const surfaceCoverage = report.surfaceCoverage;
  const parity = report.parity;
  if (
    report.strict !== true ||
    !["artifact", "source"].includes(report.packageSource) ||
    typeof report.generatedAt !== "string" ||
    Number.isNaN(Date.parse(report.generatedAt)) ||
    !isPlainObject(candidate) ||
    candidate.sdkVersion !== expectedSdkVersion ||
    candidate.packageSource !== report.packageSource ||
    !isSha256Hex(candidate.sourceDigestSha256) ||
    !Number.isSafeInteger(candidate.sourceFileCount) ||
    candidate.sourceFileCount <= 0 ||
    typeof candidate.artifactDigestsChecked !== "boolean" ||
    !Array.isArray(candidate.artifacts) ||
    !isPlainObject(surfaceCoverage) ||
    surfaceCoverage.status !== "passed" ||
    !isStringArray(surfaceCoverage.errors) ||
    surfaceCoverage.errors.length !== 0 ||
    !Array.isArray(surfaceCoverage.uncoveredRows) ||
    surfaceCoverage.uncoveredRows.length !== 0 ||
    !isPlainObject(parity) ||
    parity.status !== "not_run" ||
    !isStringArray(parity.errors) ||
    parity.errors.length !== 0 ||
    !Array.isArray(report.reports) ||
    report.reports.length !== 0
  ) {
    throw new Error("readiness report must be a strict preflight report.");
  }
  if (
    candidate.sourceDigestSha256 !== sourceDigestSha256() ||
    candidate.sourceFileCount !== sourceDigestFiles.length
  ) {
    throw new Error("readiness report candidate source identity must match current sources.");
  }
}

function assertReadinessReportShape(report) {
  if (!report || typeof report !== "object" || report.schemaVersion !== 1) {
    throw new Error("readiness report must use schemaVersion 1.");
  }
  assertStrictPreflightReportEnvelope(report);
  const readiness = report.readiness;
  if (!readiness || typeof readiness !== "object") {
    throw new Error("readiness report must contain readiness data.");
  }
  if (!isPlainObject(readiness.env) || !isPlainObject(readiness.aliases)) {
    throw new Error("readiness report must contain redacted env and alias data.");
  }
  if (!Array.isArray(readiness.missing) || !readiness.missing.every((value) => typeof value === "string")) {
    throw new Error("readiness report missing inputs must be a string array.");
  }
  if (!Array.isArray(readiness.rows)) {
    throw new Error("readiness report rows must be an array.");
  }
  if (!isStringArray(readiness.rowCoverageErrors) || readiness.rowCoverageErrors.some((value) => value)) {
    throw new Error("readiness report row coverage errors must be empty.");
  }
  for (const row of readiness.rows) {
    if (!row || typeof row !== "object" || typeof row.name !== "string") {
      throw new Error("readiness report rows must have names.");
    }
    if (row.status !== "ready" && row.status !== "blocked") {
      throw new Error("readiness report rows must be ready or blocked.");
    }
    if (!Array.isArray(row.missing) || !row.missing.every((value) => typeof value === "string")) {
      throw new Error("readiness report row missing inputs must be string arrays.");
    }
  }
  if (!Array.isArray(report.expectedRows) || !sameStringArray(report.expectedRows, expectedRows)) {
    throw new Error("readiness report expected rows must match the canonical strict matrix.");
  }
  if (!sameStringArray(readiness.rows.map((row) => row.name), report.expectedRows)) {
    throw new Error("readiness report row names must match expected rows.");
  }
  const summary = readiness.summary;
  if (!summary || typeof summary !== "object") {
    throw new Error("readiness report summary must match readiness rows.");
  }
  const derivedMissing = sortedUnique([...readiness.rowCoverageErrors, ...readiness.rows.flatMap((row) => row.missing)]);
  if (
    readiness.rows.some((row) => (row.missing.length ? row.status !== "blocked" : row.status !== "ready")) ||
    !sameStringArray(sortedUnique(readiness.missing), derivedMissing) ||
    readiness.status !== (derivedMissing.length ? "blocked" : "ready")
  ) {
    throw new Error("readiness report missing inputs must match readiness rows.");
  }
  const readyRows = readiness.rows.filter((row) => row.status === "ready").length;
  const blockedRows = readiness.rows.filter((row) => row.status === "blocked").length;
  if (summary.ready !== readyRows || summary.blocked !== blockedRows) {
    throw new Error("readiness report summary must match readiness rows.");
  }
  return readiness;
}

function buildMissingStrictLiveCanaryEnvTemplate(report) {
  assertReportDoesNotLeak(report);
  const readiness = assertReadinessReportShape(report);
  const missing = sortedUnique(readiness.missing);
  if (!missing.length) {
    throw new Error("readiness report has no missing env inputs.");
  }
  const supported = new Set(missingEnvPatchEntries.flatMap((entry) => entry.triggers));
  if (missing.some((name) => !supported.has(name))) {
    throw new Error("readiness report contains unsupported missing inputs.");
  }
  const triggeredEntries = missingEnvPatchEntries.filter((entry) =>
    entry.triggers.some((trigger) => missing.includes(trigger))
  );
  const blockedRows = readiness.rows
    .filter((row) => row.status === "blocked")
    .map((row) => row.name);
  const validKeys = new Set(relevantEnv);
  const emittedKeys = new Set();
  const lines = [
    "# RunInfra SDK missing strict live-canary env patch.",
    "# Generated from a redacted readiness report. Fill values in a private file.",
    "# This patch is not promotion evidence and intentionally omits already-satisfied variables.",
  ];
  if (readiness.summary && typeof readiness.summary === "object") {
    const ready = Number.isInteger(readiness.summary.ready) ? readiness.summary.ready : "unknown";
    const blocked = Number.isInteger(readiness.summary.blocked) ? readiness.summary.blocked : "unknown";
    lines.push(`# Readiness summary: ${ready} ready, ${blocked} blocked.`);
  }
  if (blockedRows.length) {
    lines.push("# Blocked rows:");
    for (const row of blockedRows) lines.push(`# - ${row}`);
  }
  let currentSection = "";
  for (const entry of triggeredEntries) {
    const assignments = entry.assignments.filter((assignment) => !emittedKeys.has(assignment.key));
    if (!assignments.length) continue;
    for (const assignment of assignments) {
      if (!validKeys.has(assignment.key)) {
        throw new Error("missing env patch would emit an unsupported env key.");
      }
    }
    if (entry.section !== currentSection) {
      lines.push("", `# ${entry.section}`);
      currentSection = entry.section;
    }
    for (const comment of entry.comments ?? []) lines.push(`# ${comment}`);
    for (const assignment of assignments) {
      lines.push(`${assignment.key}=${assignment.value ?? ""}`);
      emittedKeys.add(assignment.key);
    }
  }
  lines.push("");
  const template = lines.join("\n");
  assertEnvTemplateDoesNotLeak(template);
  return template;
}

function readReadinessReport(filePath) {
  try {
    return JSON.parse(readFileSync(resolve(filePath), "utf8"));
  } catch {
    throw new Error("readiness report is missing or unreadable.");
  }
}

function writeMissingStrictLiveCanaryEnvTemplate(outputPath, inputPath) {
  const absolute = resolve(outputPath);
  if (existsSync(absolute) && !forceEnvTemplate) {
    throw new Error("missing strict live-canary env patch already exists; pass --force-env-template to replace it.");
  }
  const template = buildMissingStrictLiveCanaryEnvTemplate(readReadinessReport(inputPath));
  try {
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, template);
  } catch {
    throw new Error("failed to write missing strict live-canary env patch.");
  }
}

if (writeEnvTemplate) {
  try {
    writeStrictLiveCanaryEnvTemplate(envTemplatePath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  console.log("Wrote strict live-canary env template.");
  process.exit(0);
}

if (writeMissingEnvTemplate) {
  try {
    writeMissingStrictLiveCanaryEnvTemplate(missingEnvTemplatePath, readinessReportPath);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(2);
  }
  console.log("Wrote missing strict live-canary env patch.");
  process.exit(0);
}

loadEnvFileIntoProcessEnv(envFilePath, envFileMayAlreadyBeLoaded);

const ttsResponseFormats = ["mp3", "opus", "aac", "flac", "wav", "pcm"];
const idempotencyEvidenceFieldRequirementMessage =
  "RUNINFRA_CANARY_IDEMPOTENCY_EVIDENCE_FIELD dot-separated response field paths";
const idempotencyEvidenceFieldPattern = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$/u;
const maxCanaryTimeoutSeconds = 600;
const defaultChildCanaryTimeoutSeconds = 720;
const maxChildCanaryTimeoutSeconds = 1800;

function missingEnv(names) {
  return names.filter((name) => !env(name));
}

function optionalCanaryTimeoutRequirement() {
  const name = "RUNINFRA_CANARY_TIMEOUT_SECONDS";
  const value = env(name);
  if (!value) return [];
  const parsed = Number(value);
  if (
    !/^(?:[1-9][0-9]*|0\.[0-9]*[1-9][0-9]*|[1-9][0-9]*\.[0-9]+)$/u.test(value) ||
    !Number.isFinite(parsed) ||
    parsed <= 0 ||
    parsed > maxCanaryTimeoutSeconds
  ) {
    return [`${name} positive finite number <= ${maxCanaryTimeoutSeconds}`];
  }
  return [];
}

function optionalChildCanaryTimeoutRequirement() {
  return optionalPositiveFiniteSecondsRequirement(
    "RUNINFRA_CANARY_CHILD_TIMEOUT_SECONDS",
    maxChildCanaryTimeoutSeconds,
  );
}

function optionalPositiveFiniteSecondsRequirement(name, maxSeconds) {
  const value = env(name);
  if (!value) return [];
  const parsed = Number(value);
  if (
    !/^(?:[1-9][0-9]*|0\.[0-9]*[1-9][0-9]*|[1-9][0-9]*\.[0-9]+)$/u.test(value) ||
    !Number.isFinite(parsed) ||
    parsed <= 0 ||
    parsed > maxSeconds
  ) {
    return [`${name} positive finite number <= ${maxSeconds}`];
  }
  return [];
}

function optionalNonNegativeIntegerRequirement(name) {
  const value = env(name);
  if (!value) return [];
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    return [`${name} non-negative integer <= 5000`];
  }
  return Number(value) <= 5000 ? [] : [`${name} non-negative integer <= 5000`];
}

function isLocalBaseURLHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/gu, "");
  return ["localhost", "127.0.0.1", "0.0.0.0", "::1"].includes(normalized);
}

function optionalBaseURLRequirement() {
  const value = env("RUNINFRA_BASE_URL");
  if (!value) return [];
  const message = "RUNINFRA_BASE_URL safe http(s) URL without credentials, query strings, or fragments";
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return [message];
  }
  if (!["http:", "https:"].includes(parsed.protocol)) return [message];
  if (parsed.username || parsed.password || parsed.search || parsed.hash) return [message];
  if (parsed.protocol === "http:" && !isLocalBaseURLHostname(parsed.hostname)) return [message];
  return [];
}

function optionalIdempotencyEvidenceFieldRequirement() {
  const value = env("RUNINFRA_CANARY_IDEMPOTENCY_EVIDENCE_FIELD");
  if (!value) return [];
  const fields = value.split(",").map((field) => field.trim()).filter(Boolean);
  if (!fields.length) return [idempotencyEvidenceFieldRequirementMessage];
  return fields.every((field) => idempotencyEvidenceFieldPattern.test(field))
    ? []
    : [idempotencyEvidenceFieldRequirementMessage];
}

function readableNonEmptyFileRequirement(name) {
  const value = env(name);
  if (!value) return [name];
  try {
    if (statSync(resolve(value)).size > 0) return [];
  } catch {
    // Redact the actual path; callers only need to know which readiness input is unusable.
  }
  return [`${name} readable non-empty file`];
}

function firstReadableNonEmptyFileRequirement(label, ...names) {
  const value = firstEnv(...names);
  if (!value) return [label];
  try {
    if (statSync(resolve(value)).size > 0) return [];
  } catch {
    // Redact the actual path.
  }
  return [`${label} readable non-empty file`];
}

function speechRequirements() {
  const missing = missingEnv(["RUNINFRA_API_KEY", "RUNINFRA_TTS_MODEL"]);
  if (!env("RUNINFRA_TTS_VOICE") && !(env("RUNINFRA_TTS_REF_AUDIO") && env("RUNINFRA_TTS_REF_TEXT"))) {
    missing.push("RUNINFRA_TTS_VOICE or RUNINFRA_TTS_REF_AUDIO plus RUNINFRA_TTS_REF_TEXT");
  }
  return missing;
}

function ttsResponseFormatRequirement() {
  const value = env("RUNINFRA_TTS_RESPONSE_FORMAT");
  if (!value) return ["RUNINFRA_TTS_RESPONSE_FORMAT"];
  return ttsResponseFormats.includes(value)
    ? []
    : ["RUNINFRA_TTS_RESPONSE_FORMAT mp3, opus, aac, flac, wav, or pcm"];
}

function imageResponseFormatRequirement() {
  const value = env("RUNINFRA_IMAGE_RESPONSE_FORMAT");
  if (!value) return ["RUNINFRA_IMAGE_RESPONSE_FORMAT"];
  return ["url", "b64_json"].includes(value) ? [] : ["RUNINFRA_IMAGE_RESPONSE_FORMAT url or b64_json"];
}

function asrResponseFormatRequirement() {
  const value = env("RUNINFRA_ASR_RESPONSE_FORMAT");
  if (!value) return ["RUNINFRA_ASR_RESPONSE_FORMAT"];
  return ["json", "verbose_json"].includes(value) ? [] : ["RUNINFRA_ASR_RESPONSE_FORMAT json or verbose_json"];
}

function voiceRequirements() {
  return [
    ...(!firstEnv("RUNINFRA_VOICE_PIPELINE_API_KEY", "RUNINFRA_PIPELINE_API_KEY", "RUNINFRA_API_KEY")
      ? ["RUNINFRA_VOICE_PIPELINE_API_KEY or RUNINFRA_PIPELINE_API_KEY or RUNINFRA_API_KEY"]
      : []),
    ...(!firstEnv("RUNINFRA_VOICE_PIPELINE_ID", "TEST_PIPELINE_ID")
      ? ["RUNINFRA_VOICE_PIPELINE_ID or TEST_PIPELINE_ID"]
      : []),
    ...firstReadableNonEmptyFileRequirement(
      "RUNINFRA_VOICE_PIPELINE_AUDIO_PATH or RUNINFRA_ASR_FIXTURE_PATH",
      "RUNINFRA_VOICE_PIPELINE_AUDIO_PATH",
      "RUNINFRA_ASR_FIXTURE_PATH",
    ),
    ...(!firstEnv("RUNINFRA_VOICE_PIPELINE_EXPECTED_TEXT", "RUNINFRA_ASR_EXPECTED_TEXT")
      ? ["RUNINFRA_VOICE_PIPELINE_EXPECTED_TEXT or RUNINFRA_ASR_EXPECTED_TEXT"]
      : []),
  ];
}

const rowReadinessRequirements = [
  ["models.list", () => missingEnv(["RUNINFRA_API_KEY"])],
  ["models.retrieve.llm", () => missingEnv(["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"])],
  ["models.retrieve.embedding", () => missingEnv(["RUNINFRA_API_KEY", "RUNINFRA_EMBEDDING_MODEL"])],
  ["models.retrieve.image", () => missingEnv(["RUNINFRA_API_KEY", "RUNINFRA_IMAGE_MODEL"])],
  ["models.retrieve.tts", () => missingEnv(["RUNINFRA_API_KEY", "RUNINFRA_TTS_MODEL"])],
  ["models.retrieve.asr", () => missingEnv(["RUNINFRA_API_KEY", "RUNINFRA_ASR_MODEL"])],
  ["chat.completions.create", () => missingEnv(["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"])],
  ["openai.params.chat.completions", () => missingEnv(["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"])],
  // Child canaries validate stream_options.include_usage without recording token counts.
  ["openai.params.chat.stream_options", () => missingEnv(["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"])],
  ["chat.completions.stream.final", () => missingEnv(["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"])],
  ["chat.completions.stream.cancel", () => missingEnv(["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"])],
  ["chat.completions.stream.slow_consumer", () => [
    ...missingEnv(["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"]),
    ...optionalNonNegativeIntegerRequirement("RUNINFRA_CANARY_STREAM_SLOW_CONSUMER_DELAY_MS"),
  ]],
  ["chat.completions.stream.malformed_frame.local", () => []],
  ["chat.completions.stream.disconnect.local", () => []],
  ["chat.completions.stream.stalled_read.local", () => []],
  ["responses.create", () => missingEnv(["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"])],
  ["openai.params.responses", () => missingEnv(["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"])],
  ["responses.stream.final", () => missingEnv(["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"])],
  ["responses.stream.cancel", () => missingEnv(["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"])],
  ["responses.stream.slow_consumer", () => [
    ...missingEnv(["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"]),
    ...optionalNonNegativeIntegerRequirement("RUNINFRA_CANARY_STREAM_SLOW_CONSUMER_DELAY_MS"),
  ]],
  ["responses.stream.malformed_frame.local", () => []],
  ["responses.stream.disconnect.local", () => []],
  ["responses.stream.stalled_read.local", () => []],
  ["embeddings.create", () => missingEnv(["RUNINFRA_API_KEY", "RUNINFRA_EMBEDDING_MODEL"])],
  ["openai.params.embeddings", () => missingEnv(["RUNINFRA_API_KEY", "RUNINFRA_EMBEDDING_MODEL"])],
  ["error.embeddings.unsupported_dimensions", () => missingEnv(["RUNINFRA_API_KEY", "RUNINFRA_EMBEDDING_MODEL"])],
  ["images.generate", () => missingEnv(["RUNINFRA_API_KEY", "RUNINFRA_IMAGE_MODEL"])],
  ["openai.params.images", () => [
    ...missingEnv(["RUNINFRA_API_KEY", "RUNINFRA_IMAGE_MODEL", "RUNINFRA_IMAGE_SIZE"]),
    ...imageResponseFormatRequirement(),
  ]],
  ["audio.speech.create", speechRequirements],
  ["openai.params.audio.speech", () => [
    ...speechRequirements(),
    ...ttsResponseFormatRequirement(),
  ]],
  ["audio.speech.binary_interfaces", speechRequirements],
  ["audio.transcriptions.create", () => [
    ...missingEnv(["RUNINFRA_API_KEY", "RUNINFRA_ASR_MODEL", "RUNINFRA_ASR_EXPECTED_TEXT"]),
    ...readableNonEmptyFileRequirement("RUNINFRA_ASR_FIXTURE_PATH"),
  ]],
  ["openai.params.audio.transcriptions", () => [
    ...missingEnv(["RUNINFRA_API_KEY", "RUNINFRA_ASR_MODEL", "RUNINFRA_ASR_LANGUAGE", "RUNINFRA_ASR_EXPECTED_TEXT"]),
    ...asrResponseFormatRequirement(),
    ...readableNonEmptyFileRequirement("RUNINFRA_ASR_FIXTURE_PATH"),
  ]],
  ["voice.pipeline.create", voiceRequirements],
  ["error.auth.invalid_key", () => []],
  ["error.model.not_found", () => missingEnv(["RUNINFRA_API_KEY"])],
  ["error.request.invalid_options", () => []],
  ["error.insufficient_credits.local", () => []],
  ["error.rate_limit.local", () => []],
  ["request.client_request_id.local", () => []],
  ["request.custom_headers.local", () => []],
  ["request.timeout.local", () => []],
  ["request.extra_body.local", () => []],
  ["request.unknown_fields.local", () => []],
  ["browser.api_key_guard.local", () => []],
  ["security.api_key_redaction.local", () => []],
  ["error.body.unsupported_parameter", () => missingEnv(["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"])],
  ["retry.safety.get.local", () => []],
  ["retry.safety.post.requires_idempotency.local", () => []],
  ["retry.safety.post.with_idempotency.local", () => []],
  ["retry.safety.post.non_replayable_json.no_retry.local", () => []],
  ["retry.safety.stream.no_retry.local", () => []],
  ["retry.safety.audio_binary.no_retry.local", () => []],
  ["retry.safety.audio_multipart.no_retry.local", () => []],
  ["retry.safety.voice_binary.no_retry.local", () => []],
  ["webhooks.delivery_surface.absent", () => []],
  ["webhooks.verify_signature.local", () => []],
  ["webhooks.construct_event.local", () => []],
  ["webhooks.verify_signature.export", () => []],
  ["webhooks.construct_event.export", () => []],
  ["idempotency.replay.responses", () => [
    ...missingEnv(["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"]),
    ...(env("RUNINFRA_CANARY_ENABLE_IDEMPOTENCY") === "1" ? [] : ["RUNINFRA_CANARY_ENABLE_IDEMPOTENCY=1"]),
    ...optionalIdempotencyEvidenceFieldRequirement(),
  ]],
];

function buildReadiness() {
  const globalMissing = [
    ...optionalCanaryTimeoutRequirement(),
    ...optionalChildCanaryTimeoutRequirement(),
    ...optionalBaseURLRequirement(),
  ];
  const rows = rowReadinessRequirements.map(([name, requirements]) => {
    const missing = [...globalMissing, ...requirements()];
    return {
      name,
      status: missing.length ? "blocked" : "ready",
      missing,
    };
  });
  const rowCoverageErrors = readinessRowCoverageErrors(expectedRows, rows.map((row) => row.name));
  const missing = [...new Set([...globalMissing, ...rowCoverageErrors, ...rows.flatMap((row) => row.missing)])].sort();
  return {
    status: missing.length ? "blocked" : "ready",
    env: redactedEnv(relevantEnv),
    aliases: redactedEnvAliases(relevantEnv),
    missing,
    rowCoverageErrors,
    summary: {
      ready: rows.filter((row) => row.status === "ready").length,
      blocked: rows.filter((row) => row.status === "blocked").length,
    },
    rows,
  };
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

function readRepoText(...segments) {
  return readFileSync(join(repositoryRoot, ...segments), "utf8");
}

function extractTypeScriptClassBlock(source, className) {
  const classStart = source.indexOf(`export class ${className}`);
  if (classStart === -1) return "";
  const openBrace = source.indexOf("{", classStart);
  if (openBrace === -1) return "";
  let depth = 0;
  for (let index = openBrace; index < source.length; index += 1) {
    const char = source[index];
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) return source.slice(openBrace + 1, index);
    }
  }
  return "";
}

function extractTypeScriptClientSurfaces(source) {
  const classStart = source.indexOf("export class RunInfra {");
  const publicEnd = source.indexOf("  private readonly apiKey", classStart);
  if (classStart === -1 || publicEnd === -1) return [];
  const lines = source.slice(classStart, publicEnd).split(/\r?\n/u);
  const stack = [];
  const surfaces = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const blockMatch = trimmed.match(/^(?:readonly\s+)?([A-Za-z_]\w*):\s*\{\s*$/u);
    if (blockMatch) {
      stack.push(blockMatch[1]);
      continue;
    }
    const leafMatch = trimmed.match(/^([A-Za-z_]\w*):\s*(?:typeof\s+[A-Za-z_]\w+|[A-Za-z_]\w+|.*=>.*);$/u);
    if (leafMatch && stack.length) {
      surfaces.push(`client.${[...stack, leafMatch[1]].join(".")}`);
      continue;
    }
    if (trimmed === "};") {
      stack.pop();
    }
  }
  return surfaces;
}

function extractTypeScriptMethodSurfaces(source) {
  const surfaces = [];
  const audioBlock = extractTypeScriptClassBlock(source, "RunInfraAudioResponse");
  for (const match of audioBlock.matchAll(/^\s{2}([A-Za-z_]\w*)\([^)]*\):/gmu)) {
    if (match[1] !== "constructor" && match[1] !== "readBody") {
      surfaces.push(`RunInfraAudioResponse.${match[1]}`);
    }
  }
  const streamBlock = extractTypeScriptClassBlock(source, "RunInfraStream");
  if (streamBlock.includes("[Symbol.asyncIterator]") || source.includes("[Symbol.asyncIterator]")) {
    surfaces.push("RunInfraStream[Symbol.asyncIterator]");
  }
  if (/^export function verifyWebhookSignature\(/mu.test(source)) surfaces.push("verifyWebhookSignature");
  if (/^export function constructWebhookEvent</mu.test(source)) surfaces.push("constructWebhookEvent");
  return surfaces;
}

const pythonClassSurfacePrefixes = new Map([
  ["_ChatCompletions", "client.chat.completions"],
  ["_Responses", "client.responses"],
  ["_Embeddings", "client.embeddings"],
  ["_Speech", "client.audio.speech"],
  ["_Transcriptions", "client.audio.transcriptions"],
  ["_Models", "client.models"],
  ["_Images", "client.images"],
  ["_Webhooks", "client.webhooks"],
  ["_VoicePipeline", "client.voice.pipeline"],
]);

function extractPythonClassBlock(source, className) {
  const lines = source.split(/\r?\n/u);
  const start = lines.findIndex((line) => line === `class ${className}:`);
  if (start === -1) return "";
  const body = [];
  for (let index = start + 1; index < lines.length; index += 1) {
    if (/^(class|def)\s/u.test(lines[index])) break;
    body.push(lines[index]);
  }
  return body.join("\n");
}

function extractPythonPublicSurfaces(source) {
  const surfaces = [];
  for (const [className, prefix] of pythonClassSurfacePrefixes.entries()) {
    const block = extractPythonClassBlock(source, className);
    for (const match of block.matchAll(/^    def ([A-Za-z_]\w*)\(/gmu)) {
      if (match[1] !== "__init__") surfaces.push(`${prefix}.${match[1]}`);
    }
  }
  if (extractPythonClassBlock(source, "RunInfraStream").includes("def __iter__(")) {
    surfaces.push("RunInfraStream.__iter__");
  }
  if (/^def verify_webhook_signature\(/mu.test(source)) surfaces.push("verify_webhook_signature");
  if (/^def construct_webhook_event\(/mu.test(source)) surfaces.push("construct_webhook_event");
  return surfaces;
}

function extractReadmeRouteSurfaces(markdown) {
  const sectionStart = markdown.indexOf("## Supported public routes");
  if (sectionStart === -1) return [];
  const nextSection = markdown.indexOf("\n## ", sectionStart + 1);
  const section = markdown.slice(sectionStart, nextSection === -1 ? markdown.length : nextSection);
  return [...section.matchAll(/^- `([^`]+)\(\)`/gmu)]
    .map((match) => `client.${match[1]}`);
}

function declaredPublicSurfaces() {
  const tsSource = readRepoText("typescript", "src", "index.ts");
  const pySource = readRepoText("python", "runinfra", "__init__.py");
  return sortedUnique([
    ...extractTypeScriptClientSurfaces(tsSource),
    ...extractTypeScriptMethodSurfaces(tsSource),
    ...extractPythonPublicSurfaces(pySource),
    ...extractReadmeRouteSurfaces(readRepoText("typescript", "README.md")),
    ...extractReadmeRouteSurfaces(readRepoText("python", "README.md")),
  ]);
}

function buildSurfaceCoverage() {
  const expectedRowSet = new Set(expectedRows);
  const errors = [];
  const seen = new Set();
  const coveredRows = new Set();
  const manifestSurfaces = publicSurfaceCoverage.map((entry) => entry.surface);
  const manifestSurfaceSet = new Set(manifestSurfaces);
  const declaredSurfaces = declaredPublicSurfaces();
  const uncoveredSurfaces = declaredSurfaces.filter((surface) => !manifestSurfaceSet.has(surface));
  for (const surface of uncoveredSurfaces) {
    errors.push(`public surface missing canary row coverage: ${surface}`);
  }
  for (const entry of publicSurfaceCoverage) {
    if (seen.has(entry.surface)) {
      errors.push(`duplicate public surface coverage entry: ${entry.surface}`);
    }
    seen.add(entry.surface);
    if (!Array.isArray(entry.rows) || entry.rows.length === 0) {
      errors.push(`${entry.surface} has no canary rows`);
      continue;
    }
    for (const row of entry.rows) {
      coveredRows.add(row);
      if (!expectedRowSet.has(row)) {
        errors.push(`${entry.surface} references unknown canary row: ${row}`);
      }
    }
  }
  const uncoveredRows = expectedRows.filter((row) => !coveredRows.has(row));
  for (const row of uncoveredRows) {
    errors.push(`canonical canary row missing public surface coverage: ${row}`);
  }
  return {
    status: errors.length ? "failed" : "passed",
    errors,
    declaredSurfaceCount: declaredSurfaces.length,
    declaredSurfaces,
    uncoveredSurfaces,
    uncoveredRows,
    surfaceCount: publicSurfaceCoverage.length,
    rowCount: expectedRows.length,
    surfaces: manifestSurfaces,
  };
}

function writeReport(report) {
  if (!reportPath) return;
  const absolute = resolve(reportPath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(report, null, 2)}\n`);
}

function cleanupTempDir() {
  rmSync(tempDir, { recursive: true, force: true });
  try {
    if (existsSync(tempRoot) && readdirSync(tempRoot).length === 0) {
      rmdirSync(tempRoot);
    }
  } catch {
    // Another concurrent canary process may still be using the temp root.
  }
}

function sha256File(filePath, label) {
  try {
    return createHash("sha256").update(readFileSync(filePath)).digest("hex");
  } catch {
    throw new Error(`candidate file missing or unreadable: ${label}`);
  }
}

function sourceDigestSha256() {
  const digest = createHash("sha256");
  for (const [label, filePath] of sourceDigestFiles) {
    digest.update(label);
    digest.update("\0");
    digest.update(readFileForDigest(filePath, label));
    digest.update("\0");
  }
  return digest.digest("hex");
}

function readFileForDigest(filePath, label) {
  try {
    return readFileSync(filePath);
  } catch {
    throw new Error(`candidate source file missing or unreadable: ${label}`);
  }
}

function baseCandidateIdentity(fields = {}) {
  return {
    sdkVersion: expectedSdkVersion,
    packageSource,
    sourceDigestSha256: sourceDigestSha256(),
    sourceFileCount: sourceDigestFiles.length,
    artifactDigestsChecked: false,
    artifacts: [],
    ...fields,
  };
}

function artifactCandidateIdentity(npmArtifact, pythonWheel, pythonSdist) {
  return baseCandidateIdentity({
    artifactDigestsChecked: true,
    artifacts: [
      {
        name: "npm",
        fileName: basename(npmArtifact),
        sha256: sha256File(npmArtifact, "npm artifact"),
      },
      {
        name: "pythonWheel",
        fileName: basename(pythonWheel),
        sha256: sha256File(pythonWheel, "Python wheel"),
      },
      {
        name: "pythonSdist",
        fileName: basename(pythonSdist),
        sha256: sha256File(pythonSdist, "Python sdist"),
      },
    ],
  });
}

function surfaceCoverageFailureReport(errors, fields = {}) {
  const surfaceCoverage = buildSurfaceCoverage();
  const combined = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    strict,
    packageSource,
    candidate: baseCandidateIdentity(),
    expectedRows,
    ...fields,
    surfaceCoverage,
    parity: {
      status: "failed",
      errors: [...new Set([...surfaceCoverage.errors, ...errors])],
    },
    reports: [],
  };
  try {
    assertReportDoesNotLeak(combined);
  } catch (error) {
    cleanupTempDir();
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  try {
    writeReport(combined);
  } catch (error) {
    cleanupTempDir();
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  return combined;
}

function discoveryEnvReport() {
  return redactedEnv(["RUNINFRA_API_KEY", "RUNINFRA_BASE_URL"]);
}

function discoveryBaseURL() {
  return env("RUNINFRA_BASE_URL") ?? productionBaseURL;
}

function redactedDiscoveryBaseURL() {
  const baseURL = discoveryBaseURL();
  return reportBaseURL(baseURL, Boolean(env("RUNINFRA_BASE_URL")));
}

function canaryTimeoutMs() {
  return Math.ceil(Number(env("RUNINFRA_CANARY_TIMEOUT_SECONDS") ?? "120") * 1000);
}

function childCanaryTimeoutMs() {
  return Math.ceil(Number(env("RUNINFRA_CANARY_CHILD_TIMEOUT_SECONDS") ?? String(defaultChildCanaryTimeoutSeconds)) * 1000);
}

function modelDiscoveryReport(discovery) {
  return {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    strict,
    packageSource,
    candidate: baseCandidateIdentity(),
    discovery,
    reports: [],
  };
}

async function fetchModelCatalogForDiscovery(baseURL) {
  const url = new URL(`${baseURL.replace(/\/+$/u, "")}/models`);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), canaryTimeoutMs());
  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${env("RUNINFRA_API_KEY")}`,
        Accept: "application/json",
        "X-RunInfra-SDK": "live-canary-model-discovery",
        "X-RunInfra-SDK-Version": expectedSdkVersion,
      },
    });
    if (!response.ok) {
      return {
        ok: false,
        requestId: response.headers.get("x-request-id") ?? undefined,
        error: `models.list status ${response.status}`,
      };
    }
    let body;
    try {
      body = await response.json();
    } catch (error) {
      return {
        ok: false,
        requestId: response.headers.get("x-request-id") ?? undefined,
        error: error instanceof Error && error.name === "AbortError"
          ? "models.list timed out"
          : "models.list returned non-json body",
      };
    }
    if (!body || typeof body !== "object" || !Array.isArray(body.data)) {
      return {
        ok: false,
        requestId: response.headers.get("x-request-id") ?? undefined,
        error: "models.list response missing data array",
      };
    }
    return {
      ok: true,
      requestId: response.headers.get("x-request-id") ?? undefined,
      models: body.data,
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error && error.name === "AbortError"
        ? "models.list timed out"
        : "models.list request failed",
    };
  } finally {
    clearTimeout(timeout);
  }
}

async function runModelDiscovery() {
  const missing = [
    ...missingEnv(["RUNINFRA_API_KEY"]),
    ...optionalCanaryTimeoutRequirement(),
    ...optionalBaseURLRequirement(),
  ];
  let discovery;
  if (missing.length) {
    discovery = buildBlockedModelDiscoveryReport({
      baseURL: redactedDiscoveryBaseURL(),
      env: discoveryEnvReport(),
      missing,
    });
  } else {
    const catalog = await fetchModelCatalogForDiscovery(discoveryBaseURL());
    discovery = catalog.ok
      ? buildModelDiscoveryReport({
        baseURL: redactedDiscoveryBaseURL(),
        models: catalog.models,
        requestId: catalog.requestId,
      })
      : buildFailedModelDiscoveryReport({
        baseURL: redactedDiscoveryBaseURL(),
        env: discoveryEnvReport(),
        error: catalog.error,
      });
  }
  const combined = modelDiscoveryReport(discovery);
  try {
    assertReportDoesNotLeak(combined);
    writeReport(combined);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  console.log(JSON.stringify({
    discovery: discovery.status,
    catalog: discovery.catalog,
  }, null, 2));
  process.exit(discovery.status === "completed" ? 0 : 1);
}

if (discoverModels) {
  await runModelDiscovery();
}

if (verifySurfaceCoverage) {
  const surfaceCoverage = buildSurfaceCoverage();
  try {
    assertReportDoesNotLeak(surfaceCoverage);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  console.log(JSON.stringify(surfaceCoverage, null, 2));
  process.exit(surfaceCoverage.status === "passed" ? 0 : 1);
}

if (preflight) {
  const readiness = buildReadiness();
  const surfaceCoverage = buildSurfaceCoverage();
  const combined = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    strict,
    packageSource,
    candidate: baseCandidateIdentity(),
    expectedRows,
    readiness,
    surfaceCoverage,
    parity: {
      status: surfaceCoverage.status === "passed" ? "not_run" : "failed",
      errors: surfaceCoverage.errors,
    },
    reports: [],
  };
  try {
    assertReportDoesNotLeak(combined);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  writeReport(combined);
  console.log(JSON.stringify({ readiness: readiness.status, summary: readiness.summary }, null, 2));
  process.exit((strict && readiness.status !== "ready") || surfaceCoverage.status !== "passed" ? 1 : 0);
}

function configurationErrors() {
  return [
    ...optionalCanaryTimeoutRequirement(),
    ...optionalChildCanaryTimeoutRequirement(),
    ...optionalBaseURLRequirement(),
    ...optionalNonNegativeIntegerRequirement("RUNINFRA_CANARY_STREAM_SLOW_CONSUMER_DELAY_MS"),
    ...optionalIdempotencyEvidenceFieldRequirement(),
  ];
}

const configErrors = configurationErrors();
if (configErrors.length) {
  const combined = surfaceCoverageFailureReport(configErrors, { env: redactedEnv(relevantEnv) });
  console.error(`Live canary configuration invalid:\n${combined.parity.errors.join("\n")}`);
  process.exit(1);
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
  if (!matches.length) throw new Error(`${label} not found. Build package artifacts first.`);
  return matches[0].path;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function readExpectedSdkVersion() {
  const packageJson = JSON.parse(readFileSync(join(repositoryRoot, "typescript", "package.json"), "utf8"));
  if (typeof packageJson.version !== "string" || !packageJson.version.trim()) {
    throw new Error("typescript/package.json is missing a package version.");
  }
  return packageJson.version;
}

function expectedNpmArtifact() {
  return resolve(newestMatching(
    "typescript",
    new RegExp(`^runinfra-sdk-${escapeRegExp(expectedSdkVersion)}\\.tgz$`, "u"),
    `npm artifact for SDK version ${expectedSdkVersion}`,
  ));
}

function expectedPythonWheel() {
  return resolve(newestMatching(
    "python/dist",
    new RegExp(`^runinfra-${escapeRegExp(expectedSdkVersion)}-.+\\.whl$`, "u"),
    `Python wheel for SDK version ${expectedSdkVersion}`,
  ));
}

function expectedPythonSdist() {
  return resolve(newestMatching(
    "python/dist",
    new RegExp(`^runinfra-${escapeRegExp(expectedSdkVersion)}\\.tar\\.gz$`, "u"),
    `Python sdist for SDK version ${expectedSdkVersion}`,
  ));
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
    stdio: "pipe",
    encoding: "utf8",
    maxBuffer: 1024 * 1024 * 8,
    env: options.env ?? process.env,
    shell: false,
  });
  if (result.error || result.status !== 0) {
    throw new Error(`setup command failed${safeSetupOutputSummary(result)}`);
  }
}

function safeSetupOutputSummary(result) {
  const summary = [result.stderr, result.stdout]
    .filter((value) => typeof value === "string" && value.trim())
    .map((value) => redactSetupOutputTail(value))
    .filter(Boolean)
    .join("\n");
  return summary ? `: ${summary}` : "";
}

function redactSetupOutputTail(value) {
  return value
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(-5)
    .map((line) => line
      .replace(/[A-Z]:\\[^\s"'<>]+/giu, "[redacted-path]")
      .replace(/\/(?:Users|home)\/[^\s"'<>]+/giu, "[redacted-path]")
      .replace(/RightNow-Full/giu, "[redacted-path]")
    )
    .join(" | ");
}

function installArtifactCanaryPackages() {
  const npmDir = resolve(tempDir, "npm-consumer");
  const pythonDir = resolve(tempDir, "python-consumer");
  const venvDir = resolve(pythonDir, "venv");
  const npmArtifact = expectedNpmArtifact();
  const pythonWheel = expectedPythonWheel();
  const pythonSdist = expectedPythonSdist();
  const candidate = artifactCandidateIdentity(npmArtifact, pythonWheel, pythonSdist);
  resolvedArtifactCandidate = candidate;
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
    npmArtifact,
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
    pythonWheel,
  ], {
    cwd: pythonDir,
    env: {
      ...process.env,
      PIP_DISABLE_PIP_VERSION_CHECK: "1",
    },
  });

  return {
    python,
    candidate,
    env: {
      RUNINFRA_CANARY_TS_MODULE: resolve(npmDir, "node_modules", "@runinfra", "sdk", "dist", "index.js"),
      RUNINFRA_CANARY_PYTHON_IMPORT_MODE: "installed",
    },
  };
}

function run(label, command, commandArgs, envOverrides = {}) {
  const result = spawnSync(command, commandArgs, {
    stdio: "inherit",
    env: { ...process.env, ...canonicalEnvOverrides(), ...envOverrides },
    shell: false,
    timeout: childCanaryTimeoutMs(),
  });
  const timedOut = result.error?.code === "ETIMEDOUT";
  return { label, status: result.status ?? 1, timedOut };
}

function canonicalEnvOverrides(names = relevantEnv) {
  const overrides = {};
  for (const name of names) {
    if (rawEnv(name)) continue;
    for (const alias of canonicalEnvAliases.get(name) ?? []) {
      const value = rawEnv(alias);
      if (value) {
        overrides[name] = value;
        break;
      }
    }
  }
  return overrides;
}

mkdirSync(tempDir, { recursive: true });

const commonArgs = strict ? ["--strict"] : [];
let artifactRuntime = {
  python: optionValue("--python") ?? "python",
  candidate: baseCandidateIdentity(),
  env: {},
};
try {
  if (packageSource === "artifact") {
    artifactRuntime = installArtifactCanaryPackages();
  }
} catch (error) {
  const errorMessage = error instanceof Error
    ? `artifact canary package setup failed: ${error.message}`
    : "artifact canary package setup failed";
  surfaceCoverageFailureReport([errorMessage], resolvedArtifactCandidate ? { candidate: resolvedArtifactCandidate } : {});
  cleanupTempDir();
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
    const childRun = runs.find((run) => run.label === language);
    reports.push({
      language,
      status: "missing",
      error: childRun?.timedOut ? "child canary timed out" : "child report missing or unreadable",
    });
  }
}

function reportRowErrors(report) {
  if (!report || typeof report !== "object" || !Array.isArray(report.results)) {
    return [`${report?.language ?? "unknown"} report missing results`];
  }
  const language = String(report.language ?? "unknown");
  const errors = [];
  if (report.sdkVersion !== expectedSdkVersion) {
    errors.push(`${language} SDK version ${String(report.sdkVersion ?? "missing")} != ${expectedSdkVersion}`);
  }
  if (report.strict !== strict) {
    errors.push(`${language} child report strict ${String(report.strict ?? "missing")} != ${strict}`);
  }
  const expectedBaseURL = reportBaseURL(env("RUNINFRA_BASE_URL") ?? productionBaseURL, Boolean(rawEnv("RUNINFRA_BASE_URL")));
  if (report.baseURL !== expectedBaseURL) {
    errors.push(`${language} child report baseURL ${String(report.baseURL ?? "missing")} != ${expectedBaseURL}`);
  }
  const names = report.results.map((result) => result.name);
  const unique = new Set(names);
  const missing = expectedRows.filter((row) => !unique.has(row));
  const unexpected = names.filter((row) => !expectedRows.includes(row));
  const duplicates = names.filter((row, index) => names.indexOf(row) !== index);
  if (names.length !== unique.size) errors.push(`${language} duplicate rows: ${[...new Set(duplicates)].join(", ")}`);
  if (missing.length) errors.push(`${language} missing rows: ${missing.join(", ")}`);
  if (unexpected.length) errors.push(`${language} unexpected rows: ${unexpected.join(", ")}`);
  if (names.length !== expectedRows.length) errors.push(`${language} row count ${names.length} != ${expectedRows.length}`);
  if (!sameStringArray(names, expectedRows)) {
    errors.push(`${language} child report rows must exactly match expectedRows`);
  }
  const counts = { passed: 0, failed: 0, skipped: 0 };
  for (const result of report.results) {
    if (result?.status === "passed" || result?.status === "failed" || result?.status === "skipped") {
      counts[result.status] += 1;
    } else {
      errors.push(`${language} row ${String(result?.name ?? "<unknown>")} has invalid status`);
    }
    if (result?.status === "failed" || (strict && result?.status !== "passed")) {
      errors.push(`${language} row ${String(result?.name ?? "<unknown>")} must be passed`);
    }
  }
  if (!report.summary || typeof report.summary !== "object") {
    errors.push(`${language} summary must be present`);
  } else {
    if (report.summary.passed !== counts.passed) {
      errors.push(`${language} summary passed count must match passed rows`);
    }
    if (report.summary.failed !== counts.failed) {
      errors.push(`${language} summary failed count must match failed rows`);
    }
    if (report.summary.skipped !== counts.skipped) {
      errors.push(`${language} summary skipped count must match skipped rows`);
    }
    if (strict && report.summary.passed !== expectedRows.length) {
      errors.push(`${language} summary passed count must be ${expectedRows.length}`);
    }
    if (strict && report.summary.failed !== 0) errors.push(`${language} summary failed count must be 0`);
    if (strict && report.summary.skipped !== 0) errors.push(`${language} summary skipped count must be 0`);
  }
  return errors;
}

function sameStringArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function sensitiveEnvValues() {
  return Object.entries(process.env)
    .filter(([name, value]) =>
      typeof value === "string" &&
      value.length >= 8 &&
      /(API[_-]?KEY|TOKEN|SECRET|PASSWORD|NPM|PYPI|TWINE)/iu.test(name)
    )
    .map(([, value]) => value);
}

function assertReportDoesNotLeak(report) {
  const serialized = JSON.stringify(report);
  const matchedPattern = findForbiddenContent(serialized);
  if (matchedPattern) {
    throw new Error(`live canary report contains forbidden content: ${matchedPattern.label}`);
  }
  const leakedEnvValue = sensitiveEnvValues().find((value) => serialized.includes(value));
  if (leakedEnvValue) {
    throw new Error("live canary report contains a sensitive environment value");
  }
}

const surfaceCoverage = buildSurfaceCoverage();
const parityErrors = [
  ...surfaceCoverage.errors,
  ...runs.filter((run) => run.timedOut).map((run) => `${run.label} child canary timed out`),
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
  candidate: artifactRuntime.candidate,
  expectedRows,
  surfaceCoverage,
  parity: {
    status: parityErrors.length ? "failed" : "passed",
    errors: parityErrors,
  },
  reports,
};

try {
  assertReportDoesNotLeak(combined);
  if (reportPath) {
    const absolute = resolve(reportPath);
    mkdirSync(dirname(absolute), { recursive: true });
    writeFileSync(absolute, `${JSON.stringify(combined, null, 2)}\n`);
  }
} catch (error) {
  cleanupTempDir();
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
}

cleanupTempDir();

const failed = runs.filter((run) => run.status !== 0);
if (failed.length || parityErrors.length) {
  if (failed.length) console.error(`Live canary failures: ${failed.map((run) => run.label).join(", ")}`);
  if (parityErrors.length) console.error(`Live canary parity failures:\n${parityErrors.join("\n")}`);
  process.exit(1);
}

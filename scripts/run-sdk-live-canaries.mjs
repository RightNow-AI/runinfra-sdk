#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { findForbiddenContent } from "./secret-scan-policy.mjs";

const args = process.argv.slice(2);
const strict = args.includes("--strict");
const preflight = args.includes("--preflight");
const verifySurfaceCoverage = args.includes("--verify-surface-coverage");
const reportPath = optionValue("--report");
const packageSource = optionValue("--package-source") ?? "artifact";
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const tempDir = resolve(".canary-tmp", `${Date.now()}-${process.pid}`);
const tsReport = resolve(tempDir, "typescript.json");
const pyReport = resolve(tempDir, "python.json");
const expectedRows = [
  "models.list",
  "models.retrieve.llm",
  "chat.completions.create",
  "openai.params.chat.completions",
  "openai.params.chat.stream_options",
  "chat.completions.stream.final",
  "chat.completions.stream.cancel",
  "chat.completions.stream.slow_consumer",
  "chat.completions.stream.malformed_frame.local",
  "chat.completions.stream.disconnect.local",
  "chat.completions.stream.stalled_read.local",
  "responses.create",
  "openai.params.responses",
  "responses.stream.final",
  "responses.stream.cancel",
  "responses.stream.slow_consumer",
  "responses.stream.malformed_frame.local",
  "responses.stream.disconnect.local",
  "responses.stream.stalled_read.local",
  "embeddings.create",
  "openai.params.embeddings",
  "images.generate",
  "openai.params.images",
  "audio.speech.create",
  "openai.params.audio.speech",
  "audio.speech.binary_interfaces",
  "audio.transcriptions.create",
  "openai.params.audio.transcriptions",
  "voice.pipeline.create",
  "error.auth.invalid_key",
  "error.model.not_found",
  "error.request.invalid_options",
  "error.body.unsupported_parameter",
  "retry.safety.get.local",
  "retry.safety.post.requires_idempotency.local",
  "retry.safety.post.with_idempotency.local",
  "retry.safety.stream.no_retry.local",
  "retry.safety.audio_binary.no_retry.local",
  "retry.safety.audio_multipart.no_retry.local",
  "webhooks.delivery_surface.absent",
  "webhooks.verify_signature.local",
  "webhooks.construct_event.local",
  "webhooks.verify_signature.export",
  "webhooks.construct_event.export",
  "idempotency.replay.responses",
];

const publicSurfaceCoverage = [
  { surface: "client.models.list", rows: ["models.list", "retry.safety.get.local"] },
  { surface: "client.models.retrieve", rows: ["models.retrieve.llm", "error.model.not_found"] },
  {
    surface: "client.chat.completions.create",
    rows: [
      "chat.completions.create",
      "openai.params.chat.completions",
      "openai.params.chat.stream_options",
      "chat.completions.stream.final",
      "chat.completions.stream.cancel",
      "chat.completions.stream.slow_consumer",
      "chat.completions.stream.malformed_frame.local",
      "chat.completions.stream.disconnect.local",
      "chat.completions.stream.stalled_read.local",
      "retry.safety.stream.no_retry.local",
    ],
  },
  {
    surface: "client.responses.create",
    rows: [
      "responses.create",
      "openai.params.responses",
      "responses.stream.final",
      "responses.stream.cancel",
      "responses.stream.slow_consumer",
      "responses.stream.malformed_frame.local",
      "responses.stream.disconnect.local",
      "responses.stream.stalled_read.local",
      "retry.safety.post.requires_idempotency.local",
      "retry.safety.post.with_idempotency.local",
      "idempotency.replay.responses",
    ],
  },
  { surface: "client.embeddings.create", rows: ["embeddings.create", "openai.params.embeddings"] },
  { surface: "client.images.generate", rows: ["images.generate", "openai.params.images"] },
  {
    surface: "client.audio.speech.create",
    rows: [
      "audio.speech.create",
      "openai.params.audio.speech",
      "audio.speech.binary_interfaces",
      "retry.safety.audio_binary.no_retry.local",
    ],
  },
  { surface: "RunInfraAudioResponse.arrayBuffer", rows: ["audio.speech.create", "audio.speech.binary_interfaces"] },
  { surface: "RunInfraAudioResponse.blob", rows: ["audio.speech.binary_interfaces"] },
  { surface: "RunInfraAudioResponse.stream", rows: ["audio.speech.binary_interfaces"] },
  {
    surface: "RunInfraStream[Symbol.asyncIterator]",
    rows: [
      "chat.completions.stream.final",
      "chat.completions.stream.cancel",
      "chat.completions.stream.slow_consumer",
      "chat.completions.stream.malformed_frame.local",
      "chat.completions.stream.disconnect.local",
      "chat.completions.stream.stalled_read.local",
      "responses.stream.final",
      "responses.stream.cancel",
      "responses.stream.slow_consumer",
      "responses.stream.malformed_frame.local",
      "responses.stream.disconnect.local",
      "responses.stream.stalled_read.local",
    ],
  },
  {
    surface: "RunInfraStream.__iter__",
    rows: [
      "chat.completions.stream.final",
      "chat.completions.stream.cancel",
      "chat.completions.stream.slow_consumer",
      "chat.completions.stream.malformed_frame.local",
      "chat.completions.stream.disconnect.local",
      "chat.completions.stream.stalled_read.local",
      "responses.stream.final",
      "responses.stream.cancel",
      "responses.stream.slow_consumer",
      "responses.stream.malformed_frame.local",
      "responses.stream.disconnect.local",
      "responses.stream.stalled_read.local",
    ],
  },
  {
    surface: "client.audio.transcriptions.create",
    rows: [
      "audio.transcriptions.create",
      "openai.params.audio.transcriptions",
      "retry.safety.audio_multipart.no_retry.local",
    ],
  },
  { surface: "client.voice.pipeline.create", rows: ["voice.pipeline.create"] },
  { surface: "client.webhooks.verifySignature", rows: ["webhooks.verify_signature.local"] },
  { surface: "client.webhooks.constructEvent", rows: ["webhooks.construct_event.local"] },
  { surface: "verifyWebhookSignature", rows: ["webhooks.verify_signature.export"] },
  { surface: "constructWebhookEvent", rows: ["webhooks.construct_event.export"] },
  { surface: "client.webhooks.verify_signature", rows: ["webhooks.verify_signature.local"] },
  { surface: "client.webhooks.construct_event", rows: ["webhooks.construct_event.local"] },
  { surface: "verify_webhook_signature", rows: ["webhooks.verify_signature.export"] },
  { surface: "construct_webhook_event", rows: ["webhooks.construct_event.export"] },
  { surface: "webhook delivery create/list absence", rows: ["webhooks.delivery_surface.absent"] },
  { surface: "request option validation", rows: ["error.request.invalid_options"] },
  { surface: "unsupported body parameter handling", rows: ["error.body.unsupported_parameter"] },
  { surface: "authentication error mapping", rows: ["error.auth.invalid_key"] },
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

function env(name) {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
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

const relevantEnv = [
  "RUNINFRA_API_KEY",
  "RUNINFRA_BASE_URL",
  "RUNINFRA_CANARY_TIMEOUT_SECONDS",
  "RUNINFRA_CANARY_STREAM_SLOW_CONSUMER_DELAY_MS",
  "RUNINFRA_LLM_MODEL",
  "RUNINFRA_EMBEDDING_MODEL",
  "RUNINFRA_EMBEDDING_DIMENSIONS",
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
  "TEST_PIPELINE_ID",
  "RUNINFRA_VOICE_PIPELINE_ID",
  "RUNINFRA_VOICE_PIPELINE_API_KEY",
  "RUNINFRA_VOICE_PIPELINE_AUDIO_PATH",
  "RUNINFRA_VOICE_PIPELINE_AUDIO_CONTENT_TYPE",
  "RUNINFRA_VOICE_PIPELINE_EXPECTED_TEXT",
  "RUNINFRA_CANARY_ENABLE_IDEMPOTENCY",
  "RUNINFRA_CANARY_IDEMPOTENCY_EVIDENCE_FIELD",
];
const ttsResponseFormats = ["mp3", "opus", "aac", "flac", "wav", "pcm"];

function missingEnv(names) {
  return names.filter((name) => !env(name));
}

function positiveIntegerRequirement(name) {
  const value = env(name);
  if (!value) return [name];
  return /^[1-9][0-9]*$/u.test(value) ? [] : [`${name} positive integer`];
}

function optionalPositiveNumberRequirement(name) {
  const value = env(name);
  if (!value) return [];
  const parsed = Number(value);
  if (
    !/^(?:[1-9][0-9]*|0\.[0-9]*[1-9][0-9]*|[1-9][0-9]*\.[0-9]+)$/u.test(value) ||
    !Number.isFinite(parsed) ||
    parsed <= 0
  ) {
    return [`${name} positive finite number`];
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
  ["openai.params.embeddings", () => [
    ...missingEnv(["RUNINFRA_API_KEY", "RUNINFRA_EMBEDDING_MODEL"]),
    ...positiveIntegerRequirement("RUNINFRA_EMBEDDING_DIMENSIONS"),
  ]],
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
  ["error.body.unsupported_parameter", () => missingEnv(["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"])],
  ["retry.safety.get.local", () => []],
  ["retry.safety.post.requires_idempotency.local", () => []],
  ["retry.safety.post.with_idempotency.local", () => []],
  ["retry.safety.stream.no_retry.local", () => []],
  ["retry.safety.audio_binary.no_retry.local", () => []],
  ["retry.safety.audio_multipart.no_retry.local", () => []],
  ["webhooks.delivery_surface.absent", () => []],
  ["webhooks.verify_signature.local", () => []],
  ["webhooks.construct_event.local", () => []],
  ["webhooks.verify_signature.export", () => []],
  ["webhooks.construct_event.export", () => []],
  ["idempotency.replay.responses", () => [
    ...missingEnv(["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"]),
    ...(env("RUNINFRA_CANARY_ENABLE_IDEMPOTENCY") === "1" ? [] : ["RUNINFRA_CANARY_ENABLE_IDEMPOTENCY=1"]),
  ]],
];

function buildReadiness() {
  const globalMissing = optionalPositiveNumberRequirement("RUNINFRA_CANARY_TIMEOUT_SECONDS");
  const rows = rowReadinessRequirements.map(([name, requirements]) => {
    const missing = [...globalMissing, ...requirements()];
    return {
      name,
      status: missing.length ? "blocked" : "ready",
      missing,
    };
  });
  const missing = [...new Set([...globalMissing, ...rows.flatMap((row) => row.missing)])].sort();
  return {
    status: missing.length ? "blocked" : "ready",
    env: redactedEnv(relevantEnv),
    missing,
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
      if (!expectedRowSet.has(row)) {
        errors.push(`${entry.surface} references unknown canary row: ${row}`);
      }
    }
  }
  return {
    status: errors.length ? "failed" : "passed",
    errors,
    declaredSurfaceCount: declaredSurfaces.length,
    declaredSurfaces,
    uncoveredSurfaces,
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

function surfaceCoverageFailureReport(errors, fields = {}) {
  const surfaceCoverage = buildSurfaceCoverage();
  const combined = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    strict,
    packageSource,
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
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
  writeReport(combined);
  return combined;
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
    ...optionalPositiveNumberRequirement("RUNINFRA_CANARY_TIMEOUT_SECONDS"),
    ...optionalNonNegativeIntegerRequirement("RUNINFRA_CANARY_STREAM_SLOW_CONSUMER_DELAY_MS"),
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
  surfaceCoverageFailureReport(["artifact canary package setup failed"]);
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
  surfaceCoverage,
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

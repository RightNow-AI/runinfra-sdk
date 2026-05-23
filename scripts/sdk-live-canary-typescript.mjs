#!/usr/bin/env node
import { createHmac } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const strict = args.includes("--strict");
const reportPath = optionValue("--report");

function optionValue(name) {
  const exact = args.find((arg) => arg.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
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

function nowIso() {
  return new Date().toISOString();
}

function durationMs(started) {
  return Math.round(performance.now() - started);
}

function errorSummary(error) {
  return {
    name: error?.name ?? "Error",
    type: safeDiagnosticToken(error?.type),
    status: error?.status,
    requestId: error?.requestId,
    message: "redacted",
  };
}

function safeDiagnosticToken(value) {
  if (typeof value !== "string") return undefined;
  return /^[a-zA-Z0-9_.:-]{1,80}$/u.test(value) ? value : "redacted";
}

function assertObject(value, label) {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${label} must be a JSON object`);
  }
  return value;
}

function assertArray(value, label) {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} must be a non-empty array`);
  }
}

function assertJsonArray(value, label) {
  if (!Array.isArray(value)) {
    throw new Error(`${label} must be an array`);
  }
}

function assertString(value, label) {
  if (typeof value !== "string" || !value) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertOptionalString(value, label) {
  if (value !== undefined && value !== null && typeof value !== "string") {
    throw new Error(`${label} must be a string when present`);
  }
}

function assertOptionalNumber(value, label) {
  if (value !== undefined && value !== null && typeof value !== "number") {
    throw new Error(`${label} must be a number when present`);
  }
}

function assertNonNegativeInteger(value, label) {
  if (typeof value !== "number" || !Number.isInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
}

function assertRequestId(value, label) {
  if (!value || typeof value !== "string") {
    throw new Error(`${label} did not expose x-request-id`);
  }
}

function assertClearUnsupportedParameterError(error, label) {
  if (!error || typeof error !== "object") throw error;
  if (error.status !== 400 && error.status !== 422) {
    throw new Error(`${label} expected a clear 400/422 validation error, got ${error.status ?? "unknown"}`);
  }
  const allowedTypes = new Set([
    "bad_request",
    "invalid_request",
    "invalid_request_error",
    "invalid_request_options",
    "unsupported_operation",
    "unsupported_parameter",
    "validation_error",
  ]);
  if (typeof error.type !== "string" || !allowedTypes.has(error.type)) {
    throw new Error(`${label} expected an invalid-parameter error type, got ${error.type ?? "unknown"}`);
  }
  assertRequestId(error.requestId, label);
  return { errorType: error.type, errorStatus: error.status, requestId: error.requestId };
}

function requiredPositiveIntegerEnv(name) {
  const value = env(name);
  if (!value) throw new Error(`${name} missing`);
  if (!/^[1-9][0-9]*$/u.test(value)) throw new Error(`${name} must be a positive integer`);
  return Number(value);
}

function assertChatCompletionEnvelope(response, label) {
  assertString(response.id, `${label}.id`);
  assertOptionalString(response.object, `${label}.object`);
  assertOptionalNumber(response.created, `${label}.created`);
  assertString(response.model, `${label}.model`);
  assertArray(response.choices, `${label}.choices`);
  const choice = assertObject(response.choices[0], `${label}.choices[0]`);
  assertOptionalNumber(choice.index, `${label}.choices[0].index`);
  const message = assertObject(choice.message, `${label}.choices[0].message`);
  assertString(message.role, `${label}.choices[0].message.role`);
  assertOptionalString(message.content, `${label}.choices[0].message.content`);
}

function assertChatStreamEnvelope(event, label) {
  assertOptionalString(event.id, `${label}.id`);
  assertOptionalString(event.object, `${label}.object`);
  assertOptionalNumber(event.created, `${label}.created`);
  assertOptionalString(event.model, `${label}.model`);
  assertArray(event.choices, `${label}.choices`);
  const choice = assertObject(event.choices[0], `${label}.choices[0]`);
  assertOptionalNumber(choice.index, `${label}.choices[0].index`);
  if (choice.delta !== undefined) assertObject(choice.delta, `${label}.choices[0].delta`);
}

function isChatStreamUsageEvent(event) {
  return Array.isArray(event?.choices) &&
    event.choices.length === 0 &&
    event.usage !== null &&
    typeof event.usage === "object";
}

function assertChatStreamUsageEvent(event, label) {
  assertOptionalString(event.id, `${label}.id`);
  assertOptionalString(event.object, `${label}.object`);
  assertOptionalNumber(event.created, `${label}.created`);
  assertOptionalString(event.model, `${label}.model`);
  if (!Array.isArray(event.choices) || event.choices.length !== 0) {
    throw new Error(`${label}.choices must be an empty array for a chat usage chunk`);
  }
  assertChatUsageObject(event.usage, `${label}.usage`);
}

function assertChatUsageObject(value, label) {
  const usage = assertObject(value, label);
  for (const field of ["prompt_tokens", "completion_tokens", "total_tokens"]) {
    assertNonNegativeInteger(usage[field], `${label}.${field}`);
  }
}

function assertResponsesEnvelope(response, label) {
  assertString(response.id, `${label}.id`);
  assertOptionalString(response.object, `${label}.object`);
  assertOptionalString(response.status, `${label}.status`);
  if (!response.output_text && !Array.isArray(response.output)) {
    throw new Error(`${label} missing output_text or output array`);
  }
}

function assertResponsesStreamEnvelope(event, label) {
  if (typeof event.type !== "string" && typeof event.status !== "string" && typeof event?.response?.status !== "string") {
    throw new Error(`${label} missing semantic response stream type/status`);
  }
}

function assertEmbeddingsEnvelope(response, label) {
  assertOptionalString(response.object, `${label}.object`);
  assertArray(response.data, `${label}.data`);
  const first = assertObject(response.data[0], `${label}.data[0]`);
  assertOptionalString(first.object, `${label}.data[0].object`);
  assertOptionalNumber(first.index, `${label}.data[0].index`);
  if (!Array.isArray(first.embedding) || first.embedding.length === 0) {
    throw new Error(`${label}.data[0].embedding must be a non-empty array`);
  }
  if (!first.embedding.every((value) => typeof value === "number" && Number.isFinite(value))) {
    throw new Error(`${label}.data[0].embedding must contain finite numbers`);
  }
}

function assertImageEnvelope(response, label) {
  assertOptionalNumber(response.created, `${label}.created`);
  assertArray(response.data, `${label}.data`);
  const first = assertObject(response.data[0], `${label}.data[0]`);
  if (typeof first.url !== "string" && typeof first.b64_json !== "string") {
    throw new Error(`${label}.data[0] missing url or b64_json`);
  }
}

function assertImageOutputFormat(response, responseFormat, label) {
  const first = assertObject(response.data[0], `${label}.data[0]`);
  if (responseFormat === "url" && typeof first.url !== "string") {
    throw new Error(`${label}.data[0] missing requested url output`);
  }
  if (responseFormat === "b64_json" && typeof first.b64_json !== "string") {
    throw new Error(`${label}.data[0] missing requested b64_json output`);
  }
  if (responseFormat === "url" && typeof first.b64_json === "string") {
    throw new Error(`${label}.data[0] included b64_json despite requested url output`);
  }
  if (responseFormat === "b64_json" && typeof first.url === "string") {
    throw new Error(`${label}.data[0] included url despite requested b64_json output`);
  }
}

function assertAudioContentType(value, label) {
  assertString(value, `${label}.contentType`);
  if (value.toLowerCase().includes("json")) {
    throw new Error(`${label} returned JSON content type instead of binary audio`);
  }
}

function normalizedText(value) {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/gu, " ")
    .trim()
    .replace(/\s+/gu, " ");
}

function asrFixture() {
  const path = env("RUNINFRA_ASR_FIXTURE_PATH");
  if (!path) return null;
  const bytes = readFileSync(resolve(path));
  if (bytes.length === 0) throw new Error("ASR fixture was empty");
  return {
    bytes,
    filename: basename(path),
    contentType: env("RUNINFRA_ASR_FIXTURE_CONTENT_TYPE") ?? "audio/wav",
  };
}

function voicePipelineFixture() {
  const path = voicePipelineFixturePath();
  if (!path) return null;
  const bytes = readFileSync(resolve(path));
  if (bytes.length === 0) throw new Error("voice pipeline fixture was empty");
  return {
    bytes,
    contentType: firstEnv(
      "RUNINFRA_VOICE_PIPELINE_AUDIO_CONTENT_TYPE",
      "RUNINFRA_ASR_FIXTURE_CONTENT_TYPE",
    ) ?? "audio/wav",
  };
}

function voicePipelineFixturePath() {
  return firstEnv("RUNINFRA_VOICE_PIPELINE_AUDIO_PATH", "RUNINFRA_ASR_FIXTURE_PATH");
}

function voicePipelineExpectedText() {
  return firstEnv("RUNINFRA_VOICE_PIPELINE_EXPECTED_TEXT", "RUNINFRA_ASR_EXPECTED_TEXT");
}

function assertVoicePipelineExpectedText(response) {
  const expected = normalizedText(voicePipelineExpectedText());
  if (!expected) throw new Error("voice pipeline expected text missing");
  const fields = [
    "transcript",
    "text",
    "responseText",
    "response",
    "response_text",
    "outputText",
    "output_text",
  ];
  for (const field of fields) {
    const actual = normalizedText(getPathValue(response, field));
    if (actual && actual.includes(expected)) {
      return { textEvidenceField: field };
    }
  }
  throw new Error(`voice pipeline response did not include expected text in: ${fields.join(", ")}`);
}

async function readSomeStream(stream, label) {
  const events = [];
  for await (const event of stream) {
    events.push(assertObject(event, `${label} event`));
    if (events.length >= 3) break;
  }
  assertArray(events, `${label} events`);
  return events;
}

async function readFullStream(stream, label, hasTerminalEvent) {
  const events = [];
  for await (const event of stream) {
    events.push(assertObject(event, `${label} event`));
    if (events.length > 200) throw new Error(`${label} exceeded 200 events without ending`);
  }
  assertArray(events, `${label} events`);
  if (!events.some(hasTerminalEvent)) {
    throw new Error(`${label} did not emit a terminal event`);
  }
  return events;
}

const slowConsumerDelayRequirementMessage = "RUNINFRA_CANARY_STREAM_SLOW_CONSUMER_DELAY_MS non-negative integer <= 5000";

function slowConsumerDelayRequirement() {
  const value = env("RUNINFRA_CANARY_STREAM_SLOW_CONSUMER_DELAY_MS");
  if (!value) return [];
  if (!/^(?:0|[1-9][0-9]*)$/u.test(value)) {
    return [slowConsumerDelayRequirementMessage];
  }
  return Number(value) <= 5000 ? [] : [slowConsumerDelayRequirementMessage];
}

function slowConsumerDelayMs() {
  const value = env("RUNINFRA_CANARY_STREAM_SLOW_CONSUMER_DELAY_MS");
  if (!value) return 25;
  if (slowConsumerDelayRequirement().length) {
    throw new Error("RUNINFRA_CANARY_STREAM_SLOW_CONSUMER_DELAY_MS must be a non-negative integer <= 5000");
  }
  return Number(value);
}

function slowStreamRequirements() {
  return [
    ...["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"].filter((name) => !env(name)),
    ...slowConsumerDelayRequirement(),
  ];
}

async function sleep(ms) {
  if (ms <= 0) return;
  await new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}

async function sleepWithinDeadline(ms, deadlineMs, label) {
  if (ms <= 0) return;
  const remainingMs = Math.ceil(deadlineMs - performance.now());
  if (remainingMs <= 0 || ms > remainingMs) {
    throw new Error(`${label} slow-consumer timed out`);
  }
  await sleep(ms);
}

async function readSlowStream(stream, label, hasTerminalEvent, delayMs) {
  const events = [];
  const deadlineMs = performance.now() + canaryTimeoutMs();
  for await (const event of stream) {
    events.push(assertObject(event, `${label} event`));
    if (events.length > 200) throw new Error(`${label} exceeded 200 events without ending`);
    await sleepWithinDeadline(delayMs, deadlineMs, label);
  }
  assertArray(events, `${label} events`);
  if (!events.some(hasTerminalEvent)) {
    throw new Error(`${label} did not emit a terminal event`);
  }
  return { events, delayMs: "set_redacted" };
}

function isChatTerminalEvent(event) {
  return Boolean(
    event?.choices?.some?.((choice) =>
      choice && Object.prototype.hasOwnProperty.call(choice, "finish_reason") && choice.finish_reason !== null
    ),
  );
}

function isResponsesTerminalEvent(event) {
  const type = typeof event?.type === "string" ? event.type : "";
  return type === "response.completed" ||
    type === "response.done" ||
    type === "done" ||
    type.endsWith(".completed") ||
    event?.status === "completed" ||
    event?.response?.status === "completed";
}

function reportBaseURL(value) {
  return env("RUNINFRA_BASE_URL") ? "custom_set_redacted" : value;
}

function getPathValue(value, path) {
  return path.split(".").reduce((current, segment) => (
    current && typeof current === "object" ? current[segment] : undefined
  ), value);
}

function assertIdempotencyReplayEvidence(response) {
  const fields = (env("RUNINFRA_CANARY_IDEMPOTENCY_EVIDENCE_FIELD") ??
    "idempotency_replayed,_idempotency_replayed,idempotency.replayed,replay.replayed")
    .split(",")
    .map((field) => field.trim())
    .filter(Boolean);
  for (const field of fields) {
    const value = getPathValue(response, field);
    if (value === true || value === "true" || value === "replayed" || value === "hit") {
      return { idempotencyEvidenceField: field };
    }
  }
  throw new Error(
    `second idempotent response did not expose replay evidence in any field: ${fields.join(", ")}`,
  );
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

function sdkModuleURL() {
  const installedModule = env("RUNINFRA_CANARY_TS_MODULE");
  if (installedModule) return pathToFileURL(resolve(installedModule)).href;
  return pathToFileURL(resolve(repoRoot, "typescript", "dist", "index.js")).href;
}

const sdkModule = await import(sdkModuleURL());
const {
  AuthenticationError,
  ModelNotFoundError,
  PermissionDeniedError,
  RUNINFRA_SDK_VERSION,
  RunInfra,
  RunInfraConnectionError,
  RunInfraStreamParseError,
  RunInfraTimeoutError,
  constructWebhookEvent,
  verifyWebhookSignature,
} = sdkModule;

const apiKey = env("RUNINFRA_API_KEY");
const baseURL = env("RUNINFRA_BASE_URL") ?? "https://api.runinfra.ai/v1";
const llmModel = env("RUNINFRA_LLM_MODEL");
const embeddingModel = env("RUNINFRA_EMBEDDING_MODEL");
const imageModel = env("RUNINFRA_IMAGE_MODEL");
const ttsModel = env("RUNINFRA_TTS_MODEL");
const asrModel = env("RUNINFRA_ASR_MODEL");
const pipelineId = firstEnv("RUNINFRA_VOICE_PIPELINE_ID", "TEST_PIPELINE_ID");
const pipelineApiKey = firstEnv("RUNINFRA_VOICE_PIPELINE_API_KEY", "RUNINFRA_PIPELINE_API_KEY", "RUNINFRA_API_KEY");
const missingModelId = "runinfra-sdk-canary-missing-model";
const ttsResponseFormats = ["mp3", "opus", "aac", "flac", "wav", "pcm"];

function client(options = {}) {
  return new RunInfra({
    apiKey,
    baseURL,
    timeoutMs: Number(env("RUNINFRA_CANARY_TIMEOUT_SECONDS") ?? 120) * 1000,
    maxRetries: 0,
    ...options,
  });
}

const streamEncoder = new TextEncoder();

function localStreamResponse(body, requestId) {
  return new Response(body, {
    status: 200,
    headers: {
      "Content-Type": "text/event-stream",
      "x-request-id": requestId,
    },
  });
}

function localStreamClient(body, requestId, timeoutMs = 50) {
  return client({
    apiKey: "sk-ri-live-canary-local",
    baseURL: "http://localhost:1/v1",
    timeoutMs,
    fetch: async () => localStreamResponse(body, requestId),
  });
}

function disconnectingStream(firstFrame) {
  let reads = 0;
  return new ReadableStream({
    pull(controller) {
      if (reads === 0) {
        reads += 1;
        controller.enqueue(streamEncoder.encode(firstFrame));
        return;
      }
      controller.error(new TypeError("stream reset"));
    },
  });
}

function stalledStream() {
  return new ReadableStream({
    start() {
      // Keep the stream open so the SDK read timeout is what ends the row.
    },
  });
}

async function localChatStream(body, requestId, timeoutMs) {
  const stream = await localStreamClient(body, requestId, timeoutMs).chat.completions.create({
    model: "runinfra-local-stream-model",
    messages: [{ role: "user", content: "local stream canary" }],
    stream: true,
  });
  assertRequestId(stream.requestId, requestId);
  return stream;
}

async function localResponsesStream(body, requestId, timeoutMs) {
  const stream = await localStreamClient(body, requestId, timeoutMs).responses.create({
    model: "runinfra-local-stream-model",
    input: "local stream canary",
    stream: true,
  });
  assertRequestId(stream.requestId, requestId);
  return stream;
}

async function expectStreamError(stream, errorClass, errorType, label, options = {}) {
  const iterator = stream[Symbol.asyncIterator]();
  try {
    if (options.readFirst === true) {
      const first = await iterator.next();
      if (first.done) throw new Error(`${label} ended before the injected stream fault`);
      assertObject(first.value, `${label} first event`);
    }
    await iterator.next();
    throw new Error(`${label} did not raise the expected stream error`);
  } catch (error) {
    if (!(error instanceof errorClass)) {
      throw new Error(`${label} expected ${errorClass.name}, got ${error?.name ?? typeof error}`);
    }
    if (error.type !== errorType) {
      throw new Error(`${label} expected ${errorType}, got ${error.type ?? "unknown"}`);
    }
    assertRequestId(error.requestId, label);
    return { requestId: error.requestId, errorType: error.type, errorName: error.name };
  } finally {
    if (typeof iterator.return === "function") {
      await iterator.return().catch(() => undefined);
    }
  }
}

function speechVoicePayload() {
  const voice = env("RUNINFRA_TTS_VOICE");
  const refAudio = env("RUNINFRA_TTS_REF_AUDIO");
  const refText = env("RUNINFRA_TTS_REF_TEXT");
  if (voice) return { voice };
  if (refAudio && refText) {
    return {
      ref_audio: refAudio,
      ref_text: refText,
      task_type: env("RUNINFRA_TTS_TASK_TYPE") ?? "Base",
    };
  }
  return null;
}

function imageResponseFormat() {
  const responseFormat = env("RUNINFRA_IMAGE_RESPONSE_FORMAT");
  if (!["url", "b64_json"].includes(responseFormat)) {
    throw new Error("RUNINFRA_IMAGE_RESPONSE_FORMAT must be url or b64_json");
  }
  return responseFormat;
}

function asrResponseFormat() {
  const responseFormat = env("RUNINFRA_ASR_RESPONSE_FORMAT");
  if (!["json", "verbose_json"].includes(responseFormat)) {
    throw new Error("RUNINFRA_ASR_RESPONSE_FORMAT must be json or verbose_json");
  }
  return responseFormat;
}

function ttsResponseFormat() {
  const responseFormat = env("RUNINFRA_TTS_RESPONSE_FORMAT");
  if (!responseFormat) {
    throw new Error("RUNINFRA_TTS_RESPONSE_FORMAT missing");
  }
  if (!ttsResponseFormats.includes(responseFormat)) {
    throw new Error("RUNINFRA_TTS_RESPONSE_FORMAT must be mp3, opus, aac, flac, wav, or pcm");
  }
  return responseFormat;
}

function speechRequirements() {
  const missing = ["RUNINFRA_API_KEY", "RUNINFRA_TTS_MODEL"].filter((name) => !env(name));
  if (!speechVoicePayload()) missing.push("RUNINFRA_TTS_VOICE or RUNINFRA_TTS_REF_AUDIO plus RUNINFRA_TTS_REF_TEXT");
  return missing;
}

function speechRequest(input, options = {}) {
  const request = {
    model: ttsModel,
    input,
    ...speechVoicePayload(),
  };
  if (options.responseFormat) request.response_format = options.responseFormat;
  return request;
}

function canaryTimeoutMs() {
  return Number(env("RUNINFRA_CANARY_TIMEOUT_SECONDS") ?? 120) * 1000;
}

function remainingStreamMs(deadlineMs, label) {
  const remaining = Math.ceil(deadlineMs - performance.now());
  if (remaining <= 0) {
    throw new Error(`${label} stream read timed out`);
  }
  return remaining;
}

async function readStreamChunkWithTimeout(reader, label, timeoutMs) {
  let timeoutId;
  const read = reader.read();
  read.catch(() => undefined);
  try {
    const timeout = new Promise((_, reject) => {
      timeoutId = setTimeout(() => reject(new Error(`${label} stream read timed out`)), timeoutMs);
    });
    return await Promise.race([read, timeout]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function cancelReaderWithTimeout(reader) {
  let timeoutId;
  const cancel = reader.cancel();
  cancel.catch(() => undefined);
  try {
    await Promise.race([
      cancel,
      new Promise((resolve) => {
        timeoutId = setTimeout(resolve, 1000);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

async function readAudioByteStream(stream, label) {
  if (!stream || typeof stream.getReader !== "function") {
    throw new Error(`${label} did not expose a readable byte stream`);
  }
  const reader = stream.getReader();
  let byteLength = 0;
  const deadlineMs = performance.now() + canaryTimeoutMs();
  try {
    for (;;) {
      const { done, value } = await readStreamChunkWithTimeout(reader, label, remainingStreamMs(deadlineMs, label));
      if (done) break;
      if (!(value instanceof Uint8Array)) throw new Error(`${label} emitted a non-byte chunk`);
      byteLength += value.byteLength;
    }
  } catch (error) {
    await cancelReaderWithTimeout(reader);
    throw error;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // The runtime can keep the reader locked while propagating a body error.
    }
  }
  if (byteLength === 0) throw new Error(`${label} stream was empty`);
  return byteLength;
}

const results = [];

async function record(name, requirements, fn) {
  const missing = typeof requirements === "function" ? requirements() : requirements.filter((name) => !env(name));
  if (missing.length) {
    results.push({ name, status: "skipped", missing, durationMs: 0 });
    return;
  }
  const started = performance.now();
  try {
    const evidence = await fn();
    results.push({ name, ...evidence, status: "passed", durationMs: durationMs(started) });
  } catch (error) {
    results.push({ name, status: "failed", durationMs: durationMs(started), error: errorSummary(error) });
  }
}

await record("models.list", ["RUNINFRA_API_KEY"], async () => {
  const response = await client().models.list();
  assertObject(response, "models.list response");
  assertJsonArray(response.data, "models.list data");
  assertRequestId(response._request_id, "models.list");
  return { requestId: response._request_id, itemCount: response.data.length };
});

await record("models.retrieve.llm", ["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"], async () => {
  const response = await client().models.retrieve(llmModel);
  assertObject(response, "models.retrieve response");
  if (typeof response.id !== "string") throw new Error("models.retrieve response missing id");
  assertRequestId(response._request_id, "models.retrieve");
  return { requestId: response._request_id };
});

await record("chat.completions.create", ["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"], async () => {
  const response = await client().chat.completions.create({
    model: llmModel,
    messages: [{ role: "user", content: "Reply with the single word ok." }],
    temperature: 0,
    top_p: 1,
    max_tokens: 16,
    stop: ["\n\n"],
  });
  assertObject(response, "chat response");
  assertChatCompletionEnvelope(response, "chat response");
  assertRequestId(response._request_id, "chat.completions.create");
  return { requestId: response._request_id };
});

await record("openai.params.chat.completions", ["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"], async () => {
  const response = await client().chat.completions.create({
    model: llmModel,
    messages: [
      { role: "system", content: "You are a concise SDK compatibility canary." },
      { role: "user", content: "Reply with the single word ok." },
    ],
    temperature: 0,
    top_p: 1,
    max_tokens: 16,
    stop: ["\n\n"],
    presence_penalty: 0,
    frequency_penalty: 0,
    user: "sdk-canary",
    metadata: { sdk_canary: "openai_params_chat" },
  });
  assertObject(response, "chat params response");
  assertChatCompletionEnvelope(response, "chat params response");
  assertRequestId(response._request_id, "openai.params.chat.completions");
  return { requestId: response._request_id };
});

await record("openai.params.chat.stream_options", ["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"], async () => {
  const stream = await client().chat.completions.create({
    model: llmModel,
    messages: [{ role: "user", content: "Reply with the single word ok." }],
    temperature: 0,
    max_tokens: 16,
    stream: true,
    stream_options: { include_usage: true },
  });
  assertRequestId(stream.requestId, "openai.params.chat.stream_options");
  const events = await readFullStream(stream, "chat stream options stream", isChatTerminalEvent);
  let sawUsage = false;
  events.forEach((event, index) => {
    if (isChatStreamUsageEvent(event)) {
      assertChatStreamUsageEvent(event, `chat stream options usage event ${index}`);
      sawUsage = true;
      return;
    }
    assertChatStreamEnvelope(event, `chat stream options event ${index}`);
  });
  if (!sawUsage) {
    throw new Error("chat stream options did not emit a usage event");
  }
  return { requestId: stream.requestId, eventCount: events.length, usage: "present" };
});

await record("chat.completions.stream.final", ["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"], async () => {
  const stream = await client().chat.completions.create({
    model: llmModel,
    messages: [{ role: "user", content: "Reply with the single word ok." }],
    temperature: 0,
    max_tokens: 16,
    stream: true,
  });
  assertRequestId(stream.requestId, "chat.completions.stream.final");
  const events = await readFullStream(stream, "chat stream", isChatTerminalEvent);
  events.forEach((event, index) => assertChatStreamEnvelope(event, `chat stream event ${index}`));
  return { requestId: stream.requestId, eventCount: events.length };
});

await record("chat.completions.stream.cancel", ["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"], async () => {
  const stream = await client().chat.completions.create({
    model: llmModel,
    messages: [{ role: "user", content: "Reply with one sentence." }],
    temperature: 0,
    max_tokens: 32,
    stream: true,
  });
  assertRequestId(stream.requestId, "chat.completions.stream.cancel");
  const events = await readSomeStream(stream, "chat cancellation stream");
  events.forEach((event, index) => assertChatStreamEnvelope(event, `chat cancellation stream event ${index}`));
  return { requestId: stream.requestId, eventCount: events.length };
});

await record("chat.completions.stream.slow_consumer", slowStreamRequirements, async () => {
  const delayMs = slowConsumerDelayMs();
  const stream = await client().chat.completions.create({
    model: llmModel,
    messages: [{ role: "user", content: "Reply with one short sentence." }],
    temperature: 0,
    max_tokens: 32,
    stream: true,
  });
  assertRequestId(stream.requestId, "chat.completions.stream.slow_consumer");
  const result = await readSlowStream(stream, "chat slow-consumer stream", isChatTerminalEvent, delayMs);
  const { events } = result;
  events.forEach((event, index) => assertChatStreamEnvelope(event, `chat slow-consumer stream event ${index}`));
  return { requestId: stream.requestId, eventCount: events.length, slowConsumerDelayMs: result.delayMs };
});

await record("chat.completions.stream.malformed_frame.local", [], async () => {
  const stream = await localChatStream("data: {not-json}\n\n", "req-local-chat-malformed");
  return expectStreamError(
    stream,
    RunInfraStreamParseError,
    "stream_parse_error",
    "chat.completions.stream.malformed_frame.local",
  );
});

await record("chat.completions.stream.disconnect.local", [], async () => {
  const stream = await localChatStream(
    disconnectingStream('data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'),
    "req-local-chat-disconnect",
  );
  return expectStreamError(
    stream,
    RunInfraConnectionError,
    "connection_error",
    "chat.completions.stream.disconnect.local",
    { readFirst: true },
  );
});

await record("chat.completions.stream.stalled_read.local", [], async () => {
  const stream = await localChatStream(stalledStream(), "req-local-chat-stalled", 20);
  return expectStreamError(
    stream,
    RunInfraTimeoutError,
    "timeout_error",
    "chat.completions.stream.stalled_read.local",
  );
});

await record("responses.create", ["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"], async () => {
  const response = await client().responses.create({
    model: llmModel,
    input: "Reply with the single word ok.",
    instructions: "Be concise.",
    temperature: 0,
    max_output_tokens: 16,
  });
  assertObject(response, "responses response");
  assertResponsesEnvelope(response, "responses response");
  assertRequestId(response._request_id, "responses.create");
  return { requestId: response._request_id, hasOutput: Boolean(response.output_text || response.output) };
});

await record("openai.params.responses", ["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"], async () => {
  const response = await client().responses.create({
    model: llmModel,
    input: "Reply with the single word ok.",
    instructions: "Be concise.",
    temperature: 0,
    max_output_tokens: 16,
    metadata: { sdk_canary: "openai_params_responses" },
  });
  assertObject(response, "responses params response");
  assertResponsesEnvelope(response, "responses params response");
  assertRequestId(response._request_id, "openai.params.responses");
  return { requestId: response._request_id, hasOutput: Boolean(response.output_text || response.output) };
});

await record("responses.stream.final", ["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"], async () => {
  const stream = await client().responses.create({
    model: llmModel,
    input: "Reply with the single word ok.",
    max_output_tokens: 16,
    stream: true,
  });
  assertRequestId(stream.requestId, "responses.stream.final");
  const events = await readFullStream(stream, "responses stream", isResponsesTerminalEvent);
  events.forEach((event, index) => assertResponsesStreamEnvelope(event, `responses stream event ${index}`));
  return { requestId: stream.requestId, eventCount: events.length };
});

await record("responses.stream.cancel", ["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"], async () => {
  const stream = await client().responses.create({
    model: llmModel,
    input: "Reply with one sentence.",
    max_output_tokens: 32,
    stream: true,
  });
  assertRequestId(stream.requestId, "responses.stream.cancel");
  const events = await readSomeStream(stream, "responses cancellation stream");
  events.forEach((event, index) => assertResponsesStreamEnvelope(event, `responses cancellation stream event ${index}`));
  return { requestId: stream.requestId, eventCount: events.length };
});

await record("responses.stream.slow_consumer", slowStreamRequirements, async () => {
  const delayMs = slowConsumerDelayMs();
  const stream = await client().responses.create({
    model: llmModel,
    input: "Reply with one short sentence.",
    max_output_tokens: 32,
    stream: true,
  });
  assertRequestId(stream.requestId, "responses.stream.slow_consumer");
  const result = await readSlowStream(stream, "responses slow-consumer stream", isResponsesTerminalEvent, delayMs);
  const { events } = result;
  events.forEach((event, index) => assertResponsesStreamEnvelope(event, `responses slow-consumer stream event ${index}`));
  return { requestId: stream.requestId, eventCount: events.length, slowConsumerDelayMs: result.delayMs };
});

await record("responses.stream.malformed_frame.local", [], async () => {
  const stream = await localResponsesStream("data: {not-json}\n\n", "req-local-responses-malformed");
  return expectStreamError(
    stream,
    RunInfraStreamParseError,
    "stream_parse_error",
    "responses.stream.malformed_frame.local",
  );
});

await record("responses.stream.disconnect.local", [], async () => {
  const stream = await localResponsesStream(
    disconnectingStream('data: {"type":"response.output_text.delta","delta":"hi"}\n\n'),
    "req-local-responses-disconnect",
  );
  return expectStreamError(
    stream,
    RunInfraConnectionError,
    "connection_error",
    "responses.stream.disconnect.local",
    { readFirst: true },
  );
});

await record("responses.stream.stalled_read.local", [], async () => {
  const stream = await localResponsesStream(stalledStream(), "req-local-responses-stalled", 20);
  return expectStreamError(
    stream,
    RunInfraTimeoutError,
    "timeout_error",
    "responses.stream.stalled_read.local",
  );
});

await record("embeddings.create", ["RUNINFRA_API_KEY", "RUNINFRA_EMBEDDING_MODEL"], async () => {
  const response = await client().embeddings.create({
    model: embeddingModel,
    input: ["runinfra live canary", "sdk ga gate"],
  });
  assertObject(response, "embeddings response");
  assertEmbeddingsEnvelope(response, "embeddings response");
  assertRequestId(response._request_id, "embeddings.create");
  return { requestId: response._request_id, vectorLength: response.data[0].embedding.length };
});

await record("openai.params.embeddings", [
  "RUNINFRA_API_KEY",
  "RUNINFRA_EMBEDDING_MODEL",
  "RUNINFRA_EMBEDDING_DIMENSIONS",
], async () => {
  const dimensions = requiredPositiveIntegerEnv("RUNINFRA_EMBEDDING_DIMENSIONS");
  const response = await client().embeddings.create({
    model: embeddingModel,
    input: "runinfra sdk openai parameter canary",
    encoding_format: "float",
    dimensions,
  });
  assertObject(response, "embeddings params response");
  assertEmbeddingsEnvelope(response, "embeddings params response");
  assertRequestId(response._request_id, "openai.params.embeddings");
  if (response.data[0].embedding.length !== dimensions) {
    throw new Error("embeddings params response ignored requested dimensions");
  }
  return { requestId: response._request_id, vectorLength: response.data[0].embedding.length };
});

await record("images.generate", ["RUNINFRA_API_KEY", "RUNINFRA_IMAGE_MODEL"], async () => {
  const request = {
    model: imageModel,
    prompt: "A small green square on a white background.",
    n: 1,
  };
  if (env("RUNINFRA_IMAGE_SIZE")) request.size = env("RUNINFRA_IMAGE_SIZE");
  if (env("RUNINFRA_IMAGE_RESPONSE_FORMAT")) request.response_format = env("RUNINFRA_IMAGE_RESPONSE_FORMAT");
  const response = await client().images.generate(request);
  assertObject(response, "images response");
  assertImageEnvelope(response, "images response");
  assertRequestId(response._request_id, "images.generate");
  return { requestId: response._request_id, output: response.data[0].url ? "url" : "b64_json" };
});

await record("openai.params.images", ["RUNINFRA_API_KEY", "RUNINFRA_IMAGE_MODEL", "RUNINFRA_IMAGE_SIZE", "RUNINFRA_IMAGE_RESPONSE_FORMAT"], async () => {
  const responseFormat = imageResponseFormat();
  const response = await client().images.generate({
    model: imageModel,
    prompt: "A small green square on a white background.",
    n: 1,
    size: env("RUNINFRA_IMAGE_SIZE"),
    response_format: responseFormat,
  });
  assertObject(response, "images params response");
  assertImageEnvelope(response, "images params response");
  assertImageOutputFormat(response, responseFormat, "images params response");
  assertRequestId(response._request_id, "openai.params.images");
  return { requestId: response._request_id, output: responseFormat };
});

await record("audio.speech.create", speechRequirements, async () => {
  const response = await client().audio.speech.create(speechRequest("RunInfra SDK live canary."));
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error("TTS response was empty");
  assertAudioContentType(response.contentType, "audio.speech.create");
  assertRequestId(response.requestId, "audio.speech.create");
  return { requestId: response.requestId, contentType: response.contentType, byteLength: bytes.length };
});

await record("openai.params.audio.speech", () => [
  ...speechRequirements(),
  ...(env("RUNINFRA_TTS_RESPONSE_FORMAT") ? [] : ["RUNINFRA_TTS_RESPONSE_FORMAT"]),
], async () => {
  const responseFormat = ttsResponseFormat();
  const request = speechRequest("RunInfra SDK TTS parameter canary.", { responseFormat });
  if (request.response_format !== responseFormat) {
    throw new Error("TTS parameter request did not include response_format");
  }
  const response = await client().audio.speech.create(request);
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.length === 0) throw new Error("TTS params response was empty");
  assertAudioContentType(response.contentType, "openai.params.audio.speech");
  assertRequestId(response.requestId, "openai.params.audio.speech");
  return {
    requestId: response.requestId,
    responseFormat: "set_redacted",
    contentType: response.contentType,
    byteLength: bytes.length,
  };
});

await record("audio.speech.binary_interfaces", speechRequirements, async () => {
  const blobResponse = await client().audio.speech.create(speechRequest("RunInfra SDK blob canary."));
  const blob = await blobResponse.blob();
  if (!(blob instanceof Blob) || blob.size === 0) throw new Error("TTS blob response was empty");
  assertAudioContentType(blobResponse.contentType, "audio.speech.binary_interfaces blob");
  assertRequestId(blobResponse.requestId, "audio.speech.binary_interfaces blob");

  const streamResponse = await client().audio.speech.create(speechRequest("RunInfra SDK stream canary."));
  const streamBytes = await readAudioByteStream(streamResponse.stream(), "audio.speech.binary_interfaces");
  assertAudioContentType(streamResponse.contentType, "audio.speech.binary_interfaces stream");
  assertRequestId(streamResponse.requestId, "audio.speech.binary_interfaces stream");
  return {
    blobRequestId: blobResponse.requestId,
    streamRequestId: streamResponse.requestId,
    blobContentType: blob.type || blobResponse.contentType,
    blobByteLength: blob.size,
    streamByteLength: streamBytes,
  };
});

await record("audio.transcriptions.create", [
  "RUNINFRA_API_KEY",
  "RUNINFRA_ASR_MODEL",
  "RUNINFRA_ASR_FIXTURE_PATH",
  "RUNINFRA_ASR_EXPECTED_TEXT",
], async () => {
  const fixture = asrFixture();
  if (!fixture) throw new Error("ASR fixture missing");
  const request = {
    model: asrModel,
    file: new Blob([fixture.bytes], { type: fixture.contentType }),
    filename: fixture.filename,
  };
  if (env("RUNINFRA_ASR_LANGUAGE")) request.language = env("RUNINFRA_ASR_LANGUAGE");
  const response = await client().audio.transcriptions.create(request);
  assertObject(response, "ASR response");
  assertString(response.text, "ASR response.text");
  const expected = normalizedText(env("RUNINFRA_ASR_EXPECTED_TEXT"));
  const actual = normalizedText(response.text);
  if (!expected || !actual.includes(expected)) {
    throw new Error("ASR transcript did not include expected fixture text");
  }
  assertRequestId(response._request_id, "audio.transcriptions.create");
  return { requestId: response._request_id, textLength: String(response.text ?? "").length };
});

await record("openai.params.audio.transcriptions", [
  "RUNINFRA_API_KEY",
  "RUNINFRA_ASR_MODEL",
  "RUNINFRA_ASR_LANGUAGE",
  "RUNINFRA_ASR_RESPONSE_FORMAT",
  "RUNINFRA_ASR_FIXTURE_PATH",
  "RUNINFRA_ASR_EXPECTED_TEXT",
], async () => {
  const fixture = asrFixture();
  if (!fixture) throw new Error("ASR fixture missing");
  const responseFormat = asrResponseFormat();
  const response = await client().audio.transcriptions.create({
    model: asrModel,
    file: new Blob([fixture.bytes], { type: fixture.contentType }),
    filename: fixture.filename,
    language: env("RUNINFRA_ASR_LANGUAGE"),
    prompt: "RunInfra SDK ASR parameter canary.",
    response_format: responseFormat,
  });
  assertObject(response, "ASR params response");
  assertString(response.text, "ASR params response.text");
  const expected = normalizedText(env("RUNINFRA_ASR_EXPECTED_TEXT"));
  const actual = normalizedText(response.text);
  if (!expected || !actual.includes(expected)) {
    throw new Error("ASR params transcript did not include expected fixture text");
  }
  if (
    responseFormat === "verbose_json" &&
    typeof response.language !== "string" &&
    typeof response.duration !== "number" &&
    !Array.isArray(response.segments)
  ) {
    throw new Error("ASR verbose_json response did not include verbose fields");
  }
  assertRequestId(response._request_id, "openai.params.audio.transcriptions");
  return { requestId: response._request_id, responseFormat };
});

await record("voice.pipeline.create", () => {
  const missing = [];
  if (!pipelineApiKey) missing.push("RUNINFRA_VOICE_PIPELINE_API_KEY or RUNINFRA_PIPELINE_API_KEY or RUNINFRA_API_KEY");
  if (!pipelineId) missing.push("RUNINFRA_VOICE_PIPELINE_ID or TEST_PIPELINE_ID");
  if (!voicePipelineFixturePath()) missing.push("RUNINFRA_VOICE_PIPELINE_AUDIO_PATH or RUNINFRA_ASR_FIXTURE_PATH");
  if (!voicePipelineExpectedText()) missing.push("RUNINFRA_VOICE_PIPELINE_EXPECTED_TEXT or RUNINFRA_ASR_EXPECTED_TEXT");
  return missing;
}, async () => {
  const fixture = voicePipelineFixture();
  if (!fixture) throw new Error("voice pipeline fixture missing");
  const response = await client({ apiKey: pipelineApiKey, pipelineId }).voice.pipeline.create({
    audio: fixture.bytes,
    mimeType: fixture.contentType,
  });
  assertObject(response, "voice pipeline response");
  assertRequestId(response._request_id, "voice.pipeline.create");
  return {
    requestId: response._request_id,
    ...assertVoicePipelineExpectedText(response),
  };
});

await record("error.auth.invalid_key", [], async () => {
  const invalid = new RunInfra({
    apiKey: "sk-ri-live-canary-invalid",
    baseURL,
    timeoutMs: 30_000,
    maxRetries: 0,
  });
  try {
    await invalid.models.list();
  } catch (error) {
    if (error instanceof AuthenticationError) {
      if (error.status !== 401 || error.type !== "auth_error") {
        throw new Error(`invalid-key auth error mapped unexpectedly: ${error.status} ${error.type}`);
      }
      assertRequestId(error.requestId, "invalid-key auth error");
      return { errorType: error.type, errorStatus: error.status, requestId: error.requestId };
    }
    if (error instanceof PermissionDeniedError) {
      if (error.status !== 403 || error.type !== "permission_denied") {
        throw new Error(`invalid-key permission error mapped unexpectedly: ${error.status} ${error.type}`);
      }
      assertRequestId(error.requestId, "invalid-key permission error");
      return { errorType: error.type, errorStatus: error.status, requestId: error.requestId };
    }
    throw error;
  }
  throw new Error("invalid API key unexpectedly succeeded");
});

await record("error.model.not_found", ["RUNINFRA_API_KEY"], async () => {
  try {
    await client().models.retrieve(missingModelId);
  } catch (error) {
    if (!(error instanceof ModelNotFoundError)) throw error;
    if (error.status !== 404 || error.type !== "model_not_found") {
      throw new Error(`model-not-found error mapped unexpectedly: ${error.status} ${error.type}`);
    }
    assertRequestId(error.requestId, "model-not-found error");
    return { errorType: error.type, errorStatus: error.status, requestId: error.requestId };
  }
  throw new Error("missing model unexpectedly succeeded");
});

await record("error.request.invalid_options", [], async () => {
  const local = new RunInfra({
    apiKey: "sk-ri-live-canary-local",
    baseURL: "http://localhost:1/v1",
    maxRetries: 0,
  });
  try {
    await local.responses.create(
      { model: "llama", input: "hello" },
      { unsupportedOption: true },
    );
  } catch (error) {
    if (error?.status !== 0 || error?.type !== "invalid_request_options") {
      throw new Error(`invalid request option mapped unexpectedly: ${error?.status} ${error?.type}`);
    }
    return { errorType: error.type, errorStatus: error.status };
  }
  throw new Error("invalid request option unexpectedly succeeded");
});

await record("error.body.unsupported_parameter", ["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"], async () => {
  try {
    await client().responses.create({
      model: llmModel,
      input: "Reply with the single word ok.",
      max_output_tokens: 1,
      runinfra_unsupported_parameter_probe: "must_error",
    });
  } catch (error) {
    return assertClearUnsupportedParameterError(error, "unsupported body parameter");
  }
  throw new Error("unsupported body parameter unexpectedly succeeded");
});

await record("webhooks.delivery_surface.absent", [], async () => {
  const webhooks = client({ apiKey: apiKey ?? "sk-ri-live-canary-local", baseURL: "http://localhost:1/v1" }).webhooks;
  if ("create" in webhooks || "list" in webhooks) {
    throw new Error("unshipped webhook delivery methods are present");
  }
  if (typeof webhooks.verifySignature !== "function" || typeof webhooks.constructEvent !== "function") {
    throw new Error("webhook verification helpers are missing");
  }
  return { deliveryMethods: "absent", verificationHelpers: "present" };
});

function webhookFixture() {
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ type: "sdk.canary", data: { ok: true } });
  const secret = "whsec_sdk_canary_local";
  const signature = createHmac("sha256", secret)
    .update(`${timestamp}.${payload}`)
    .digest("hex");
  return {
    payload,
    secret,
    timestamp,
    signatureHeader: `t=${timestamp},v1=${signature}`,
  };
}

await record("webhooks.verify_signature.local", [], async () => {
  const fixture = webhookFixture();
  const verified = client({ apiKey: apiKey ?? "sk-ri-live-canary-local", baseURL: "http://localhost:1/v1" })
    .webhooks.verifySignature({
      payload: fixture.payload,
      signatureHeader: fixture.signatureHeader,
      secret: fixture.secret,
      now: fixture.timestamp,
    });
  if (verified !== true) throw new Error("webhook signature verification did not return true");
  return { verified };
});

await record("webhooks.construct_event.local", [], async () => {
  const fixture = webhookFixture();
  const event = client({ apiKey: apiKey ?? "sk-ri-live-canary-local", baseURL: "http://localhost:1/v1" })
    .webhooks.constructEvent({
      payload: fixture.payload,
      signatureHeader: fixture.signatureHeader,
      secret: fixture.secret,
      now: fixture.timestamp,
    });
  assertObject(event, "webhook event");
  assertString(event.type, "webhook event.type");
  return { eventType: event.type };
});

await record("webhooks.verify_signature.export", [], async () => {
  const fixture = webhookFixture();
  const verified = verifyWebhookSignature({
    payload: fixture.payload,
    signatureHeader: fixture.signatureHeader,
    secret: fixture.secret,
    now: fixture.timestamp,
  });
  if (verified !== true) throw new Error("exported webhook signature verification did not return true");
  return { verified };
});

await record("webhooks.construct_event.export", [], async () => {
  const fixture = webhookFixture();
  const event = constructWebhookEvent({
    payload: fixture.payload,
    signatureHeader: fixture.signatureHeader,
    secret: fixture.secret,
    now: fixture.timestamp,
  });
  assertObject(event, "exported webhook event");
  assertString(event.type, "exported webhook event.type");
  return { eventType: event.type };
});

await record("idempotency.replay.responses", () => {
  const missing = ["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"].filter((name) => !env(name));
  if (env("RUNINFRA_CANARY_ENABLE_IDEMPOTENCY") !== "1") missing.push("RUNINFRA_CANARY_ENABLE_IDEMPOTENCY=1");
  return missing;
}, async () => {
  const key = `sdk-canary-ts-${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const request = {
    model: llmModel,
    input: "Reply with the single word ok.",
    max_output_tokens: 16,
  };
  const first = await client().responses.create(request, { idempotencyKey: key, maxRetries: 0 });
  const second = await client().responses.create(request, { idempotencyKey: key, maxRetries: 0 });
  assertRequestId(first._request_id, "idempotency first response");
  assertRequestId(second._request_id, "idempotency second response");
  return {
    firstRequestId: first._request_id,
    secondRequestId: second._request_id,
    ...assertIdempotencyReplayEvidence(second),
  };
});

const summary = {
  passed: results.filter((result) => result.status === "passed").length,
  failed: results.filter((result) => result.status === "failed").length,
  skipped: results.filter((result) => result.status === "skipped").length,
};

const report = {
  schemaVersion: 1,
  language: "typescript",
  sdkVersion: RUNINFRA_SDK_VERSION,
  generatedAt: nowIso(),
  strict,
  baseURL: reportBaseURL(baseURL),
  env: redactedEnv(relevantEnv),
  summary,
  results,
};

if (reportPath) {
  const absolute = resolve(reportPath);
  mkdirSync(dirname(absolute), { recursive: true });
  writeFileSync(absolute, `${JSON.stringify(report, null, 2)}\n`);
}

console.log(JSON.stringify({ language: report.language, sdkVersion: report.sdkVersion, summary }, null, 2));

if (summary.failed > 0 || (strict && summary.skipped > 0)) {
  process.exit(1);
}

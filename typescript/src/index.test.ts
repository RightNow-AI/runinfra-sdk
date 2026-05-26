// @vitest-environment node

import { createHash, createHmac } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gzipSync } from "node:zlib";
import { spawnSync } from "node:child_process";
import { describe, expect, it, vi } from "vitest";
import {
  AuthenticationError,
  RUNINFRA_SDK_VERSION,
  RunInfra,
  RunInfraAudioResponse,
  RunInfraConnectionError,
  RunInfraError,
  RunInfraStream,
  RunInfraStreamParseError,
  RunInfraTimeoutError,
  WebhookVerificationError,
  constructWebhookEvent,
  type ResponsesCreateResponse,
  type RunInfraOptions,
  type RunInfraRequestOptions,
} from "./index";

function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
    ...init,
  });
}

function jsonReadFailureResponse(message: string, init: ResponseInit = {}): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new TypeError(message));
      },
    }),
    {
      status: 200,
      headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
      ...init,
    },
  );
}

type SourceIdentity = { sourceDigestSha256: string; sourceFileCount: number };

function normalizeNewlines(text: string): string {
  return text.replace(/\r\n/g, "\n");
}

function readUtf8Normalized(path: URL): string {
  return normalizeNewlines(readFileSync(path, "utf8"));
}

async function currentPromotionSourceIdentity(): Promise<SourceIdentity> {
  const manifest = await import("../../scripts/live-canary-source-files.mjs") as { sourceDigestFileLabels: string[] };
  const digest = createHash("sha256");
  for (const label of manifest.sourceDigestFileLabels) {
    digest.update(label);
    digest.update("\0");
    digest.update(readFileSync(new URL(`../../${label}`, import.meta.url)));
    digest.update("\0");
  }
  return {
    sourceDigestSha256: digest.digest("hex"),
    sourceFileCount: manifest.sourceDigestFileLabels.length,
  };
}

async function canonicalReadinessFixture(
  missing: string[],
  blockedRows: Record<string, string[]>,
  extraFields: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const { expectedRows } = await import("../../scripts/live-canary-matrix.mjs") as { expectedRows: string[] };
  const blockedNames = new Set(Object.keys(blockedRows));
  const sourceIdentity = await currentPromotionSourceIdentity();
  return {
    schemaVersion: 1,
    generatedAt: "2026-05-26T00:00:00.000Z",
    strict: true,
    packageSource: "artifact",
    candidate: {
      sdkVersion: RUNINFRA_SDK_VERSION,
      packageSource: "artifact",
      sourceDigestSha256: sourceIdentity.sourceDigestSha256,
      sourceFileCount: sourceIdentity.sourceFileCount,
      artifactDigestsChecked: false,
      artifacts: [],
    },
    expectedRows,
    ...extraFields,
    readiness: {
      status: blockedNames.size ? "blocked" : "ready",
      env: {},
      aliases: {},
      missing,
      rowCoverageErrors: [],
      summary: {
        ready: expectedRows.length - blockedNames.size,
        blocked: blockedNames.size,
      },
      rows: expectedRows.map((name) => ({
        name,
        status: blockedNames.has(name) ? "blocked" : "ready",
        missing: blockedRows[name] ?? [],
      })),
    },
    surfaceCoverage: {
      status: "passed",
      errors: [],
      declaredSurfaceCount: 0,
      declaredSurfaces: [],
      uncoveredSurfaces: [],
      uncoveredRows: [],
      surfaceCount: 0,
      rowCount: expectedRows.length,
      surfaces: [],
    },
    parity: {
      status: "not_run",
      errors: [],
    },
    reports: [],
  };
}

async function expectMissingEnvPatchRejectsCandidateSourceIdentityMutation(
  tmpSlug: string,
  mutateCandidate: (candidate: SourceIdentity) => void,
): Promise<void> {
  const tmp = mkdtempSync(join(tmpdir(), `runinfra-missing-env-template-${tmpSlug}-`));
  const readinessPath = join(tmp, "readiness.json");
  const templatePath = join(tmp, "missing.env");
  try {
    const report = await canonicalReadinessFixture(
      ["RUNINFRA_IMAGE_MODEL"],
      { "models.retrieve.image": ["RUNINFRA_IMAGE_MODEL"] },
    );
    mutateCandidate(report.candidate as SourceIdentity);
    writeFileSync(readinessPath, `${JSON.stringify(report, null, 2)}\n`);

    const result = spawnSync(process.execPath, [
      "../scripts/run-sdk-live-canaries.mjs",
      "--readiness-report",
      readinessPath,
      "--write-missing-env-template",
      templatePath,
    ], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
    });

    expect(result.status).toBe(2);
    expect(result.stderr).toContain("readiness report candidate source identity must match current sources");
    expect(result.stderr).not.toContain(readinessPath);
    expect(existsSync(templatePath)).toBe(false);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

interface TarEntry {
  name: string;
  content?: string;
  type?: "0" | "2";
  linkname?: string;
}

function tarOctal(value: number, length: number): string {
  return value.toString(8).padStart(length - 1, "0").slice(-(length - 1)) + "\0";
}

function writeTarString(header: Buffer, value: string, offset: number, length: number): void {
  header.write(value.slice(0, length), offset, length, "ascii");
}

function tarHeader(entry: TarEntry): Buffer {
  const payloadLength = Buffer.byteLength(entry.content ?? "", "utf8");
  const header = Buffer.alloc(512, 0);
  writeTarString(header, entry.name, 0, 100);
  writeTarString(header, tarOctal(0o644, 8), 100, 8);
  writeTarString(header, tarOctal(0, 8), 108, 8);
  writeTarString(header, tarOctal(0, 8), 116, 8);
  writeTarString(header, tarOctal(entry.type === "2" ? 0 : payloadLength, 12), 124, 12);
  writeTarString(header, tarOctal(0, 12), 136, 12);
  header.fill(" ", 148, 156);
  writeTarString(header, entry.type ?? "0", 156, 1);
  if (entry.linkname) writeTarString(header, entry.linkname, 157, 100);
  writeTarString(header, "ustar\0", 257, 6);
  writeTarString(header, "00", 263, 2);
  const checksum = [...header].reduce((sum, byte) => sum + byte, 0);
  const checksumText = checksum.toString(8).padStart(6, "0").slice(-6) + "\0 ";
  writeTarString(header, checksumText, 148, 8);
  return header;
}

function tarballBuffer(entries: TarEntry[]): Buffer {
  const blocks: Buffer[] = [];
  for (const entry of entries) {
    const payload = Buffer.from(entry.content ?? "", "utf8");
    blocks.push(tarHeader(entry));
    if ((entry.type ?? "0") === "0") {
      blocks.push(payload);
      const padding = (512 - (payload.length % 512)) % 512;
      if (padding > 0) blocks.push(Buffer.alloc(padding, 0));
    }
  }
  blocks.push(Buffer.alloc(1024, 0));
  return Buffer.concat(blocks);
}

function writeTarball(path: string, entries: TarEntry[]): void {
  writeFileSync(path, tarballBuffer(entries));
}

function writeGzippedTarball(path: string, entries: TarEntry[]): void {
  writeFileSync(path, gzipSync(tarballBuffer(entries)));
}

describe("RunInfra TypeScript SDK", () => {
  it("builds fresh dist files before package publication", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { description?: string; files?: string[]; scripts?: Record<string, string> };

    expect(packageJson.scripts?.prepack).toBe(packageJson.scripts?.build);
    expect(packageJson.files).toEqual(expect.arrayContaining(["dist", "README.md", "package.json"]));
    expect(packageJson.description).toContain("LLM and embeddings contract-tested");
    expect(packageJson.description).not.toContain("LLM + embeddings tested");
  });

  it("documents explicit API key environment guards instead of non-null assertions", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

    expect(readme).toContain("const apiKey = process.env.RUNINFRA_API_KEY;");
    expect(readme).toContain("Set RUNINFRA_API_KEY");
    expect(readme).not.toContain("process.env.RUNINFRA_API_KEY!");
  });

  it("documents workspace keys as verified-active only", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

    expect(readme).toContain("reach verified active deployments through the `model` field");
    expect(readme).not.toContain("reach any active deployment");
    expect(readme).not.toContain("reach every active deployment");
  });

  it("keeps the root README snippets safe and modality status aligned with shipped SDK behavior", () => {
    const readme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

    expect(readme).toContain("const apiKey = process.env.RUNINFRA_API_KEY;");
    expect(readme).toContain("Set RUNINFRA_API_KEY");
    expect(readme).not.toContain("process.env.RUNINFRA_API_KEY!");

    expect(readme).toContain("api_key = os.environ.get(\"RUNINFRA_API_KEY\")");
    expect(readme).not.toContain("os.environ[\"RUNINFRA_API_KEY\"]");

    expect(readme).toContain("| Webhook delivery | Not shipped");
    expect(readme).toContain("| Voice pipeline | **Experimental**, pipeline-scoped route, not live-canary verified |");
    expect(readme).toContain("| Embeddings | Beta, contract-tested. Not strict live-canary verified in the current promotion artifacts |");
    expect(readme).toContain("| Chat completions, Responses | Beta, contract-tested. Current 0.1.4 promotion artifacts are not strict-live green; publish requires fresh production artifact canaries with zero skipped or failed rows |");
    expect(readme).not.toContain("Strict live source canaries currently pass chat/responses rows");
    expect(readme).not.toContain("Chat completions, Responses, Embeddings | Beta, contract-tested");
    expect(readme).not.toContain("Webhook delivery, Voice pipeline | Not shipped");
    expect(readme).not.toContain("streaming final/slow-consumer rows pass against production");

    const readinessIndex = readme.indexOf("node scripts/run-sdk-live-canaries.mjs --preflight --strict --report artifacts/sdk/live-canary-readiness.json");
    const liveCanaryIndex = readme.indexOf("node scripts/run-sdk-live-canaries.mjs --package-source artifact --strict --report artifacts/sdk/live-canary.json");
    const promotionReportIndex = readme.indexOf("node scripts/verify-promotion-reports.mjs --readiness artifacts/sdk/live-canary-readiness.json --live artifacts/sdk/live-canary.json --artifacts-root .");
    expect(readinessIndex).toBeGreaterThan(-1);
    expect(liveCanaryIndex).toBeGreaterThan(readinessIndex);
    expect(promotionReportIndex).toBeGreaterThan(liveCanaryIndex);
    expect(readme).toContain("reports from `https://api.runinfra.ai/v1`");
    expect(readme).toContain("staging smoke evidence, not publish evidence");
  });

  it("does not overclaim embeddings live verification before the strict target exists", () => {
    const packageReadme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const agentNotes = readFileSync(new URL("../../AGENT-NOTES.md", import.meta.url), "utf8");
    const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");

    for (const text of [packageReadme, agentNotes]) {
      expect(text).toContain("Not strict live-canary verified in the current promotion artifacts");
      expect(text).toContain("Current 0.1.4 promotion artifacts are not strict-live green; publish requires fresh production artifact canaries with zero skipped or failed rows");
      expect(text).not.toContain("Strict live source canaries currently pass chat/responses rows");
      expect(text).not.toContain("streaming final/slow-consumer rows pass against production");
      expect(text).not.toContain("| Embeddings | `client.embeddings.create` | Beta, contract-tested |");
      expect(text).not.toContain("| `client.embeddings.create` | Beta, contract-tested |");
    }
    expect(changelog).toContain("blocked for embeddings until the strict promotion artifacts include a deployed embedding target");
    expect(changelog).not.toContain("Live-canary coverage is currently restricted to LLM + embeddings");
  });

  it("documents voice pipeline as experimental instead of unsupported", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

    expect(readme).toContain(
      "| Voice pipeline | `client.voice.pipeline.create` | **Experimental**, pipeline-scoped route, not live-canary verified |",
    );
    expect(readme).not.toContain("Voice pipeline | `client.voice.pipeline.create` | Not shipped");
    expect(changelog).not.toContain("client.voice.pipeline.create` is not shipped");
    expect(changelog).toContain("client.voice.pipeline.create` posts audio to the pipeline-scoped `/pipeline` route");
    expect(source).toMatch(
      /\/\*\*[\s\S]*Voice pipeline surface\.[\s\S]*@experimental As of v0\.1\.4, this method has NOT been verified end-to-end[\s\S]*readonly voice:/u,
    );
  });

  it("documents safe base URL requirements", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

    expect(readme).toContain("Custom base URLs must use `http` or `https`.");
    expect(readme).toContain("Remote custom base URLs must use `https`.");
    expect(readme).toContain("local development hosts: `localhost`, `127.0.0.1`, `0.0.0.0`, and `[::1]`");
    expect(readme).toContain("Custom base URLs must not include usernames or passwords.");
    expect(readme).toContain("Custom base URLs must not include query strings or fragments.");
  });

  it("documents browser API-key protection and backend proxy posture", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const rootReadme = readFileSync(new URL("../../README.md", import.meta.url), "utf8");

    for (const text of [readme, rootReadme]) {
      expect(text).toMatch(/Do not put `RUNINFRA_API_KEY` in browser\s+code/u);
      expect(text).toContain("backend proxy");
      expect(text).toMatch(/Ephemeral\s+browser tokens are not shipped in v0\.1\.4/u);
    }

    expect(readme).toMatch(/The SDK fails closed\s+when it detects a browser runtime/u);
    expect(readme).toMatch(/dangerouslyAllowBrowser:\s+true/u);
  });

  it("documents explicit webhook secret environment guards instead of non-null assertions", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

    expect(readme).toContain("const webhookSecret = process.env.RUNINFRA_WEBHOOK_SECRET;");
    expect(readme).toContain("Set RUNINFRA_WEBHOOK_SECRET");
    expect(readme).not.toContain("process.env.RUNINFRA_WEBHOOK_SECRET!");
  });

  it("documents the full local webhook verification helper surface", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");

    expect(readme).toContain("constructWebhookEvent");
    expect(readme).toContain("verifyWebhookSignature");
    expect(readme).toContain("WebhookVerificationError");
    expect(readme).toContain("webhook delivery create/list methods are not part of the GA public SDK surface");
    expect(readme).not.toContain("client.webhooks.create");
    expect(readme).not.toContain("client.webhooks.list");
    expect(readme).toContain("`UnsupportedOperationError` remains exported for compatibility");
    expect(changelog).toContain("## [0.1.4]");
    expect(changelog).toContain("Removed unshipped webhook delivery `create` / `list` methods");
    expect(changelog).toContain("`webhooks.delivery_surface.absent`");
  });

  it("documents non-blank idempotency key requirements", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

    expect(readme).toContain("Idempotency keys must be non-blank");
    expect(readme).toContain("255 characters or less");
    expect(readme).toContain("must not contain secrets or personal data");
  });

  it("documents the exact replay-safe non-streaming JSON operations", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

    expect(readme).toContain("responses.create()");
    expect(readme).toContain("non-streaming `chat.completions.create()`");
    expect(readme).toContain("embeddings.create()");
    expect(readme).toContain("images.generate()");
    expect(readme).toContain("Streaming calls, binary TTS responses, and multipart ASR uploads are sent once");
    expect(readme).toContain("even when you provide an idempotency key");
    expect(readme).toContain("The gateway still binds idempotency keys for TTS and ASR");
  });

  it("documents TTS voice and reference-audio request modes", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

    expect(readme).toContain("Text to speech");
    expect(readme).toContain("RUNINFRA_TTS_VOICE");
    expect(readme).toContain("RUNINFRA_TTS_REF_AUDIO");
    expect(readme).toContain("RUNINFRA_TTS_REF_TEXT");
    expect(readme).toContain("ref_audio");
    expect(readme).toContain("ref_text");
    expect(readme).toContain("task_type");
    expect(readme).not.toContain('voice: process.env.RUNINFRA_TTS_VOICE ?? "default"');
  });

  it("documents TypeScript TTS stream ownership", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

    expect(readme).toContain("RunInfraAudioResponse.stream()");
    expect(readme).toMatch(/native\s+`ReadableStream<Uint8Array>`/u);
    expect(readme).toMatch(
      /the caller\s+owns `getReader\(\)`, cancellation, and slow-consumer backpressure/u,
    );
    expect(readme).toMatch(/The SDK does\s+not auto-retry or replay binary TTS streams/u);
  });

  it("documents the OpenAI-compatible parameter subset and local response-shape guards", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const liveCanaries = readFileSync(new URL("../../LIVE-CANARIES.md", import.meta.url), "utf8");
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");

    expect(readme).toContain("## OpenAI-compatible parameter scope");
    expect(readme).toContain("Live-gated native SDK subset");
    expect(readme).toContain("will be treated as verified only after the strict live canaries pass");
    expect(readme).toContain("`openai.params.chat.completions`");
    expect(readme).toContain("`openai.params.chat.stream_options`");
    expect(readme).toContain("`openai.params.responses`");
    expect(readme).toContain("`openai.params.embeddings`");
    expect(readme).toContain("`openai.params.images`");
    expect(readme).toContain("`openai.params.audio.speech`");
    expect(readme).toContain("`openai.params.audio.transcriptions`");
    expect(liveCanaries).toContain("openai.params.images");
    expect(liveCanaries).toContain("openai.params.audio.speech");
    expect(liveCanaries).toContain("openai.params.audio.transcriptions");
    expect(liveCanaries).toContain("RUNINFRA_TTS_RESPONSE_FORMAT");
    expect(liveCanaries).toContain("RUNINFRA_ASR_RESPONSE_FORMAT");
    expect(liveCanaries).toContain("Optional for the base ASR row; required for the OpenAI ASR parameter row");
    expect(readme).toContain("dimension control");
    expect(readme).toContain("Image `quality`, `style`, and `user` are typed pass-through OpenAI-style");
    expect(readme).toContain("They are not GA-verified until a strict image canary row asserts");
    expect(readme).toContain("`encoding_format` values other than `\"float\"`");
    expect(readme).toContain("`response_format` values other than `\"json\"` or `\"verbose_json\"`");
    expect(readme).toContain("Unsupported OpenAI-style body parameters must fail with a clear traced 4xx");
    expect(liveCanaries).toContain("error.model.not_found");
    expect(liveCanaries).toContain("error.body.unsupported_parameter");
    expect(liveCanaries).toContain("strict child canaries");
    expect(liveCanaries).toContain("against `https://api.runinfra.ai/v1`");
    expect(liveCanaries).toContain("A `RUNINFRA_BASE_URL` equal to `https://api.runinfra.ai/v1` is recorded as production");
    expect(liveCanaries).toContain("any other custom `RUNINFRA_BASE_URL`");
    expect(liveCanaries).toContain("custom base URLs before spawning child canaries");
    expect(readme).toContain("RunInfra `/v1/responses` is a chat-completions compatibility adapter.");
    expect(readme).toContain("forwards the supported request through the chat-completions serving path");
    expect(readme).toContain(
      "does not claim full OpenAI Responses state, include, reasoning, tool, conversation-item, or background-job semantics",
    );
    expect(liveCanaries).toContain("Responses rows prove the compatibility adapter");
    expect(source).toContain("Responses compatibility adapter");
    expect(source).toContain("not a full stateful OpenAI Responses implementation");
  });

  it("keeps child canaries in parity for chat stream options usage coverage", () => {
    const runner = readFileSync(new URL("../../scripts/run-sdk-live-canaries.mjs", import.meta.url), "utf8");
    const typescriptCanary = readFileSync(new URL("../../scripts/sdk-live-canary-typescript.mjs", import.meta.url), "utf8");
    const pythonCanary = readFileSync(new URL("../../scripts/sdk-live-canary-python.py", import.meta.url), "utf8");
    const liveCanaries = readFileSync(new URL("../../LIVE-CANARIES.md", import.meta.url), "utf8");

    for (const text of [runner, typescriptCanary, pythonCanary, liveCanaries]) {
      expect(text).toContain("openai.params.chat.stream_options");
      expect(text).toContain("stream_options");
      expect(text).toContain("include_usage");
    }
    expect(typescriptCanary).toContain("assertChatStreamUsageEvent");
    expect(typescriptCanary).toMatch(
      /function assertChatStreamUsageEvent[\s\S]*if \(!Array\.isArray\(event\.choices\) \|\|\s+event\.choices\.length !== 0\)/u,
    );
    expect(typescriptCanary).toContain("assertChatUsageObject");
    expect(typescriptCanary).toContain('"prompt_tokens"');
    expect(typescriptCanary).toContain('"completion_tokens"');
    expect(typescriptCanary).toContain('"total_tokens"');
    expect(typescriptCanary).toContain('usage: "present"');
    expect(pythonCanary).toContain("assert_chat_stream_usage_event");
    expect(pythonCanary).toContain("assert_chat_usage_object");
    expect(pythonCanary).toContain('"prompt_tokens"');
    expect(pythonCanary).toContain('"completion_tokens"');
    expect(pythonCanary).toContain('"total_tokens"');
    expect(pythonCanary).toContain('"usage": "present"');
    expect(typescriptCanary).toContain("assertChatStreamCompatibilityEvent");
    expect(typescriptCanary).toContain(
      "events.forEach((event, index) => assertChatStreamCompatibilityEvent(event, `chat stream event ${index}`))",
    );
    expect(typescriptCanary).toContain(
      "events.forEach((event, index) => assertChatStreamCompatibilityEvent(event, `chat slow-consumer stream event ${index}`))",
    );
    expect(typescriptCanary).toContain(
      "events.forEach((event, index) => assertChatStreamEnvelope(event, `chat cancellation stream event ${index}`))",
    );
    expect(pythonCanary).toContain("assert_chat_stream_compatibility_event");
    expect(pythonCanary).toContain(
      "assert_chat_stream_compatibility_event(event, f\"chat stream event {index}\")",
    );
    expect(pythonCanary).toContain(
      "assert_chat_stream_compatibility_event(event, f\"chat slow-consumer stream event {index}\")",
    );
    expect(pythonCanary).toContain(
      "assert_chat_stream_envelope(event, f\"chat cancellation stream event {index}\")",
    );
  });

  it("keeps child canaries in parity for live model-not-found error mapping", () => {
    const runner = readFileSync(new URL("../../scripts/run-sdk-live-canaries.mjs", import.meta.url), "utf8");
    const typescriptCanary = readFileSync(new URL("../../scripts/sdk-live-canary-typescript.mjs", import.meta.url), "utf8");
    const pythonCanary = readFileSync(new URL("../../scripts/sdk-live-canary-python.py", import.meta.url), "utf8");

    expect(runner).toContain('"error.model.not_found"');
    expect(typescriptCanary).toContain("ModelNotFoundError");
    expect(typescriptCanary).toContain('record("error.model.not_found"');
    expect(typescriptCanary).toContain("runinfra-sdk-canary-missing-model");
    expect(pythonCanary).toContain("ModelNotFoundError");
    expect(pythonCanary).toContain('record("error.model.not_found"');
    expect(pythonCanary).toContain("runinfra-sdk-canary-missing-model");
  });

  it("keeps child canaries in parity for local rate-limit error mapping", async () => {
    const { expectedRows } = await import("../../scripts/live-canary-matrix.mjs") as { expectedRows: string[] };
    const { publicSurfaceCoverage } =
      await import("../../scripts/live-canary-surface-coverage.mjs") as {
        publicSurfaceCoverage: Array<{ surface: string; rows: string[] }>;
      };
    const runner = readFileSync(new URL("../../scripts/run-sdk-live-canaries.mjs", import.meta.url), "utf8");
    const typescriptCanary = readFileSync(new URL("../../scripts/sdk-live-canary-typescript.mjs", import.meta.url), "utf8");
    const pythonCanary = readFileSync(new URL("../../scripts/sdk-live-canary-python.py", import.meta.url), "utf8");
    const liveCanaries = readFileSync(new URL("../../LIVE-CANARIES.md", import.meta.url), "utf8");
    const row = "error.rate_limit.local";

    expect(expectedRows).toContain(row);
    expect(runner).toContain(`["${row}", () => []]`);
    expect(typescriptCanary).toContain(`record("${row}"`);
    expect(typescriptCanary).toContain("RateLimitError");
    expect(typescriptCanary).toContain("retryAfterMs");
    expect(pythonCanary).toContain(`"${row}"`);
    expect(pythonCanary).toContain("RateLimitError");
    expect(pythonCanary).toContain("retry_after_seconds");
    expect(liveCanaries).toContain(row);
    expect(liveCanaries).toContain("rate-limit");
    expect(publicSurfaceCoverage.find((entry) => entry.surface === "error mapping")?.rows)
      .toContain(row);
  });

  it("keeps child canaries in parity for local insufficient-credits error mapping", async () => {
    const { expectedRows } = await import("../../scripts/live-canary-matrix.mjs") as { expectedRows: string[] };
    const { publicSurfaceCoverage } =
      await import("../../scripts/live-canary-surface-coverage.mjs") as {
        publicSurfaceCoverage: Array<{ surface: string; rows: string[] }>;
      };
    const runner = readFileSync(new URL("../../scripts/run-sdk-live-canaries.mjs", import.meta.url), "utf8");
    const typescriptCanary = readFileSync(new URL("../../scripts/sdk-live-canary-typescript.mjs", import.meta.url), "utf8");
    const pythonCanary = readFileSync(new URL("../../scripts/sdk-live-canary-python.py", import.meta.url), "utf8");
    const liveCanaries = readFileSync(new URL("../../LIVE-CANARIES.md", import.meta.url), "utf8");
    const row = "error.insufficient_credits.local";

    expect(expectedRows).toContain(row);
    expect(runner).toContain(`["${row}", () => []]`);
    expect(typescriptCanary).toContain(`record("${row}"`);
    expect(typescriptCanary).toContain("InsufficientCreditsError");
    expect(pythonCanary).toContain(`"${row}"`);
    expect(pythonCanary).toContain("InsufficientCreditsError");
    expect(liveCanaries).toContain(row);
    expect(liveCanaries).toContain("insufficient-credits");
    expect(publicSurfaceCoverage.find((entry) => entry.surface === "error mapping")?.rows)
      .toContain(row);

    const typescriptRowStart = typescriptCanary.indexOf(`await record("${row}"`);
    const typescriptRowEnd = typescriptCanary.indexOf('await record("error.rate_limit.local"', typescriptRowStart);
    const typescriptRow = typescriptCanary.slice(typescriptRowStart, typescriptRowEnd);
    const pythonRowStart = pythonCanary.indexOf("def _insufficient_credits_error_local()");
    const pythonRowEnd = pythonCanary.indexOf("def _rate_limit_error_local()", pythonRowStart);
    const pythonRow = pythonCanary.slice(pythonRowStart, pythonRowEnd);

    expect(typescriptRow).not.toContain("maxRetries: 0");
    expect(pythonRow).not.toContain('"max_retries": 0');
  });

  it("fails models.list live canaries when configured model ids are absent from the catalog", () => {
    const typescriptCanary = readFileSync(new URL("../../scripts/sdk-live-canary-typescript.mjs", import.meta.url), "utf8");
    const pythonCanary = readFileSync(new URL("../../scripts/sdk-live-canary-python.py", import.meta.url), "utf8");
    const liveCanaries = readUtf8Normalized(new URL("../../LIVE-CANARIES.md", import.meta.url));

    expect(typescriptCanary).toContain("configuredCanaryModelIds");
    expect(typescriptCanary).toContain("assertConfiguredModelsListed(response.data)");
    expect(typescriptCanary).toContain("models.list did not include");
    expect(typescriptCanary).not.toContain("missing.join");
    expect(pythonCanary).toContain("configured_canary_model_ids");
    expect(pythonCanary).toContain('assert_configured_models_listed(response["data"])');
    expect(pythonCanary).toContain("models.list did not include");
    expect(pythonCanary).not.toContain("join(missing");
    expect(liveCanaries).toContain("`models.list` must\ninclude every configured canary model ID");
    expect(liveCanaries).toContain("Reports record\nonly the item count");
  });

  it("keeps unshipped webhook delivery methods out of artifact and canary public surface", () => {
    const runner = readFileSync(new URL("../../scripts/run-sdk-live-canaries.mjs", import.meta.url), "utf8");
    const typescriptCanary = readFileSync(new URL("../../scripts/sdk-live-canary-typescript.mjs", import.meta.url), "utf8");
    const pythonCanary = readFileSync(new URL("../../scripts/sdk-live-canary-python.py", import.meta.url), "utf8");
    const cleanInstallVerifier = readFileSync(new URL("../../scripts/verify-clean-installs.mjs", import.meta.url), "utf8");
    const liveCanaries = readFileSync(new URL("../../LIVE-CANARIES.md", import.meta.url), "utf8");

    for (const text of [runner, typescriptCanary, pythonCanary, cleanInstallVerifier, liveCanaries]) {
      expect(text).toContain("webhooks.delivery_surface.absent");
      expect(text).not.toContain("webhooks.create.unsupported");
      expect(text).not.toContain("webhooks.list.unsupported");
    }
    expect(cleanInstallVerifier).toContain('typeof client.webhooks.create !== "undefined"');
    expect(cleanInstallVerifier).toContain('typeof client.webhooks.list !== "undefined"');
    expect(cleanInstallVerifier).toContain('hasattr(client.webhooks, "create")');
    expect(cleanInstallVerifier).toContain('hasattr(client.webhooks, "list")');
  });

  it("preflights registry clean installs against both exact package versions", async () => {
    const preflight = await import("../../scripts/registry-version-preflight.mjs") as {
      registryVersionChecks: (version: string, packageSelection: "both" | "typescript" | "python") => Array<{
        label: string;
        packageName: string;
        version: string;
        url: string;
      }>;
      registryAvailabilityErrors: (
        checks: Array<{ label: string; packageName: string; version: string; url: string }>,
        packageExists: (url: string) => Promise<boolean>,
      ) => Promise<string[]>;
    };

    const checks = preflight.registryVersionChecks("0.1.4", "both");
    expect(checks).toEqual([
      {
        label: "npm",
        packageName: "@runinfra/sdk",
        version: "0.1.4",
        url: "https://registry.npmjs.org/%40runinfra%2Fsdk/0.1.4",
      },
      {
        label: "PyPI",
        packageName: "runinfra",
        version: "0.1.4",
        url: "https://pypi.org/pypi/runinfra/0.1.4/json",
      },
    ]);

    await expect(preflight.registryAvailabilityErrors(checks, async (url) => !url.includes("pypi"))).resolves.toEqual([
      "PyPI package runinfra==0.1.4 is not available from the canonical registry.",
    ]);
    await expect(preflight.registryAvailabilityErrors(checks, async () => false)).resolves.toEqual([
      "npm package @runinfra/sdk@0.1.4 is not available from the canonical registry.",
      "PyPI package runinfra==0.1.4 is not available from the canonical registry.",
    ]);
    expect(preflight.registryVersionChecks("0.1.4", "typescript").map((check) => check.label)).toEqual(["npm"]);
    expect(preflight.registryVersionChecks("0.1.4", "python").map((check) => check.label)).toEqual(["PyPI"]);
  });

  it("fails the release gate on open high or critical GitHub code-scanning alerts", async () => {
    const alerts = [
      {
        number: 1,
        state: "open",
        html_url: "https://github.com/RightNow-AI/runinfra-sdk/security/code-scanning/1",
        rule: { id: "js/sql-injection", security_severity_level: "high" },
      },
      {
        number: 2,
        state: "open",
        html_url: "https://github.com/RightNow-AI/runinfra-sdk/security/code-scanning/2",
        rule: { id: "js/hardcoded-credential", security_severity_level: "critical" },
      },
      {
        number: 3,
        state: "open",
        rule: { id: "js/unused-local-variable", severity: "error" },
      },
      {
        number: 4,
        state: "dismissed",
        rule: { id: "js/xss", security_severity_level: "critical" },
      },
      {
        number: 5,
        state: "open",
        rule: { id: "js/path-injection", security_severity_level: "medium" },
      },
    ];

    const moduleURL = new URL("../../scripts/verify-github-security-status.mjs", import.meta.url).href;
    const result = spawnSync(process.execPath, [
      "--input-type=module",
      "-e",
      `
const security = await import(${JSON.stringify(moduleURL)});
const alerts = ${JSON.stringify(alerts)};
const blockingNumbers = security.highOrCriticalCodeScanningAlerts(alerts).map((alert) => alert.number);
const blockingErrors = await security.githubSecurityStatusErrors({
  repository: "RightNow-AI/runinfra-sdk",
  fetchCodeScanningAlerts: async () => alerts,
});
const cleanErrors = await security.githubSecurityStatusErrors({
  repository: "RightNow-AI/runinfra-sdk",
  fetchCodeScanningAlerts: async () => [],
});
console.log(JSON.stringify({ blockingNumbers, blockingErrors, cleanErrors }));
      `,
    ], { encoding: "utf8" });
    expect(result.status).toBe(0);
    expect(result.stderr).toBe("");

    const output = JSON.parse(result.stdout) as {
      blockingNumbers: number[];
      blockingErrors: string[];
      cleanErrors: string[];
    };
    expect(output.blockingNumbers).toEqual([1, 2]);
    expect(output.blockingErrors).toEqual([
      "GitHub code scanning has 2 open high/critical alerts for RightNow-AI/runinfra-sdk.",
      "Open high/critical alert #1: https://github.com/RightNow-AI/runinfra-sdk/security/code-scanning/1",
      "Open high/critical alert #2: https://github.com/RightNow-AI/runinfra-sdk/security/code-scanning/2",
    ]);
    expect(output.cleanErrors).toEqual([]);
  });

  it("reports explicit production child canary base URLs without exposing custom staging URLs", async () => {
    const helper = await import("../../scripts/canary-report-base-url.mjs") as {
      productionBaseURL: string;
      reportBaseURL: (value: string, hasCustomBaseURL: boolean) => string;
    };

    expect(helper.productionBaseURL).toBe("https://api.runinfra.ai/v1");
    expect(helper.reportBaseURL(helper.productionBaseURL, false)).toBe(helper.productionBaseURL);
    expect(helper.reportBaseURL(helper.productionBaseURL, true)).toBe(helper.productionBaseURL);
    expect(helper.reportBaseURL("https://staging.runinfra.ai/v1", true)).toBe("custom_set_redacted");
  });

  it("rejects promotion reports that omit canonical live canary rows", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-promotion-short-matrix-"));
    const readinessPath = join(tmp, "readiness.json");
    const livePath = join(tmp, "live.json");
    const digest = "a".repeat(64);
    const expectedRows = ["models.list", "chat.completions.create"];
    const surfaceCoverage = {
      status: "passed",
      errors: [],
      uncoveredSurfaces: [],
      uncoveredRows: [],
      rowCount: expectedRows.length,
    };
    const readiness = {
      schemaVersion: 1,
      strict: true,
      packageSource: "artifact",
      candidate: {
        sdkVersion: RUNINFRA_SDK_VERSION,
        packageSource: "artifact",
        sourceDigestSha256: digest,
        sourceFileCount: 8,
        artifactDigestsChecked: false,
        artifacts: [],
      },
      expectedRows,
      readiness: {
        status: "ready",
        missing: [],
        rowCoverageErrors: [],
        summary: { ready: expectedRows.length, blocked: 0 },
        rows: expectedRows.map((name) => ({ name, status: "ready", missing: [] })),
      },
      surfaceCoverage,
      parity: { status: "not_run", errors: [] },
      reports: [],
    };
    const live = {
      schemaVersion: 1,
      strict: true,
      packageSource: "artifact",
      candidate: {
        sdkVersion: RUNINFRA_SDK_VERSION,
        packageSource: "artifact",
        sourceDigestSha256: digest,
        sourceFileCount: 8,
        artifactDigestsChecked: true,
        artifacts: [
          { name: "npm", fileName: `runinfra-sdk-${RUNINFRA_SDK_VERSION}.tgz`, sha256: "b".repeat(64) },
          { name: "pythonWheel", fileName: `runinfra-${RUNINFRA_SDK_VERSION}-py3-none-any.whl`, sha256: "c".repeat(64) },
          { name: "pythonSdist", fileName: `runinfra-${RUNINFRA_SDK_VERSION}.tar.gz`, sha256: "d".repeat(64) },
        ],
      },
      expectedRows,
      surfaceCoverage,
      parity: { status: "passed", errors: [] },
      reports: ["typescript", "python"].map((language) => ({
        language,
        sdkVersion: RUNINFRA_SDK_VERSION,
        strict: true,
        baseURL: "https://api.runinfra.ai/v1",
        summary: { passed: expectedRows.length, failed: 0, skipped: 0 },
        results: expectedRows.map((name) => ({ name, status: "passed" })),
      })),
    };

    try {
      writeFileSync(readinessPath, `${JSON.stringify(readiness, null, 2)}\n`);
      writeFileSync(livePath, `${JSON.stringify(live, null, 2)}\n`);

      const result = spawnSync(process.execPath, [
        "../scripts/verify-promotion-reports.mjs",
        "--readiness",
        readinessPath,
        "--live",
        livePath,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain("expectedRows must match the canonical live canary matrix");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects promotion reports that merge canonical row boundaries with newlines", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-promotion-newline-matrix-"));
    const readinessPath = join(tmp, "readiness.json");
    const livePath = join(tmp, "live.json");
    const digest = "a".repeat(64);
    const matrix = await import("../../scripts/live-canary-matrix.mjs") as { expectedRows: string[] };
    const expectedRows = [`${matrix.expectedRows[0]}\n${matrix.expectedRows[1]}`, ...matrix.expectedRows.slice(2)];
    const surfaceCoverage = {
      status: "passed",
      errors: [],
      uncoveredSurfaces: [],
      uncoveredRows: [],
      rowCount: expectedRows.length,
    };
    const readiness = {
      schemaVersion: 1,
      strict: true,
      packageSource: "artifact",
      candidate: {
        sdkVersion: RUNINFRA_SDK_VERSION,
        packageSource: "artifact",
        sourceDigestSha256: digest,
        sourceFileCount: 8,
        artifactDigestsChecked: false,
        artifacts: [],
      },
      expectedRows,
      readiness: {
        status: "ready",
        missing: [],
        rowCoverageErrors: [],
        summary: { ready: expectedRows.length, blocked: 0 },
        rows: expectedRows.map((name) => ({ name, status: "ready", missing: [] })),
      },
      surfaceCoverage,
      parity: { status: "not_run", errors: [] },
      reports: [],
    };
    const live = {
      schemaVersion: 1,
      strict: true,
      packageSource: "artifact",
      candidate: {
        sdkVersion: RUNINFRA_SDK_VERSION,
        packageSource: "artifact",
        sourceDigestSha256: digest,
        sourceFileCount: 8,
        artifactDigestsChecked: true,
        artifacts: [
          { name: "npm", fileName: `runinfra-sdk-${RUNINFRA_SDK_VERSION}.tgz`, sha256: "b".repeat(64) },
          { name: "pythonWheel", fileName: `runinfra-${RUNINFRA_SDK_VERSION}-py3-none-any.whl`, sha256: "c".repeat(64) },
          { name: "pythonSdist", fileName: `runinfra-${RUNINFRA_SDK_VERSION}.tar.gz`, sha256: "d".repeat(64) },
        ],
      },
      expectedRows,
      surfaceCoverage,
      parity: { status: "passed", errors: [] },
      reports: ["typescript", "python"].map((language) => ({
        language,
        sdkVersion: RUNINFRA_SDK_VERSION,
        strict: true,
        baseURL: "https://api.runinfra.ai/v1",
        summary: { passed: expectedRows.length, failed: 0, skipped: 0 },
        results: expectedRows.map((name) => ({ name, status: "passed" })),
      })),
    };

    try {
      writeFileSync(readinessPath, `${JSON.stringify(readiness, null, 2)}\n`);
      writeFileSync(livePath, `${JSON.stringify(live, null, 2)}\n`);

      const result = spawnSync(process.execPath, [
        "../scripts/verify-promotion-reports.mjs",
        "--readiness",
        readinessPath,
        "--live",
        livePath,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain("row name must not contain control characters");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects promotion reports with stale surface coverage that omits uncovered rows", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-promotion-stale-surface-coverage-"));
    const readinessPath = join(tmp, "readiness.json");
    const livePath = join(tmp, "live.json");
    const digest = "a".repeat(64);
    const matrix = await import("../../scripts/live-canary-matrix.mjs") as { expectedRows: string[] };
    const expectedRows = matrix.expectedRows;
    const surfaceCoverage = { status: "passed", errors: [], uncoveredSurfaces: [], rowCount: expectedRows.length };
    const readiness = {
      schemaVersion: 1,
      strict: true,
      packageSource: "artifact",
      candidate: {
        sdkVersion: RUNINFRA_SDK_VERSION,
        packageSource: "artifact",
        sourceDigestSha256: digest,
        sourceFileCount: 8,
        artifactDigestsChecked: false,
        artifacts: [],
      },
      expectedRows,
      readiness: {
        status: "ready",
        missing: [],
        rowCoverageErrors: [],
        summary: { ready: expectedRows.length, blocked: 0 },
        rows: expectedRows.map((name) => ({ name, status: "ready", missing: [] })),
      },
      surfaceCoverage,
      parity: { status: "not_run", errors: [] },
      reports: [],
    };
    const live = {
      schemaVersion: 1,
      strict: true,
      packageSource: "artifact",
      candidate: {
        sdkVersion: RUNINFRA_SDK_VERSION,
        packageSource: "artifact",
        sourceDigestSha256: digest,
        sourceFileCount: 8,
        artifactDigestsChecked: true,
        artifacts: [
          { name: "npm", fileName: `runinfra-sdk-${RUNINFRA_SDK_VERSION}.tgz`, sha256: "b".repeat(64) },
          { name: "pythonWheel", fileName: `runinfra-${RUNINFRA_SDK_VERSION}-py3-none-any.whl`, sha256: "c".repeat(64) },
        ],
      },
      expectedRows,
      surfaceCoverage,
      parity: { status: "passed", errors: [] },
      reports: ["typescript", "python"].map((language) => ({
        language,
        sdkVersion: RUNINFRA_SDK_VERSION,
        strict: true,
        baseURL: "https://api.runinfra.ai/v1",
        summary: { passed: expectedRows.length, failed: 0, skipped: 0 },
        results: expectedRows.map((name) => ({ name, status: "passed" })),
      })),
    };

    try {
      writeFileSync(readinessPath, `${JSON.stringify(readiness, null, 2)}\n`);
      writeFileSync(livePath, `${JSON.stringify(live, null, 2)}\n`);

      const result = spawnSync(process.execPath, [
        "../scripts/verify-promotion-reports.mjs",
        "--readiness",
        readinessPath,
        "--live",
        livePath,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain("uncovered rows must be empty");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects promotion reports with stale surface coverage manifests", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-promotion-stale-surface-manifest-"));
    const readinessPath = join(tmp, "readiness.json");
    const livePath = join(tmp, "live.json");
    const digest = "a".repeat(64);
    const matrix = await import("../../scripts/live-canary-matrix.mjs") as { expectedRows: string[] };
    const expectedRows = matrix.expectedRows;
    const surfaceCoverage = {
      status: "passed",
      errors: [],
      uncoveredSurfaces: [],
      uncoveredRows: [],
      surfaces: ["client.models.list"],
      surfaceCount: 1,
      rowCount: expectedRows.length,
    };
    const readiness = {
      schemaVersion: 1,
      strict: true,
      packageSource: "artifact",
      candidate: {
        sdkVersion: RUNINFRA_SDK_VERSION,
        packageSource: "artifact",
        sourceDigestSha256: digest,
        sourceFileCount: 8,
        artifactDigestsChecked: false,
        artifacts: [],
      },
      expectedRows,
      readiness: {
        status: "ready",
        missing: [],
        rows: expectedRows.map((name) => ({ name, status: "ready", missing: [] })),
      },
      surfaceCoverage,
      parity: { status: "not_run", errors: [] },
      reports: [],
    };
    const live = {
      schemaVersion: 1,
      strict: true,
      packageSource: "artifact",
      candidate: {
        sdkVersion: RUNINFRA_SDK_VERSION,
        packageSource: "artifact",
        sourceDigestSha256: digest,
        sourceFileCount: 8,
        artifactDigestsChecked: true,
        artifacts: [
          { name: "npm", fileName: `runinfra-sdk-${RUNINFRA_SDK_VERSION}.tgz`, sha256: "b".repeat(64) },
          { name: "pythonWheel", fileName: `runinfra-${RUNINFRA_SDK_VERSION}-py3-none-any.whl`, sha256: "c".repeat(64) },
        ],
      },
      expectedRows,
      surfaceCoverage,
      parity: { status: "passed", errors: [] },
      reports: ["typescript", "python"].map((language) => ({
        language,
        sdkVersion: RUNINFRA_SDK_VERSION,
        strict: true,
        baseURL: "https://api.runinfra.ai/v1",
        results: expectedRows.map((name) => ({ name, status: "passed" })),
      })),
    };

    try {
      writeFileSync(readinessPath, `${JSON.stringify(readiness, null, 2)}\n`);
      writeFileSync(livePath, `${JSON.stringify(live, null, 2)}\n`);

      const result = spawnSync(process.execPath, [
        "../scripts/verify-promotion-reports.mjs",
        "--readiness",
        readinessPath,
        "--live",
        livePath,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain("surface coverage surfaces must match the canonical public surface coverage manifest");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("verifies promotion reports use the same candidate digest and all-passed artifact canaries", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-promotion-reports-"));
    const readinessPath = join(tmp, "readiness.json");
    const livePath = join(tmp, "live.json");
    const artifactRoot = join(tmp, "artifact-root");
    const npmPath = join(artifactRoot, "typescript", `runinfra-sdk-${RUNINFRA_SDK_VERSION}.tgz`);
    const wheelPath = join(artifactRoot, "python", "dist", `runinfra-${RUNINFRA_SDK_VERSION}-py3-none-any.whl`);
    const sdistPath = join(artifactRoot, "python", "dist", `runinfra-${RUNINFRA_SDK_VERSION}.tar.gz`);
    mkdirSync(join(artifactRoot, "typescript"), { recursive: true });
    mkdirSync(join(artifactRoot, "python", "dist"), { recursive: true });
    writeFileSync(npmPath, "current npm artifact\n");
    writeFileSync(wheelPath, "current Python wheel\n");
    writeFileSync(sdistPath, "current Python sdist\n");
    const sha256File = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
    const identity = await currentPromotionSourceIdentity();
    const digest = identity.sourceDigestSha256;
    const matrix = await import("../../scripts/live-canary-matrix.mjs") as { expectedRows: string[] };
    const coverageManifest = await import("../../scripts/live-canary-surface-coverage.mjs") as {
      publicSurfaceCoverage: Array<{ surface: string }>;
    };
    const expectedRows = matrix.expectedRows;
    const surfaces = coverageManifest.publicSurfaceCoverage.map((entry) => entry.surface);
    const sourceFileCount = identity.sourceFileCount;
    const liveArtifacts = [
      { name: "npm", fileName: `runinfra-sdk-${RUNINFRA_SDK_VERSION}.tgz`, sha256: sha256File(npmPath) },
      { name: "pythonWheel", fileName: `runinfra-${RUNINFRA_SDK_VERSION}-py3-none-any.whl`, sha256: sha256File(wheelPath) },
      { name: "pythonSdist", fileName: `runinfra-${RUNINFRA_SDK_VERSION}.tar.gz`, sha256: sha256File(sdistPath) },
    ];
    const surfaceCoverage = {
      status: "passed",
      errors: [],
      uncoveredSurfaces: [],
      uncoveredRows: [],
      surfaces,
      surfaceCount: surfaces.length,
      rowCount: matrix.expectedRows.length,
    };
    const readiness = {
      schemaVersion: 1,
      strict: true,
      packageSource: "artifact",
      candidate: {
        sdkVersion: RUNINFRA_SDK_VERSION,
        packageSource: "artifact",
        sourceDigestSha256: digest,
        sourceFileCount,
        artifactDigestsChecked: false,
        artifacts: [],
      },
      expectedRows,
      readiness: {
        status: "ready",
        missing: [],
        rowCoverageErrors: [],
        summary: { ready: expectedRows.length, blocked: 0 },
        rows: expectedRows.map((name) => ({ name, status: "ready", missing: [] })),
      },
      surfaceCoverage,
      parity: { status: "not_run", errors: [] },
      reports: [],
    };
    const live = {
      schemaVersion: 1,
      strict: true,
      packageSource: "artifact",
      candidate: {
        sdkVersion: RUNINFRA_SDK_VERSION,
        packageSource: "artifact",
        sourceDigestSha256: digest,
        sourceFileCount,
        artifactDigestsChecked: true,
        artifacts: liveArtifacts,
      },
      expectedRows,
      surfaceCoverage,
      parity: { status: "passed", errors: [] },
      reports: ["typescript", "python"].map((language) => ({
        language,
        sdkVersion: RUNINFRA_SDK_VERSION,
        strict: true,
        baseURL: "https://api.runinfra.ai/v1",
        summary: { passed: expectedRows.length, failed: 0, skipped: 0 },
        results: expectedRows.map((name) => ({ name, status: "passed" })),
      })),
    };
    const promotionArgs = [
      "../scripts/verify-promotion-reports.mjs",
      "--readiness",
      readinessPath,
      "--live",
      livePath,
      "--artifacts-root",
      artifactRoot,
    ];

    try {
      writeFileSync(readinessPath, `${JSON.stringify(readiness, null, 2)}\n`);
      writeFileSync(livePath, `${JSON.stringify(live, null, 2)}\n`);

      const missingArtifactsRoot = spawnSync(process.execPath, [
        "../scripts/verify-promotion-reports.mjs",
        "--readiness",
        readinessPath,
        "--live",
        livePath,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });
      expect(missingArtifactsRoot.status).toBe(1);
      expect(`${missingArtifactsRoot.stdout}${missingArtifactsRoot.stderr}`).toContain(
        "artifacts-root is required",
      );

      const success = spawnSync(process.execPath, [
        ...promotionArgs,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });
      expect(success.status, success.stdout + success.stderr).toBe(0);
      expect(success.stdout).toContain(`Verified promotion reports for SDK ${RUNINFRA_SDK_VERSION}`);

      writeFileSync(livePath, `${JSON.stringify({
        ...live,
        reports: live.reports.map((report) =>
          report.language === "typescript"
            ? { ...report, summary: { passed: expectedRows.length - 1, failed: 0, skipped: 0 } }
            : report,
        ),
      }, null, 2)}\n`);
      const mismatchedSummary = spawnSync(process.execPath, [
        ...promotionArgs,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });

      expect(mismatchedSummary.status).toBe(1);
      expect(`${mismatchedSummary.stdout}${mismatchedSummary.stderr}`).toContain(
        `typescript summary passed count must be ${expectedRows.length}`,
      );
      writeFileSync(livePath, `${JSON.stringify(live, null, 2)}\n`);

      writeFileSync(readinessPath, `${JSON.stringify({
        ...readiness,
        readiness: {
          ...readiness.readiness,
          summary: { ready: expectedRows.length - 1, blocked: 1 },
        },
      }, null, 2)}\n`);
      const mismatchedReadinessSummary = spawnSync(process.execPath, [
        ...promotionArgs,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });

      expect(mismatchedReadinessSummary.status).toBe(1);
      expect(`${mismatchedReadinessSummary.stdout}${mismatchedReadinessSummary.stderr}`).toContain(
        `readiness summary ready count must be ${expectedRows.length}`,
      );
      expect(`${mismatchedReadinessSummary.stdout}${mismatchedReadinessSummary.stderr}`).toContain(
        "readiness summary blocked count must be 0",
      );
      writeFileSync(readinessPath, `${JSON.stringify(readiness, null, 2)}\n`);

      writeFileSync(readinessPath, `${JSON.stringify({
        ...readiness,
        readiness: {
          ...readiness.readiness,
          rowCoverageErrors: ["readiness requirements missing strict matrix rows: images.generate"],
        },
      }, null, 2)}\n`);
      const staleReadinessCoverage = spawnSync(process.execPath, [
        ...promotionArgs,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });

      expect(staleReadinessCoverage.status).toBe(1);
      expect(`${staleReadinessCoverage.stdout}${staleReadinessCoverage.stderr}`).toContain(
        "readiness report row coverage errors must be empty",
      );
      const liveCanaryDocs = readFileSync(new URL("../../LIVE-CANARIES.md", import.meta.url), "utf8");
      expect(liveCanaryDocs).toContain("requires readiness `rowCoverageErrors` to be");
      expect(liveCanaryDocs).toContain("readiness `summary.ready` to equal the canonical matrix row count");
      expect(liveCanaryDocs).toContain("readiness `summary.blocked` to be `0`");

      writeFileSync(readinessPath, `${JSON.stringify(readiness, null, 2)}\n`);

      writeFileSync(livePath, `${JSON.stringify({
        ...live,
        candidate: {
          ...live.candidate,
          artifacts: liveArtifacts.map((artifact) =>
            artifact.name === "pythonSdist"
              ? { ...artifact, fileName: "runinfra-0.0.0.tar.gz" }
              : artifact,
          ),
        },
      }, null, 2)}\n`);
      const staleSdistFileName = spawnSync(process.execPath, [
        ...promotionArgs,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });

      expect(staleSdistFileName.status).toBe(1);
      expect(`${staleSdistFileName.stdout}${staleSdistFileName.stderr}`).toContain(
        `candidate artifact pythonSdist fileName must be runinfra-${RUNINFRA_SDK_VERSION}.tar.gz`,
      );

      for (const diagnostic of [
        "failed loading /root/private/secret-project/config.json",
        "failed loading /workspace/private/secret-project/config.json",
        "failed loading /etc/ssl/private/key.pem",
        "failed loading /etc/passwd",
        "failed loading C:\\secret.txt",
        "failed loading C:/secret.txt",
        "failed loading D:/logs/output.txt",
        "failed loading \\\\server\\share\\private\\secret-project\\config.json",
        "failed loading //server/share/private/secret-project/config.json",
        "failed loading \\\\server\\private\\secret-project\\config.json",
        "failed loading //server/private/secret-project/config.json",
        "failed loading \\\\server\\share\\secret-project\\config.json",
        "failed loading //server/share/secret-project/config.json",
      ]) {
        writeFileSync(livePath, `${JSON.stringify({
          ...live,
          diagnostic,
        }, null, 2)}\n`);
        const leakedPath = spawnSync(process.execPath, [
          ...promotionArgs,
        ], {
          cwd: new URL("..", import.meta.url),
          encoding: "utf8",
        });

        expect(leakedPath.status).toBe(1);
        expect(`${leakedPath.stdout}${leakedPath.stderr}`).toContain("absolute private path");
      }

      writeFileSync(livePath, `${JSON.stringify({
        ...live,
        candidate: { ...live.candidate, sourceDigestSha256: "d".repeat(64) },
      }, null, 2)}\n`);
      const mismatch = spawnSync(process.execPath, [
        ...promotionArgs,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });

      expect(mismatch.status).toBe(1);
      expect(`${mismatch.stdout}${mismatch.stderr}`).toContain("candidate source digest mismatch");

      writeFileSync(livePath, `${JSON.stringify({
        ...live,
        reports: live.reports.map((report) =>
          report.language === "typescript"
            ? { ...report, baseURL: "custom_set_redacted" }
            : report,
        ),
      }, null, 2)}\n`);
      const customBaseUrl = spawnSync(process.execPath, [
        ...promotionArgs,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });

      expect(customBaseUrl.status).toBe(1);
      expect(`${customBaseUrl.stdout}${customBaseUrl.stderr}`).toContain("child report baseURL must be https://api.runinfra.ai/v1");

      writeFileSync(livePath, `${JSON.stringify({
        ...live,
        reports: live.reports.map((report) =>
          report.language === "python"
            ? { ...report, strict: false }
            : report,
        ),
      }, null, 2)}\n`);
      const nonStrictChild = spawnSync(process.execPath, [
        ...promotionArgs,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });

      expect(nonStrictChild.status).toBe(1);
      expect(`${nonStrictChild.stdout}${nonStrictChild.stderr}`).toContain("child report must be strict");

      const staleSameCountDigest = digest === "a".repeat(64) ? "b".repeat(64) : "a".repeat(64);
      writeFileSync(readinessPath, `${JSON.stringify({
        ...readiness,
        candidate: { ...readiness.candidate, sourceDigestSha256: staleSameCountDigest },
      }, null, 2)}\n`);
      writeFileSync(livePath, `${JSON.stringify({
        ...live,
        candidate: { ...live.candidate, sourceDigestSha256: staleSameCountDigest },
      }, null, 2)}\n`);
      const staleSameCount = spawnSync(process.execPath, [
        ...promotionArgs,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });

      expect(staleSameCount.status).toBe(1);
      expect(`${staleSameCount.stdout}${staleSameCount.stderr}`).toContain(
        "candidate source digest must match the current canonical promotion source digest",
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 60_000);

  it("rejects promotion reports whose artifact digests do not match staged artifacts", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-promotion-artifact-digest-"));
    const readinessPath = join(tmp, "readiness.json");
    const livePath = join(tmp, "live.json");
    const artifactRoot = join(tmp, "artifact-root");
    const wheelPath = join(artifactRoot, "python", "dist", `runinfra-${RUNINFRA_SDK_VERSION}-py3-none-any.whl`);
    const sdistPath = join(artifactRoot, "python", "dist", `runinfra-${RUNINFRA_SDK_VERSION}.tar.gz`);
    mkdirSync(join(artifactRoot, "typescript"), { recursive: true });
    mkdirSync(join(artifactRoot, "python", "dist"), { recursive: true });
    const npmPath = join(artifactRoot, "typescript", `runinfra-sdk-${RUNINFRA_SDK_VERSION}.tgz`);
    writeFileSync(npmPath, "current npm artifact\n");
    writeFileSync(wheelPath, "current Python wheel\n");
    writeFileSync(sdistPath, "current Python sdist\n");
    const sha256File = (path: string): string => createHash("sha256").update(readFileSync(path)).digest("hex");
    const identity = await currentPromotionSourceIdentity();
    const matrix = await import("../../scripts/live-canary-matrix.mjs") as { expectedRows: string[] };
    const coverageManifest = await import("../../scripts/live-canary-surface-coverage.mjs") as {
      publicSurfaceCoverage: Array<{ surface: string }>;
    };
    const expectedRows = matrix.expectedRows;
    const surfaces = coverageManifest.publicSurfaceCoverage.map((entry) => entry.surface);
    const surfaceCoverage = {
      status: "passed",
      errors: [],
      uncoveredSurfaces: [],
      uncoveredRows: [],
      surfaces,
      surfaceCount: surfaces.length,
      rowCount: expectedRows.length,
    };
    const readiness = {
      schemaVersion: 1,
      strict: true,
      packageSource: "artifact",
      candidate: {
        sdkVersion: RUNINFRA_SDK_VERSION,
        packageSource: "artifact",
        sourceDigestSha256: identity.sourceDigestSha256,
        sourceFileCount: identity.sourceFileCount,
        artifactDigestsChecked: false,
        artifacts: [],
      },
      expectedRows,
      readiness: {
        status: "ready",
        missing: [],
        rowCoverageErrors: [],
        rows: expectedRows.map((name) => ({ name, status: "ready", missing: [] })),
      },
      surfaceCoverage,
      parity: { status: "not_run", errors: [] },
      reports: [],
    };
    const live = {
      schemaVersion: 1,
      strict: true,
      packageSource: "artifact",
      candidate: {
        sdkVersion: RUNINFRA_SDK_VERSION,
        packageSource: "artifact",
        sourceDigestSha256: identity.sourceDigestSha256,
        sourceFileCount: identity.sourceFileCount,
        artifactDigestsChecked: true,
        artifacts: [],
      },
      expectedRows,
      surfaceCoverage,
      parity: { status: "passed", errors: [] },
      reports: ["typescript", "python"].map((language) => ({
        language,
        sdkVersion: RUNINFRA_SDK_VERSION,
        strict: true,
        baseURL: "https://api.runinfra.ai/v1",
        results: expectedRows.map((name) => ({ name, status: "passed" })),
      })),
    };

    try {
      writeFileSync(readinessPath, `${JSON.stringify(readiness, null, 2)}\n`);
      const validArtifacts = [
        { name: "npm", fileName: `runinfra-sdk-${RUNINFRA_SDK_VERSION}.tgz`, sha256: sha256File(npmPath) },
        { name: "pythonWheel", fileName: `runinfra-${RUNINFRA_SDK_VERSION}-py3-none-any.whl`, sha256: sha256File(wheelPath) },
        { name: "pythonSdist", fileName: `runinfra-${RUNINFRA_SDK_VERSION}.tar.gz`, sha256: sha256File(sdistPath) },
      ];

      for (const artifactName of ["npm", "pythonWheel", "pythonSdist"]) {
        writeFileSync(livePath, `${JSON.stringify({
          ...live,
          candidate: {
            ...live.candidate,
            artifacts: validArtifacts.map((artifact) =>
              artifact.name === artifactName
                ? { ...artifact, sha256: "b".repeat(64) }
                : artifact,
            ),
          },
        }, null, 2)}\n`);

        const result = spawnSync(process.execPath, [
          "../scripts/verify-promotion-reports.mjs",
          "--readiness",
          readinessPath,
          "--live",
          livePath,
          "--artifacts-root",
          artifactRoot,
        ], {
          cwd: new URL("..", import.meta.url),
          encoding: "utf8",
        });

        expect(result.status, result.stdout + result.stderr).toBe(1);
        expect(`${result.stdout}${result.stderr}`).toContain(`candidate artifact ${artifactName} sha256 must match staged artifact file`);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects promotion reports with stale candidate source file counts", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-promotion-stale-source-count-"));
    const readinessPath = join(tmp, "readiness.json");
    const livePath = join(tmp, "live.json");
    const digest = "a".repeat(64);
    const matrix = await import("../../scripts/live-canary-matrix.mjs") as { expectedRows: string[] };
    const coverageManifest = await import("../../scripts/live-canary-surface-coverage.mjs") as {
      publicSurfaceCoverage: Array<{ surface: string }>;
    };
    const expectedRows = matrix.expectedRows;
    const surfaces = coverageManifest.publicSurfaceCoverage.map((entry) => entry.surface);
    const surfaceCoverage = {
      status: "passed",
      errors: [],
      uncoveredSurfaces: [],
      uncoveredRows: [],
      surfaces,
      surfaceCount: surfaces.length,
      rowCount: matrix.expectedRows.length,
    };
    const readiness = {
      schemaVersion: 1,
      strict: true,
      packageSource: "artifact",
      candidate: {
        sdkVersion: RUNINFRA_SDK_VERSION,
        packageSource: "artifact",
        sourceDigestSha256: digest,
        sourceFileCount: 1,
        artifactDigestsChecked: false,
        artifacts: [],
      },
      expectedRows,
      readiness: {
        status: "ready",
        missing: [],
        rows: expectedRows.map((name) => ({ name, status: "ready", missing: [] })),
      },
      surfaceCoverage,
      parity: { status: "not_run", errors: [] },
      reports: [],
    };
    const live = {
      schemaVersion: 1,
      strict: true,
      packageSource: "artifact",
      candidate: {
        sdkVersion: RUNINFRA_SDK_VERSION,
        packageSource: "artifact",
        sourceDigestSha256: digest,
        sourceFileCount: 1,
        artifactDigestsChecked: true,
        artifacts: [
          { name: "npm", fileName: `runinfra-sdk-${RUNINFRA_SDK_VERSION}.tgz`, sha256: "b".repeat(64) },
          { name: "pythonWheel", fileName: `runinfra-${RUNINFRA_SDK_VERSION}-py3-none-any.whl`, sha256: "c".repeat(64) },
        ],
      },
      expectedRows,
      surfaceCoverage,
      parity: { status: "passed", errors: [] },
      reports: ["typescript", "python"].map((language) => ({
        language,
        sdkVersion: RUNINFRA_SDK_VERSION,
        strict: true,
        baseURL: "https://api.runinfra.ai/v1",
        results: expectedRows.map((name) => ({ name, status: "passed" })),
      })),
    };

    try {
      writeFileSync(readinessPath, `${JSON.stringify(readiness, null, 2)}\n`);
      writeFileSync(livePath, `${JSON.stringify(live, null, 2)}\n`);

      const result = spawnSync(process.execPath, [
        "../scripts/verify-promotion-reports.mjs",
        "--readiness",
        readinessPath,
        "--live",
        livePath,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain("candidate sourceFileCount must match the canonical live canary source file count");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects promotion reports that omit the Python sdist artifact digest", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-promotion-missing-sdist-"));
    const readinessPath = join(tmp, "readiness.json");
    const livePath = join(tmp, "live.json");
    const digest = "a".repeat(64);
    const matrix = await import("../../scripts/live-canary-matrix.mjs") as { expectedRows: string[] };
    const coverageManifest = await import("../../scripts/live-canary-surface-coverage.mjs") as {
      publicSurfaceCoverage: Array<{ surface: string }>;
    };
    const sourceManifest = await import("../../scripts/live-canary-source-files.mjs") as {
      sourceDigestFileLabels: string[];
    };
    const expectedRows = matrix.expectedRows;
    const surfaces = coverageManifest.publicSurfaceCoverage.map((entry) => entry.surface);
    const surfaceCoverage = {
      status: "passed",
      errors: [],
      uncoveredSurfaces: [],
      uncoveredRows: [],
      surfaces,
      surfaceCount: surfaces.length,
      rowCount: matrix.expectedRows.length,
    };
    const readiness = {
      schemaVersion: 1,
      strict: true,
      packageSource: "artifact",
      candidate: {
        sdkVersion: RUNINFRA_SDK_VERSION,
        packageSource: "artifact",
        sourceDigestSha256: digest,
        sourceFileCount: sourceManifest.sourceDigestFileLabels.length,
        artifactDigestsChecked: false,
        artifacts: [],
      },
      expectedRows,
      readiness: {
        status: "ready",
        missing: [],
        rows: expectedRows.map((name) => ({ name, status: "ready", missing: [] })),
      },
      surfaceCoverage,
      parity: { status: "not_run", errors: [] },
      reports: [],
    };
    const live = {
      schemaVersion: 1,
      strict: true,
      packageSource: "artifact",
      candidate: {
        sdkVersion: RUNINFRA_SDK_VERSION,
        packageSource: "artifact",
        sourceDigestSha256: digest,
        sourceFileCount: sourceManifest.sourceDigestFileLabels.length,
        artifactDigestsChecked: true,
        artifacts: [
          { name: "npm", fileName: `runinfra-sdk-${RUNINFRA_SDK_VERSION}.tgz`, sha256: "b".repeat(64) },
          { name: "pythonWheel", fileName: `runinfra-${RUNINFRA_SDK_VERSION}-py3-none-any.whl`, sha256: "c".repeat(64) },
        ],
      },
      expectedRows,
      surfaceCoverage,
      parity: { status: "passed", errors: [] },
      reports: ["typescript", "python"].map((language) => ({
        language,
        sdkVersion: RUNINFRA_SDK_VERSION,
        strict: true,
        baseURL: "https://api.runinfra.ai/v1",
        results: expectedRows.map((name) => ({ name, status: "passed" })),
      })),
    };

    try {
      writeFileSync(readinessPath, `${JSON.stringify(readiness, null, 2)}\n`);
      writeFileSync(livePath, `${JSON.stringify(live, null, 2)}\n`);

      const result = spawnSync(process.execPath, [
        "../scripts/verify-promotion-reports.mjs",
        "--readiness",
        readinessPath,
        "--live",
        livePath,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(`${result.stdout}${result.stderr}`).toContain("candidate artifacts must be npm, pythonWheel, and pythonSdist");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails registry clean-install CLI preflight before creating workspaces", () => {
    const repoRoot = join(process.cwd(), "..");
    const tempRoot = join(repoRoot, ".clean-install-tmp");
    try {
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      const result = spawnSync(process.execPath, [
        "../scripts/verify-clean-installs.mjs",
        "--package",
        "both",
        "--mode",
        "registry",
        "--version",
        "0.0.0-runinfra-missing",
        "--registry-attempts",
        "1",
        "--registry-retry-delay-ms",
        "1",
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });

      const output = `${result.stdout}${result.stderr}`;
      expect(result.status).toBe(1);
      expect(output).toContain("Registry version preflight failed:");
      expect(output).toContain(
        "npm package @runinfra/sdk@0.0.0-runinfra-missing is not available from the canonical registry.",
      );
      expect(output).toMatch(
        /PyPI package runinfra==0\.0\.0-runinfra-missing (?:is not available from the canonical registry\.|availability check failed:)/u,
      );
      expect(output).not.toContain("npm error");
      expect(output).not.toContain("registry install attempt");
      expect(existsSync(tempRoot)).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("removes clean-install workspaces when artifact verification fails after workspace creation", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-clean-install-failure-"));
    const repoRoot = join(process.cwd(), "..");
    const tempRoot = join(repoRoot, ".clean-install-tmp");
    try {
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });

      const result = spawnSync(process.execPath, [
        "../scripts/verify-clean-installs.mjs",
        "--package",
        "typescript",
        "--mode",
        "artifact",
        "--npm-tarball",
        join(tmp, "missing.tgz"),
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });

      expect(result.status).toBe(1);
      expect(existsSync(tempRoot)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("fails invalid clean-install command timeout before creating workspaces", () => {
    const repoRoot = join(process.cwd(), "..");
    const tempRoot = join(repoRoot, ".clean-install-tmp");
    try {
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      const result = spawnSync(process.execPath, [
        "../scripts/verify-clean-installs.mjs",
        "--package",
        "typescript",
        "--mode",
        "artifact",
        "--npm-tarball",
        join(repoRoot, "missing.tgz"),
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        env: {
          ...process.env,
          RUNINFRA_CLEAN_INSTALL_COMMAND_TIMEOUT_MS: "0",
        },
      });

      const output = `${result.stdout}${result.stderr}`;
      expect(result.status).toBe(1);
      expect(output).toContain("RUNINFRA_CLEAN_INSTALL_COMMAND_TIMEOUT_MS must be a positive integer.");
      expect(output).not.toContain("Clean install command failed");
      expect(existsSync(tempRoot)).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("fails oversized clean-install command timeout before creating workspaces", () => {
    const repoRoot = join(process.cwd(), "..");
    const tempRoot = join(repoRoot, ".clean-install-tmp");
    try {
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      const result = spawnSync(process.execPath, [
        "../scripts/verify-clean-installs.mjs",
        "--package",
        "typescript",
        "--mode",
        "artifact",
        "--npm-tarball",
        join(repoRoot, "missing.tgz"),
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        env: {
          ...process.env,
          RUNINFRA_CLEAN_INSTALL_COMMAND_TIMEOUT_MS: "999999999999999999999999",
        },
      });

      const output = `${result.stdout}${result.stderr}`;
      expect(result.status).toBe(1);
      expect(output).toContain("RUNINFRA_CLEAN_INSTALL_COMMAND_TIMEOUT_MS must be no greater than 3600000.");
      expect(output).not.toContain("Clean install command failed");
      expect(existsSync(tempRoot)).toBe(false);
    } finally {
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("times out stalled clean-install commands without leaking workspace paths", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-clean-install-timeout-"));
    const repoRoot = join(process.cwd(), "..");
    const tempRoot = join(repoRoot, ".clean-install-tmp");
    try {
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      const tarball = join(tmp, "runinfra-sdk-0.1.4.tgz");
      writeGzippedTarball(tarball, [
        {
          name: "package/package.json",
          content: JSON.stringify({
            name: "@runinfra/sdk",
            version: RUNINFRA_SDK_VERSION,
            type: "module",
            main: "./dist/index.js",
            exports: { ".": "./dist/index.js" },
          }),
        },
        {
          name: "package/dist/index.js",
          content: `
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
export const RUNINFRA_SDK_VERSION = "${RUNINFRA_SDK_VERSION}";
export class RunInfra {}
`,
        },
      ]);

      const result = spawnSync(process.execPath, [
        "../scripts/verify-clean-installs.mjs",
        "--package",
        "typescript",
        "--mode",
        "artifact",
        "--npm-tarball",
        tarball,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        timeout: 1500,
        env: {
          ...process.env,
          RUNINFRA_CLEAN_INSTALL_COMMAND_TIMEOUT_MS: "50",
        },
      });

      const output = `${result.stdout}${result.stderr}`;
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(output).toMatch(/npm clean (?:install|import check) timed out after 50ms/u);
      expect(output).not.toContain(tmp);
      expect(output).not.toContain(".clean-install-tmp");
      expect(output).not.toContain("node_modules");
      expect(output).not.toContain("Atomics.wait");
      expect(existsSync(tempRoot)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("redacts clean-install import failures from temporary workspace paths", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-clean-install-redaction-"));
    const repoRoot = join(process.cwd(), "..");
    const tempRoot = join(repoRoot, ".clean-install-tmp");
    try {
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      const tarball = join(tmp, "runinfra-sdk-0.1.4.tgz");
      writeGzippedTarball(tarball, [
        {
          name: "package/package.json",
          content: JSON.stringify({
            name: "@runinfra/sdk",
            version: RUNINFRA_SDK_VERSION,
            type: "module",
            main: "./dist/index.js",
            exports: { ".": "./dist/index.js" },
          }),
        },
        {
          name: "package/dist/index.js",
          content: `
export const RUNINFRA_SDK_VERSION = "${RUNINFRA_SDK_VERSION}";
const create = () => undefined;
export class RunInfra {
  constructor() {
    this.chat = { completions: { create } };
    this.responses = { create };
    this.embeddings = { create };
    this.images = { generate: create };
    this.audio = { speech: { create }, transcriptions: { create } };
    this.voice = { pipeline: { create } };
    this.webhooks = { create, verifySignature: create, constructEvent: create };
  }
}
`,
        },
      ]);

      const result = spawnSync(process.execPath, [
        "../scripts/verify-clean-installs.mjs",
        "--package",
        "typescript",
        "--mode",
        "artifact",
        "--npm-tarball",
        tarball,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });

      const output = `${result.stdout}${result.stderr}`;
      expect(result.status).toBe(1);
      expect(output).toContain("webhooks.create must not be public");
      expect(output).not.toContain(".clean-install-tmp");
      expect(output).not.toContain("[eval");
      expect(existsSync(tempRoot)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("redacts arbitrary clean-install import errors that contain temporary paths", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-clean-install-arbitrary-redaction-"));
    const repoRoot = join(process.cwd(), "..");
    const tempRoot = join(repoRoot, ".clean-install-tmp");
    try {
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      const tarball = join(tmp, "runinfra-sdk-0.1.4.tgz");
      writeGzippedTarball(tarball, [
        {
          name: "package/package.json",
          content: JSON.stringify({
            name: "@runinfra/sdk",
            version: RUNINFRA_SDK_VERSION,
            type: "module",
            main: "./dist/index.js",
            exports: { ".": "./dist/index.js" },
          }),
        },
        {
          name: "package/dist/index.js",
          content: `
export const RUNINFRA_SDK_VERSION = "${RUNINFRA_SDK_VERSION}";
export class RunInfra {}
throw new Error(import.meta.url);
`,
        },
      ]);

      const result = spawnSync(process.execPath, [
        "../scripts/verify-clean-installs.mjs",
        "--package",
        "typescript",
        "--mode",
        "artifact",
        "--npm-tarball",
        tarball,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });

      const output = `${result.stdout}${result.stderr}`;
      expect(result.status).toBe(1);
      expect(output).toContain("npm clean import check failed: import check failed");
      expect(output).not.toContain(".clean-install-tmp");
      expect(output).not.toContain("node_modules");
      expect(output).not.toContain("[eval");
      expect(output).not.toContain("file://");
      expect(existsSync(tempRoot)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("redacts arbitrary clean-install import errors with embedded absolute paths", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-clean-install-embedded-path-redaction-"));
    const repoRoot = join(process.cwd(), "..");
    const tempRoot = join(repoRoot, ".clean-install-tmp");
    try {
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      const tarball = join(tmp, "runinfra-sdk-0.1.4.tgz");
      writeGzippedTarball(tarball, [
        {
          name: "package/package.json",
          content: JSON.stringify({
            name: "@runinfra/sdk",
            version: RUNINFRA_SDK_VERSION,
            type: "module",
            main: "./dist/index.js",
            exports: { ".": "./dist/index.js" },
          }),
        },
        {
          name: "package/dist/index.js",
          content: `
export const RUNINFRA_SDK_VERSION = "${RUNINFRA_SDK_VERSION}";
export class RunInfra {}
throw new Error("failed loading D:\\\\private\\\\secret-project\\\\config.json");
`,
        },
      ]);

      const result = spawnSync(process.execPath, [
        "../scripts/verify-clean-installs.mjs",
        "--package",
        "typescript",
        "--mode",
        "artifact",
        "--npm-tarball",
        tarball,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });

      const output = `${result.stdout}${result.stderr}`;
      expect(result.status).toBe(1);
      expect(output).toContain("npm clean import check failed: import check failed");
      expect(output).not.toContain("D:\\private");
      expect(output).not.toContain("secret-project");
      expect(output).not.toContain(".clean-install-tmp");
      expect(output).not.toContain("[eval");
      expect(existsSync(tempRoot)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("redacts arbitrary clean-install import errors with embedded Unix root paths", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-clean-install-root-path-redaction-"));
    const repoRoot = join(process.cwd(), "..");
    const tempRoot = join(repoRoot, ".clean-install-tmp");
    try {
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      const tarball = join(tmp, "runinfra-sdk-0.1.4.tgz");
      writeGzippedTarball(tarball, [
        {
          name: "package/package.json",
          content: JSON.stringify({
            name: "@runinfra/sdk",
            version: RUNINFRA_SDK_VERSION,
            type: "module",
            main: "./dist/index.js",
            exports: { ".": "./dist/index.js" },
          }),
        },
        {
          name: "package/dist/index.js",
          content: `
export const RUNINFRA_SDK_VERSION = "${RUNINFRA_SDK_VERSION}";
export class RunInfra {}
throw new Error("failed loading /root/private/secret-project/config.json");
`,
        },
      ]);

      const result = spawnSync(process.execPath, [
        "../scripts/verify-clean-installs.mjs",
        "--package",
        "typescript",
        "--mode",
        "artifact",
        "--npm-tarball",
        tarball,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });

      const output = `${result.stdout}${result.stderr}`;
      expect(result.status).toBe(1);
      expect(output).toContain("npm clean import check failed: import check failed");
      expect(output).not.toContain("/root/private");
      expect(output).not.toContain("secret-project");
      expect(output).not.toContain(".clean-install-tmp");
      expect(output).not.toContain("[eval");
      expect(existsSync(tempRoot)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  });

  it("preserves safe Python clean-install SystemExit failure summaries", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-python-clean-install-summary-"));
    const repoRoot = join(process.cwd(), "..");
    const tempRoot = join(repoRoot, ".clean-install-tmp");
    const pythonPackageRoot = join(tmp, "python-package");
    try {
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      mkdirSync(join(pythonPackageRoot, "runinfra"), { recursive: true });
      writeFileSync(join(pythonPackageRoot, "pyproject.toml"), `
[build-system]
requires = ["setuptools==82.0.1"]
build-backend = "setuptools.build_meta"

[project]
name = "runinfra"
version = "${RUNINFRA_SDK_VERSION}"
`);
      writeFileSync(join(pythonPackageRoot, "runinfra", "__init__.py"), `
__version__ = "${RUNINFRA_SDK_VERSION}"

class RunInfra:
    def __init__(self, *args, **kwargs):
        raise SystemExit("synthetic python import summary")
`);
      const buildResult = spawnSync("python", [
        "-m",
        "build",
        pythonPackageRoot,
        "--wheel",
        "--outdir",
        tmp,
      ], { encoding: "utf8" });
      expect(buildResult.status, `${buildResult.stdout}${buildResult.stderr}`).toBe(0);

      const wheel = join(tmp, `runinfra-${RUNINFRA_SDK_VERSION}-py3-none-any.whl`);
      const result = spawnSync(process.execPath, [
        "../scripts/verify-clean-installs.mjs",
        "--package",
        "python",
        "--mode",
        "artifact",
        "--python-wheel",
        wheel,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });

      const output = `${result.stdout}${result.stderr}`;
      expect(result.status).toBe(1);
      expect(output).toContain("Python wheel clean import check failed: synthetic python import summary");
      expect(output).not.toContain(".clean-install-tmp");
      expect(output).not.toContain("[eval");
      expect(existsSync(tempRoot)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 60_000);

  it("fails Python artifact clean installs when the sdist cannot install", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-python-clean-install-sdist-"));
    const repoRoot = join(process.cwd(), "..");
    const tempRoot = join(repoRoot, ".clean-install-tmp");
    const pythonPackageRoot = join(tmp, "python-package");
    try {
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      mkdirSync(join(pythonPackageRoot, "runinfra"), { recursive: true });
      writeFileSync(join(pythonPackageRoot, "pyproject.toml"), `
[build-system]
requires = ["setuptools==82.0.1"]
build-backend = "setuptools.build_meta"

[project]
name = "runinfra"
version = "${RUNINFRA_SDK_VERSION}"
`);
      writeFileSync(join(pythonPackageRoot, "runinfra", "__init__.py"), `
__version__ = "${RUNINFRA_SDK_VERSION}"

def _create(*args, **kwargs):
    return None

class _Namespace:
    pass

class RunInfra:
    def __init__(self, *args, **kwargs):
        endpoint = _Namespace()
        endpoint.create = _create
        self.chat = _Namespace()
        self.chat.completions = endpoint
        self.responses = endpoint
        self.embeddings = endpoint
        images = _Namespace()
        images.generate = _create
        self.images = images
        self.audio = _Namespace()
        self.audio.speech = endpoint
        self.audio.transcriptions = endpoint
        self.voice = _Namespace()
        self.voice.pipeline = endpoint
        self.webhooks = _Namespace()
        self.webhooks.verify_signature = _create
        self.webhooks.construct_event = _create
`);
      const buildResult = spawnSync("python", [
        "-m",
        "build",
        pythonPackageRoot,
        "--wheel",
        "--outdir",
        tmp,
      ], { encoding: "utf8" });
      expect(buildResult.status, `${buildResult.stdout}${buildResult.stderr}`).toBe(0);

      const wheel = join(tmp, `runinfra-${RUNINFRA_SDK_VERSION}-py3-none-any.whl`);
      const invalidSdist = join(tmp, `runinfra-${RUNINFRA_SDK_VERSION}.tar.gz`);
      writeFileSync(invalidSdist, "not a valid Python sdist");

      const result = spawnSync(process.execPath, [
        "../scripts/verify-clean-installs.mjs",
        "--package",
        "python",
        "--mode",
        "artifact",
        "--python-wheel",
        wheel,
        "--python-sdist",
        invalidSdist,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });

      const output = `${result.stdout}${result.stderr}`;
      expect(result.status).toBe(1);
      expect(output).toContain("Python sdist clean install failed");
      expect(output).not.toContain(tmp);
      expect(output).not.toContain(".clean-install-tmp");
      expect(output).not.toContain("RightNow-Full");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
      rmSync(tempRoot, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    }
  }, 20_000);

  it("keeps child canaries in parity for audio OpenAI parameter coverage", () => {
    const typescriptCanary = readFileSync(new URL("../../scripts/sdk-live-canary-typescript.mjs", import.meta.url), "utf8");
    const pythonCanary = readFileSync(new URL("../../scripts/sdk-live-canary-python.py", import.meta.url), "utf8");

    expect(typescriptCanary).toContain('record("openai.params.audio.speech"');
    expect(typescriptCanary).toContain("RUNINFRA_TTS_RESPONSE_FORMAT");
    expect(typescriptCanary).toContain('["mp3", "opus", "aac", "flac", "wav", "pcm"]');
    expect(typescriptCanary).toContain("speechRequest(input, options = {})");
    expect(typescriptCanary).toContain("options.responseFormat");
    expect(typescriptCanary).toContain('responseFormat: "set_redacted"');
    expect(typescriptCanary).toContain('record("openai.params.audio.transcriptions"');
    expect(typescriptCanary).toContain("RUNINFRA_ASR_RESPONSE_FORMAT");
    expect(typescriptCanary).toContain("response_format: responseFormat");
    expect(pythonCanary).toContain('"openai.params.audio.speech"');
    expect(pythonCanary).toContain("RUNINFRA_TTS_RESPONSE_FORMAT");
    expect(pythonCanary).toContain('{"mp3", "opus", "aac", "flac", "wav", "pcm"}');
    expect(pythonCanary).toContain("response_format: Optional[str] = None");
    expect(pythonCanary).toContain('"responseFormat": "set_redacted"');
    expect(pythonCanary).toContain('"openai.params.audio.transcriptions"');
    expect(pythonCanary).toContain("RUNINFRA_ASR_RESPONSE_FORMAT");
    expect(pythonCanary).toContain("response_format=response_format");
  });

  it("keeps child canaries aligned with the Responses adapter parameter contract", () => {
    const typescriptCanary = readFileSync(new URL("../../scripts/sdk-live-canary-typescript.mjs", import.meta.url), "utf8");
    const pythonCanary = readFileSync(new URL("../../scripts/sdk-live-canary-python.py", import.meta.url), "utf8");
    const typescriptBlock = typescriptCanary.match(
      /await record\("openai\.params\.responses"[\s\S]*?await record\("responses\.stream\.final"/u,
    )?.[0];
    const pythonBlock = pythonCanary.match(
      /def _responses_params\([\s\S]*?def _responses_stream_final/u,
    )?.[0];

    expect(typescriptBlock).toContain("top_p: 1");
    expect(typescriptBlock).not.toContain("metadata");
    expect(pythonBlock).toContain("top_p=1");
    expect(pythonBlock).not.toContain("metadata");
  });

  it("types TypeScript image request OpenAI-compatible parameters", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const imageRequest = source.match(
      /export interface ImageGenerateRequest \{[\s\S]*?\n\}/u,
    )?.[0];

    expect(imageRequest).toContain("n?: number;");
    expect(imageRequest).toContain("size?: string;");
    expect(imageRequest).toContain('response_format?: "url" | "b64_json" | string;');
    expect(imageRequest).toContain("quality?: string;");
    expect(imageRequest).toContain("style?: string;");
    expect(imageRequest).toContain("user?: string;");
  });

  it("types TypeScript LLM request OpenAI-compatible parameters", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const chatRequest = source.match(
      /export interface ChatCompletionRequest \{[\s\S]*?\n\}/u,
    )?.[0];
    const responsesRequest = source.match(
      /export interface ResponsesCreateRequest \{[\s\S]*?\n\}/u,
    )?.[0];

    for (const field of [
      "temperature?: number;",
      "top_p?: number;",
      "max_tokens?: number;",
      "max_completion_tokens?: number;",
      "stop?: string | string[];",
      "presence_penalty?: number;",
      "frequency_penalty?: number;",
      "user?: string;",
      "metadata?: Record<string, unknown>;",
      "stream_options?: { include_usage?: boolean } & Record<string, unknown>;",
      "tools?: Array<Record<string, unknown>>;",
      "tool_choice?: string | Record<string, unknown>;",
      "response_format?: Record<string, unknown>;",
      "seed?: number;",
      "logprobs?: boolean;",
      "top_logprobs?: number;",
    ]) {
      expect(chatRequest).toContain(field);
    }

    for (const field of [
      "temperature?: number;",
      "top_p?: number;",
      "tools?: Array<Record<string, unknown>>;",
      "tool_choice?: string | Record<string, unknown>;",
      "response_format?: Record<string, unknown>;",
    ]) {
      expect(responsesRequest).toContain(field);
    }
    for (const unsupportedField of [
      "metadata?: Record<string, unknown>;",
      "store?: boolean;",
      "include?: string[];",
      "reasoning?: Record<string, unknown>;",
      "previous_response_id?: string;",
      "user?: string;",
    ]) {
      expect(responsesRequest).not.toContain(unsupportedField);
    }

    expect(readme).toContain("LLM pass-through options are typed for parity");
    expect(readme).toContain(
      "- Responses: `model`, `input`, `stream`, `instructions`, `temperature`,",
    );
    expect(readme).toContain(
      "`top_p`, `tools`, `tool_choice`, `response_format`, and `max_output_tokens`.",
    );
    expect(readme).toContain("not GA-verified until strict canary rows assert backend support");
  });

  it("types TypeScript Responses envelopes with OpenAI-compatible created_at", () => {
    const response = {
      id: "resp_created_at",
      created_at: 1_741_476_542,
    } satisfies ResponsesCreateResponse;

    expect(response.created_at).toBe(1_741_476_542);
  });

  it("types TypeScript embeddings and audio auxiliary OpenAI-compatible parameters", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const embeddingRequest = source.match(
      /export interface EmbeddingRequest \{[\s\S]*?\n\}/u,
    )?.[0];
    const speechRequest = source.match(
      /export interface SpeechRequest \{[\s\S]*?\n\}/u,
    )?.[0];
    const transcriptionRequest = source.match(
      /export interface TranscriptionRequest \{[\s\S]*?\n\}/u,
    )?.[0];

    expect(embeddingRequest).toContain("user?: string;");
    expect(speechRequest).toContain("speed?: number;");
    expect(transcriptionRequest).toContain("temperature?: number;");
    expect(readme).toContain("Embedding `user`, TTS `speed`, and ASR `temperature` are typed pass-through");
    expect(readme).toMatch(/not GA-verified until strict modality canaries\s+assert backend support/u);
  });

  it("keeps TypeScript request bodies closed and documents explicit extraBody extensions", () => {
    const source = readFileSync(new URL("./index.ts", import.meta.url), "utf8");
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const typescriptCanary = readFileSync(new URL("../../scripts/sdk-live-canary-typescript.mjs", import.meta.url), "utf8");

    for (const interfaceName of [
      "ChatCompletionRequest",
      "ResponsesCreateRequest",
      "EmbeddingRequest",
      "SpeechRequest",
      "TranscriptionRequest",
      "ImageGenerateRequest",
    ]) {
      expect(source).not.toContain(`export interface ${interfaceName} extends Record<string, unknown>`);
      expect(source).toContain(`export interface ${interfaceName} {`);
    }

    expect(source).toContain("extraBody?: Record<string, unknown>;");
    expect(readme).toContain("TypeScript request interfaces are closed around typed fields");
    expect(readme).toContain("Use `extraBody` in request options for deliberate JSON body extensions");
    expect(readme).toContain("`extraBody` is only accepted on JSON body requests");
    expect(readme).toContain("`extraBody` cannot override typed request fields");
    expect(typescriptCanary).toContain("extraBody: {");
    expect(typescriptCanary).toContain("runinfra_unsupported_parameter_probe");
  });

  it("keeps child canaries in parity for local unknown request field coverage", async () => {
    const { expectedRows } = await import("../../scripts/live-canary-matrix.mjs") as { expectedRows: string[] };
    const { publicSurfaceCoverage } =
      await import("../../scripts/live-canary-surface-coverage.mjs") as {
        publicSurfaceCoverage: Array<{ surface: string; rows: string[] }>;
      };
    const runner = readFileSync(new URL("../../scripts/run-sdk-live-canaries.mjs", import.meta.url), "utf8");
    const typescriptCanary = readFileSync(new URL("../../scripts/sdk-live-canary-typescript.mjs", import.meta.url), "utf8");
    const pythonCanary = readFileSync(new URL("../../scripts/sdk-live-canary-python.py", import.meta.url), "utf8");
    const liveCanaries = readFileSync(new URL("../../LIVE-CANARIES.md", import.meta.url), "utf8");
    const row = "request.unknown_fields.local";

    expect(expectedRows).toContain(row);
    expect(runner).toContain(`["${row}", () => []]`);
    expect(typescriptCanary).toContain(`record("${row}"`);
    expect(typescriptCanary).toContain("assertUnknownRequestFieldRejected");
    expect(pythonCanary).toContain(`"${row}"`);
    expect(pythonCanary).toContain("assert_unknown_request_field_rejected");
    expect(liveCanaries).toContain(row);
    expect(liveCanaries).toContain("unknown direct request fields");
    expect(publicSurfaceCoverage.find((entry) => entry.surface === "request option validation")?.rows)
      .toContain(row);
  });

  it("keeps child canaries in parity for local browser API-key guard coverage", async () => {
    const { expectedRows } = await import("../../scripts/live-canary-matrix.mjs") as { expectedRows: string[] };
    const { publicSurfaceCoverage } =
      await import("../../scripts/live-canary-surface-coverage.mjs") as {
        publicSurfaceCoverage: Array<{ surface: string; rows: string[] }>;
      };
    const runner = readFileSync(new URL("../../scripts/run-sdk-live-canaries.mjs", import.meta.url), "utf8");
    const typescriptCanary = readFileSync(new URL("../../scripts/sdk-live-canary-typescript.mjs", import.meta.url), "utf8");
    const pythonCanary = readFileSync(new URL("../../scripts/sdk-live-canary-python.py", import.meta.url), "utf8");
    const liveCanaries = readFileSync(new URL("../../LIVE-CANARIES.md", import.meta.url), "utf8");
    const row = "browser.api_key_guard.local";

    expect(expectedRows).toContain(row);
    expect(runner).toContain(`["${row}", () => []]`);
    expect(typescriptCanary).toContain(`record("${row}"`);
    expect(typescriptCanary).toContain("assertBrowserApiKeyGuard");
    expect(pythonCanary).toContain(`"${row}"`);
    expect(pythonCanary).toContain("browser_token_surface");
    expect(liveCanaries).toContain(row);
    expect(liveCanaries).toContain("browser API-key guard");
    expect(publicSurfaceCoverage.find((entry) => entry.surface === "browser API-key guard")?.rows)
      .toContain(row);
  });

  it("keeps child canaries in parity for local api-key redaction coverage", async () => {
    const { expectedRows } = await import("../../scripts/live-canary-matrix.mjs") as { expectedRows: string[] };
    const { publicSurfaceCoverage } =
      await import("../../scripts/live-canary-surface-coverage.mjs") as {
        publicSurfaceCoverage: Array<{ surface: string; rows: string[] }>;
      };
    const runner = readFileSync(new URL("../../scripts/run-sdk-live-canaries.mjs", import.meta.url), "utf8");
    const typescriptCanary = readFileSync(new URL("../../scripts/sdk-live-canary-typescript.mjs", import.meta.url), "utf8");
    const pythonCanary = readFileSync(new URL("../../scripts/sdk-live-canary-python.py", import.meta.url), "utf8");
    const liveCanaries = readFileSync(new URL("../../LIVE-CANARIES.md", import.meta.url), "utf8");
    const row = "security.api_key_redaction.local";

    expect(expectedRows).toContain(row);
    expect(runner).toContain(`["${row}", () => []]`);
    expect(typescriptCanary).toContain(`record("${row}"`);
    expect(typescriptCanary).toContain("assertApiKeyRedaction");
    expect(pythonCanary).toContain(`"${row}"`);
    expect(pythonCanary).toContain("assert_api_key_redaction");
    expect(liveCanaries).toContain(row);
    expect(liveCanaries).toContain("API-key redaction");
    expect(publicSurfaceCoverage.find((entry) => entry.surface === "API-key redaction")?.rows)
      .toContain(row);
  });

  it("keeps child live-canary failure diagnostics actionable without raw error messages", () => {
    const typescriptCanary = readFileSync(new URL("../../scripts/sdk-live-canary-typescript.mjs", import.meta.url), "utf8");
    const pythonCanary = readFileSync(new URL("../../scripts/sdk-live-canary-python.py", import.meta.url), "utf8");
    const result = spawnSync(process.execPath, [
      "../scripts/sdk-live-canary-typescript.mjs",
      "--self-test-error-summary",
    ], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      env: {
        ...process.env,
        RUNINFRA_API_KEY: "",
      },
    });

    expect(result.status, result.stderr).toBe(0);
    const summary = JSON.parse(result.stdout) as {
      known?: { diagnostic?: string | null; message?: string };
      unknown?: { diagnostic?: string | null; message?: string };
    };

    expect(typescriptCanary).toContain("function canaryDiagnostic(error)");
    expect(typescriptCanary).toContain("diagnostic: canaryDiagnostic(error)");
    expect(typescriptCanary).toContain('return "unexpected_success";');
    expect(typescriptCanary).toContain('message: "redacted"');
    expect(summary.known?.diagnostic).toBe("unexpected_success");
    expect(summary.known?.message).toBe("redacted");
    expect(summary.unknown?.diagnostic).toBeNull();
    expect(summary.unknown?.message).toBe("redacted");
    expect(result.stdout).not.toContain("unsupported body parameter");
    expect(result.stdout).not.toContain("RUNINFRA_LOCAL_PATH_SENTINEL");
    expect(pythonCanary).toContain("def canary_diagnostic(error: BaseException) -> Optional[str]:");
    expect(pythonCanary).toContain('"diagnostic": canary_diagnostic(error)');
    expect(pythonCanary).toContain('return "unexpected_success"');
    expect(pythonCanary).toContain('"message": "redacted"');
  });

  it("documents local request payload validation before network sends", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

    expect(readme).toContain("Required request fields are validated before any network request is sent.");
    expect(readme).toContain("model must be a non-blank string");
    expect(readme).toContain("chat messages must be a non-empty array");
    expect(readme).toContain("each chat message must be an object with a non-empty role");
    expect(readme).toContain("Responses input array items must be objects");
    expect(readme).toContain("JSON request bodies must be serializable and contain only finite numbers");
    expect(readme).toContain("embedding input must be a non-empty string or array of non-empty strings");
    expect(readme).toContain("TTS input and image prompts must be non-empty strings");
    expect(readme).toContain("ASR file must be a non-empty Blob");
    expect(readme).toContain("ASR multipart filenames are validated");
    expect(readme).not.toContain("ASR multipart filenames and extra form field names and values");
  });

  it("documents credential-shaped custom header guards", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

    expect(readme).toContain("`X-API-Key`");
    expect(readme).toContain("`X-Auth-Token`");
    expect(readme).toContain("`X-Access-Token`");
  });

  it("documents typed stalled stream timeouts", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

    expect(readme).toContain(
      "stalled streaming reads, stalled non-streaming JSON body reads, and stalled binary audio `arrayBuffer()` / `blob()` reads after headers arrive",
    );
    expect(readme).toContain("includes `requestId` when the response was traced");
    expect(readme).toContain(
      "streaming body transport failures, non-streaming JSON body transport failures, and binary audio `arrayBuffer()` / `blob()` transport failures after headers arrive",
    );
  });

  it("documents streaming cancellation resource release", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const liveCanaries = readFileSync(new URL("../../LIVE-CANARIES.md", import.meta.url), "utf8");

    expect(readme).toContain("Breaking out of the `for await` loop cancels the underlying SSE reader");
    expect(readme).toMatch(/If you manually advance the stream iterator,\s+call\s+`return\(\)` on that iterator/u);
    expect(readme).toContain("Streaming transport-level backend cancellation is best effort");
    expect(liveCanaries).toMatch(/TypeScript cancellation rows break out of\s+`for await`/u);
    expect(liveCanaries).toContain("Python cancellation rows close the active iterator");
  });

  it("keeps child canaries in parity for slow-consumer streaming coverage", () => {
    const runner = readFileSync(new URL("../../scripts/run-sdk-live-canaries.mjs", import.meta.url), "utf8");
    const typescriptCanary = readFileSync(new URL("../../scripts/sdk-live-canary-typescript.mjs", import.meta.url), "utf8");
    const pythonCanary = readFileSync(new URL("../../scripts/sdk-live-canary-python.py", import.meta.url), "utf8");
    const liveCanaries = readFileSync(new URL("../../LIVE-CANARIES.md", import.meta.url), "utf8");

    for (const row of ["chat.completions.stream.slow_consumer", "responses.stream.slow_consumer"]) {
      expect(runner).toContain(`"${row}"`);
      expect(typescriptCanary).toContain(`record("${row}"`);
      expect(pythonCanary).toContain(`"${row}"`);
      expect(liveCanaries).toContain(row);
    }

    expect(runner).toContain("RUNINFRA_CANARY_STREAM_SLOW_CONSUMER_DELAY_MS");
    expect(typescriptCanary).toContain("slowConsumerDelayMs");
    expect(typescriptCanary).toMatch(
      /const relevantEnv = \[[\s\S]*"RUNINFRA_CANARY_STREAM_SLOW_CONSUMER_DELAY_MS"/,
    );
    expect(typescriptCanary).toContain("function slowStreamRequirements()");
    expect(typescriptCanary).toContain("sleepWithinDeadline");
    expect(typescriptCanary).toMatch(
      /record\("chat\.completions\.stream\.slow_consumer", slowStreamRequirements, async \(\) => \{\s+const delayMs = slowConsumerDelayMs\(\);\s+const stream = await client\(\)\.chat\.completions\.create/,
    );
    expect(typescriptCanary).toMatch(
      /record\("responses\.stream\.slow_consumer", slowStreamRequirements, async \(\) => \{\s+const delayMs = slowConsumerDelayMs\(\);\s+const stream = await client\(\)\.responses\.create/,
    );
    expect(pythonCanary).toContain("slow_consumer_delay_seconds");
    expect(pythonCanary).toContain("def slow_stream_requirements()");
    expect(liveCanaries).toContain("RUNINFRA_CANARY_STREAM_SLOW_CONSUMER_DELAY_MS");
    expect(liveCanaries).toContain("Slow-consumer streaming rows");
    expect(liveCanaries).toContain("defaults to 120 and must be <= 600");
    expect(liveCanaries).toContain("bounded by `RUNINFRA_CANARY_TIMEOUT_SECONDS`");
  });

  it("keeps child canaries in parity for local streaming fault coverage", () => {
    const runner = readFileSync(new URL("../../scripts/run-sdk-live-canaries.mjs", import.meta.url), "utf8");
    const typescriptCanary = readFileSync(new URL("../../scripts/sdk-live-canary-typescript.mjs", import.meta.url), "utf8");
    const pythonCanary = readFileSync(new URL("../../scripts/sdk-live-canary-python.py", import.meta.url), "utf8");
    const liveCanaries = readFileSync(new URL("../../LIVE-CANARIES.md", import.meta.url), "utf8");
    const rows = [
      "chat.completions.stream.malformed_frame.local",
      "responses.stream.malformed_frame.local",
      "chat.completions.stream.disconnect.local",
      "responses.stream.disconnect.local",
      "chat.completions.stream.stalled_read.local",
      "responses.stream.stalled_read.local",
    ];

    for (const row of rows) {
      expect(runner).toContain(`"${row}"`);
      expect(typescriptCanary).toContain(`record("${row}"`);
      expect(pythonCanary).toContain(`"${row}"`);
      expect(liveCanaries).toContain(row);
    }

    expect(typescriptCanary).toContain("RunInfraStreamParseError");
    expect(typescriptCanary).toContain("RunInfraConnectionError");
    expect(typescriptCanary).toContain("RunInfraTimeoutError");
    expect(typescriptCanary).toContain("localStreamClient");
    expect(typescriptCanary).toContain("expectStreamError");
    expect(pythonCanary).toContain("RunInfraStreamParseError");
    expect(pythonCanary).toContain("RunInfraConnectionError");
    expect(pythonCanary).toContain("RunInfraTimeoutError");
    expect(pythonCanary).toContain("local_stream_client");
    expect(pythonCanary).toContain("expect_stream_error");
    expect(liveCanaries).toContain("Local streaming fault rows");
    expect(liveCanaries).toContain("do not call the production gateway");
  });

  it("keeps child canaries in parity for local retry safety coverage", () => {
    const runner = readFileSync(new URL("../../scripts/run-sdk-live-canaries.mjs", import.meta.url), "utf8");
    const typescriptCanary = readFileSync(new URL("../../scripts/sdk-live-canary-typescript.mjs", import.meta.url), "utf8");
    const pythonCanary = readFileSync(new URL("../../scripts/sdk-live-canary-python.py", import.meta.url), "utf8");
    const liveCanaries = readFileSync(new URL("../../LIVE-CANARIES.md", import.meta.url), "utf8");
    const rows = [
      "retry.safety.get.local",
      "retry.safety.post.requires_idempotency.local",
      "retry.safety.post.with_idempotency.local",
      "retry.safety.stream.no_retry.local",
      "retry.safety.audio_binary.no_retry.local",
      "retry.safety.audio_multipart.no_retry.local",
    ];

    for (const row of rows) {
      expect(runner).toContain(`"${row}"`);
      expect(typescriptCanary).toContain(`record("${row}"`);
      expect(pythonCanary).toContain(`"${row}"`);
      expect(liveCanaries).toContain(row);
    }

    expect(typescriptCanary).toContain("localRetryClient");
    expect(typescriptCanary).toContain("assertRetryCallCount");
    expect(pythonCanary).toContain("local_retry_client");
    expect(pythonCanary).toContain("assert_retry_call_count");
    expect(liveCanaries).toContain("Local retry-safety rows");
    expect(liveCanaries).toContain("do not call the production gateway");
  });

  it("keeps child canaries in parity for local client request id coverage", async () => {
    const { expectedRows } = await import("../../scripts/live-canary-matrix.mjs") as { expectedRows: string[] };
    const { publicSurfaceCoverage } =
      await import("../../scripts/live-canary-surface-coverage.mjs") as {
        publicSurfaceCoverage: Array<{ surface: string; rows: string[] }>;
      };
    const runner = readFileSync(new URL("../../scripts/run-sdk-live-canaries.mjs", import.meta.url), "utf8");
    const typescriptCanary = readFileSync(new URL("../../scripts/sdk-live-canary-typescript.mjs", import.meta.url), "utf8");
    const pythonCanary = readFileSync(new URL("../../scripts/sdk-live-canary-python.py", import.meta.url), "utf8");
    const liveCanaries = readFileSync(new URL("../../LIVE-CANARIES.md", import.meta.url), "utf8");
    const row = "request.client_request_id.local";

    expect(expectedRows).toContain(row);
    expect(runner).toContain(`["${row}", () => []]`);
    expect(typescriptCanary).toContain(`record("${row}"`);
    expect(typescriptCanary).toContain("assertClientRequestIdHeader");
    expect(pythonCanary).toContain(`"${row}"`);
    expect(pythonCanary).toContain("assert_client_request_id_header");
    expect(liveCanaries).toContain(row);
    expect(liveCanaries).toContain("Local request-option rows");
    expect(publicSurfaceCoverage.find((entry) => entry.surface === "request option validation")?.rows)
      .toContain(row);
  });

  it("keeps child canaries in parity for local custom header coverage", async () => {
    const { expectedRows } = await import("../../scripts/live-canary-matrix.mjs") as { expectedRows: string[] };
    const { publicSurfaceCoverage } =
      await import("../../scripts/live-canary-surface-coverage.mjs") as {
        publicSurfaceCoverage: Array<{ surface: string; rows: string[] }>;
      };
    const runner = readFileSync(new URL("../../scripts/run-sdk-live-canaries.mjs", import.meta.url), "utf8");
    const typescriptCanary = readFileSync(new URL("../../scripts/sdk-live-canary-typescript.mjs", import.meta.url), "utf8");
    const pythonCanary = readFileSync(new URL("../../scripts/sdk-live-canary-python.py", import.meta.url), "utf8");
    const liveCanaries = readFileSync(new URL("../../LIVE-CANARIES.md", import.meta.url), "utf8");
    const row = "request.custom_headers.local";

    expect(expectedRows).toContain(row);
    expect(runner).toContain(`["${row}", () => []]`);
    expect(typescriptCanary).toContain(`record("${row}"`);
    expect(typescriptCanary).toContain("assertCustomHeader");
    expect(pythonCanary).toContain(`"${row}"`);
    expect(pythonCanary).toContain("assert_custom_header");
    expect(liveCanaries).toContain(row);
    expect(liveCanaries).toContain("custom request headers");
    expect(publicSurfaceCoverage.find((entry) => entry.surface === "request option validation")?.rows)
      .toContain(row);
  });

  it("keeps child canaries in parity for local timeout coverage", async () => {
    const { expectedRows } = await import("../../scripts/live-canary-matrix.mjs") as { expectedRows: string[] };
    const { publicSurfaceCoverage } =
      await import("../../scripts/live-canary-surface-coverage.mjs") as {
        publicSurfaceCoverage: Array<{ surface: string; rows: string[] }>;
      };
    const runner = readFileSync(new URL("../../scripts/run-sdk-live-canaries.mjs", import.meta.url), "utf8");
    const typescriptCanary = readFileSync(new URL("../../scripts/sdk-live-canary-typescript.mjs", import.meta.url), "utf8");
    const pythonCanary = readFileSync(new URL("../../scripts/sdk-live-canary-python.py", import.meta.url), "utf8");
    const liveCanaries = readFileSync(new URL("../../LIVE-CANARIES.md", import.meta.url), "utf8");
    const row = "request.timeout.local";

    expect(expectedRows).toContain(row);
    expect(runner).toContain(`["${row}", () => []]`);
    expect(typescriptCanary).toContain(`record("${row}"`);
    expect(typescriptCanary).toContain("localTimeoutClient");
    expect(pythonCanary).toContain(`"${row}"`);
    expect(pythonCanary).toContain("local_timeout_client");
    expect(liveCanaries).toContain(row);
    expect(liveCanaries).toContain("per-request timeout");
    expect(publicSurfaceCoverage.find((entry) => entry.surface === "request option validation")?.rows)
      .toContain(row);
  });

  it("keeps child canaries in parity for local extra body coverage", async () => {
    const { expectedRows } = await import("../../scripts/live-canary-matrix.mjs") as { expectedRows: string[] };
    const { publicSurfaceCoverage } =
      await import("../../scripts/live-canary-surface-coverage.mjs") as {
        publicSurfaceCoverage: Array<{ surface: string; rows: string[] }>;
      };
    const runner = readFileSync(new URL("../../scripts/run-sdk-live-canaries.mjs", import.meta.url), "utf8");
    const typescriptCanary = readFileSync(new URL("../../scripts/sdk-live-canary-typescript.mjs", import.meta.url), "utf8");
    const pythonCanary = readFileSync(new URL("../../scripts/sdk-live-canary-python.py", import.meta.url), "utf8");
    const liveCanaries = readFileSync(new URL("../../LIVE-CANARIES.md", import.meta.url), "utf8");
    const row = "request.extra_body.local";

    expect(expectedRows).toContain(row);
    expect(runner).toContain(`["${row}", () => []]`);
    expect(typescriptCanary).toContain(`record("${row}"`);
    expect(typescriptCanary).toContain("assertExtraBodyJsonField");
    expect(pythonCanary).toContain(`"${row}"`);
    expect(pythonCanary).toContain("assert_extra_body_json_field");
    expect(liveCanaries).toContain(row);
    expect(liveCanaries).toContain("explicit JSON extra-body");
    expect(publicSurfaceCoverage.find((entry) => entry.surface === "request option validation")?.rows)
      .toContain(row);
    expect(publicSurfaceCoverage.find((entry) => entry.surface === "unsupported body parameter handling")?.rows)
      .toContain(row);
  });

  it("documents public-repo production promotion without stale monorepo commands", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const agentNotes = readFileSync(new URL("../../AGENT-NOTES.md", import.meta.url), "utf8");
    const liveCanaries = readFileSync(new URL("../../LIVE-CANARIES.md", import.meta.url), "utf8");

    expect(readme).toContain("For production promotion");
    expect(readme).toContain("This public repo now includes live-canary runners for both SDKs.");
    expect(readme).toContain("The publish workflow builds the npm tarball, Python wheel, and Python sdist once");
    expect(readme).toContain("real publish runs the strict promotion gate");
    expect(readme).toContain("publishes the same downloaded artifacts");
    expect(readme).toContain("The artifact clean-install gate imports the npm tarball, the Python wheel, and");
    expect(readme).toContain("an sdist-built Python wheel");
    expect(readme).toContain("RUNINFRA_ASR_FIXTURE_BASE64");
    expect(readme).toContain("RUNINFRA_VOICE_PIPELINE_AUDIO_BASE64");
    expect(readme).toContain("node scripts/verify-workflow-policy.mjs");
    expect(readme).toContain("node scripts/verify-github-security-status.mjs --repo RightNow-AI/runinfra-sdk");
    expect(readme).toContain("node scripts/verify-version-sync.mjs");
    expect(readme).toContain("node scripts/verify-npm-package.mjs typescript/runinfra-sdk-*.tgz");
    expect(readme).toContain("python scripts/verify-python-package.py python/dist");
    expect(readme).toContain("node scripts/verify-clean-installs.mjs --package both --mode artifact");
    expect(readme).toContain("node scripts/run-sdk-live-canaries.mjs --verify-surface-coverage");
    expect(readme).toContain("node scripts/run-sdk-live-canaries.mjs --preflight --strict --report artifacts/sdk/live-canary-readiness.json");
    expect(readme).toContain("node scripts/run-sdk-live-canaries.mjs --package-source artifact --strict --report artifacts/sdk/live-canary.json");
    expect(readme).toContain("node scripts/verify-promotion-reports.mjs --readiness artifacts/sdk/live-canary-readiness.json --live artifacts/sdk/live-canary.json --artifacts-root .");
    const surfaceCoverageIndex = readme.indexOf("node scripts/run-sdk-live-canaries.mjs --verify-surface-coverage");
    const preflightIndex = readme.indexOf("node scripts/run-sdk-live-canaries.mjs --preflight --strict --report artifacts/sdk/live-canary-readiness.json");
    const liveCanaryIndex = readme.indexOf("node scripts/run-sdk-live-canaries.mjs --package-source artifact --strict --report artifacts/sdk/live-canary.json");
    const promotionReportIndex = readme.indexOf("node scripts/verify-promotion-reports.mjs --readiness artifacts/sdk/live-canary-readiness.json --live artifacts/sdk/live-canary.json --artifacts-root .");
    expect(surfaceCoverageIndex).toBeGreaterThan(-1);
    expect(preflightIndex).toBeGreaterThan(surfaceCoverageIndex);
    expect(liveCanaryIndex).toBeGreaterThan(preflightIndex);
    expect(promotionReportIndex).toBeGreaterThan(liveCanaryIndex);
    expect(readme).toContain("gh workflow run publish.yml --repo RightNow-AI/runinfra-sdk --ref main -f package=both -f dry_run=true -f confirm_version=<version>");
    expect(readme).toContain("A real publish must also prove registry install/import");
    expect(readme).toContain("node scripts/verify-clean-installs.mjs --package both --mode registry --version <version>");
    expect(readme).toContain("Run the surface-coverage check before preflight");
    expect(readme).toContain("Then run the strict preflight");
    expect(readme).toContain("Then run the strict live canary matrix against the exact production gateway");
    expect(liveCanaries).toContain("candidate.sourceDigestSha256");
    expect(liveCanaries).toContain("typescript/tsconfig.json");
    expect(liveCanaries).toContain("python/MANIFEST.in");
    expect(liveCanaries).toContain("candidate.artifacts");
    expect(liveCanaries).toContain("canonical live canary matrix");
    expect(liveCanaries).toContain("readiness `summary.ready` to equal the canonical matrix row count");
    expect(liveCanaries).toContain("readiness `summary.blocked` to be `0`");
    expect(liveCanaries).toContain("artifact clean-install gate imports both the prebuilt Python wheel and an");
    expect(liveCanaries).toContain("sdist-built wheel");
    expect(liveCanaries).toContain("RUNINFRA_ASR_FIXTURE_BASE64");
    expect(liveCanaries).toContain("RUNINFRA_VOICE_PIPELINE_AUDIO_BASE64");
    expect(agentNotes).toContain("`dry_run=false` cannot bypass `promotion-gate`");
    expect(agentNotes).toContain("Clean artifact install/import now exercises the npm tarball, Python wheel, and");
    expect(agentNotes).toContain("node scripts/verify-github-security-status.mjs --repo RightNow-AI/runinfra-sdk");
    expect(agentNotes).toContain("the publish jobs publish only the downloaded `runinfra-sdk-promoted-artifacts` files");
    expect(agentNotes).toContain("readiness summary at all rows ready with zero blocked rows");
    expect(agentNotes).toContain("source digest includes `typescript/tsconfig.json` and `python/MANIFEST.in`");
    expect(agentNotes).not.toContain("The simplified workflow doesn't run the strict gate scripts");
    expect(readme).toContain("Do not use npm or PyPI tokens");
    expect(readme).not.toContain("pnpm verify:sdk-release");
    expect(readme).not.toContain("pnpm test:sdk-canary:live");
    expect(readme).not.toContain("RUNINFRA_SDK_CI_TOKEN");
  });

  it("keeps preflight candidate digests independent of generated TypeScript dist artifacts", async () => {
    const manifest = await import("../../scripts/live-canary-source-files.mjs") as { sourceDigestFileLabels: string[] };

    expect(manifest.sourceDigestFileLabels).toContain("typescript/src/index.ts");
    expect(manifest.sourceDigestFileLabels).not.toContain("typescript/dist/index.js");
    expect(manifest.sourceDigestFileLabels).not.toContain("typescript/dist/index.d.ts");
  });

  it("includes shipped SDK READMEs in live promotion source digests", async () => {
    const manifest = await import("../../scripts/live-canary-source-files.mjs") as { sourceDigestFileLabels: string[] };

    expect(manifest.sourceDigestFileLabels).toContain("typescript/README.md");
    expect(manifest.sourceDigestFileLabels).toContain("python/README.md");
  });

  it("includes shipped SDK changelogs in live promotion source digests", async () => {
    const manifest = await import("../../scripts/live-canary-source-files.mjs") as { sourceDigestFileLabels: string[] };

    expect(manifest.sourceDigestFileLabels).toContain("typescript/CHANGELOG.md");
    expect(manifest.sourceDigestFileLabels).toContain("python/CHANGELOG.md");
  });

  it("includes package build configuration in live promotion source digests", async () => {
    const manifest = await import("../../scripts/live-canary-source-files.mjs") as { sourceDigestFileLabels: string[] };
    const tsconfig = JSON.parse(
      readFileSync(new URL("../tsconfig.json", import.meta.url), "utf8"),
    ) as { compilerOptions?: Record<string, unknown>; include?: string[] };

    expect(manifest.sourceDigestFileLabels).toEqual(expect.arrayContaining([
      "typescript/tsconfig.json",
      "python/MANIFEST.in",
      "python/requirements-dev.txt",
    ]));
    expect(tsconfig.compilerOptions?.sourceMap).not.toBe(true);
    expect(tsconfig.compilerOptions?.inlineSourceMap).not.toBe(true);
    expect(tsconfig.compilerOptions?.declarationMap).not.toBe(true);
    expect(tsconfig.compilerOptions?.inlineSources).not.toBe(true);
    expect(tsconfig.compilerOptions).not.toHaveProperty("sourceRoot");
    expect(tsconfig.compilerOptions).not.toHaveProperty("mapRoot");
    expect(tsconfig.include).toEqual(["src/index.ts"]);
  });

  it("includes repo-level public SDK docs in live promotion source digests", async () => {
    const manifest = await import("../../scripts/live-canary-source-files.mjs") as { sourceDigestFileLabels: string[] };

    expect(manifest.sourceDigestFileLabels).toContain("README.md");
    expect(manifest.sourceDigestFileLabels).toContain("AGENT-NOTES.md");
  });

  it("uses the canonical live canary source manifest for source digests", () => {
    const runner = readFileSync(new URL("../../scripts/run-sdk-live-canaries.mjs", import.meta.url), "utf8");

    expect(runner).toContain('import { sourceDigestFileLabels } from "./live-canary-source-files.mjs";');
    expect(runner).toContain("sourceDigestFileLabels.map");
  });

  it("includes the canary base URL helper in live canary source digests", async () => {
    const manifest = await import("../../scripts/live-canary-source-files.mjs") as { sourceDigestFileLabels: string[] };

    expect(manifest.sourceDigestFileLabels).toContain("scripts/canary-report-base-url.mjs");
  });

  it("includes the canonical live canary matrix in live canary source digests", async () => {
    const manifest = await import("../../scripts/live-canary-source-files.mjs") as { sourceDigestFileLabels: string[] };

    expect(manifest.sourceDigestFileLabels).toContain("scripts/live-canary-matrix.mjs");
  });

  it("blocks readiness drift from the canonical live canary matrix", async () => {
    const { expectedRows } = await import("../../scripts/live-canary-matrix.mjs") as { expectedRows: string[] };
    const { readinessRowCoverageErrors } =
      await import("../../scripts/live-canary-readiness-policy.mjs") as {
        readinessRowCoverageErrors: (expected: string[], readiness: string[]) => string[];
      };
    const runner = readFileSync(new URL("../../scripts/run-sdk-live-canaries.mjs", import.meta.url), "utf8");
    const liveCanaries = readFileSync(new URL("../../LIVE-CANARIES.md", import.meta.url), "utf8");
    const manifest = await import("../../scripts/live-canary-source-files.mjs") as { sourceDigestFileLabels: string[] };

    expect(readinessRowCoverageErrors(expectedRows, expectedRows)).toEqual([]);
    expect(readinessRowCoverageErrors(expectedRows, expectedRows.filter((row) => row !== "images.generate")))
      .toContain("readiness requirements missing strict matrix rows: images.generate");
    expect(readinessRowCoverageErrors(expectedRows, [...expectedRows, "unknown.row"]))
      .toContain("readiness requirements reference unknown strict matrix rows: unknown.row");
    expect(readinessRowCoverageErrors(["models.list", "models.list"], ["models.list"]))
      .toContain("strict matrix duplicate rows: models.list");
    expect(readinessRowCoverageErrors(["models.list"], ["models.list", "models.list"]))
      .toContain("readiness requirements duplicate rows: models.list");
    expect(runner).toContain("readinessRowCoverageErrors(expectedRows, rows.map((row) => row.name))");
    expect(manifest.sourceDigestFileLabels).toContain("scripts/live-canary-readiness-policy.mjs");
    expect(liveCanaries).toContain("readiness requirement rows drift from the canonical strict matrix");
  });

  it("includes the canonical live canary surface coverage manifest in source digests", async () => {
    const manifest = await import("../../scripts/live-canary-source-files.mjs") as { sourceDigestFileLabels: string[] };

    expect(manifest.sourceDigestFileLabels).toContain("scripts/live-canary-surface-coverage.mjs");
  });

  it("includes the canonical live canary source file manifest in source digests", async () => {
    const manifest = await import("../../scripts/live-canary-source-files.mjs") as { sourceDigestFileLabels: string[] };

    expect(manifest.sourceDigestFileLabels).toContain("scripts/live-canary-source-files.mjs");
  });

  it("includes the report leak policy in live canary source digests", async () => {
    const manifest = await import("../../scripts/live-canary-source-files.mjs") as { sourceDigestFileLabels: string[] };

    expect(manifest.sourceDigestFileLabels).toContain("scripts/secret-scan-policy.mjs");
  });

  it("includes the GitHub code-scanning release gate in source digests", async () => {
    const manifest = await import("../../scripts/live-canary-source-files.mjs") as { sourceDigestFileLabels: string[] };

    expect(manifest.sourceDigestFileLabels).toContain("scripts/verify-github-security-status.mjs");
  });

  it("includes live model discovery in source digests", async () => {
    const manifest = await import("../../scripts/live-canary-source-files.mjs") as { sourceDigestFileLabels: string[] };

    expect(manifest.sourceDigestFileLabels).toContain("scripts/live-canary-model-discovery.mjs");
  });

  it("includes production publish gate scripts and workflows in live promotion source digests", async () => {
    const manifest = await import("../../scripts/live-canary-source-files.mjs") as { sourceDigestFileLabels: string[] };

    expect(manifest.sourceDigestFileLabels).toEqual(expect.arrayContaining([
      "scripts/verify-promotion-reports.mjs",
      "scripts/verify-promoted-artifacts.mjs",
      "scripts/verify-npm-package.mjs",
      "scripts/verify-python-package.py",
      "scripts/verify-clean-installs.mjs",
      "scripts/clean-install-policy.mjs",
      "scripts/registry-version-preflight.mjs",
      "scripts/verify-version-sync.mjs",
      "scripts/verify-publish-dispatch.mjs",
      "scripts/verify-workflow-policy.mjs",
      "scripts/workflow-policy.mjs",
      ".github/workflows/ci.yml",
      ".github/workflows/publish.yml",
    ]));
  });

  it("builds redacted live model-discovery candidate reports from catalog metadata", async () => {
    const discovery = await import("../../scripts/live-canary-model-discovery.mjs") as {
      buildModelDiscoveryReport: (input: {
        baseURL: string;
        requestId?: string;
        models: unknown[];
        generatedAt?: string;
      }) => {
        status: string;
        baseURL: string;
        catalog: { count: number; requestId?: string; unclassifiedCount: number };
        candidatesByEnv: Record<string, { candidateIds: string[]; evidence: string[] }>;
      };
    };

    const report = discovery.buildModelDiscoveryReport({
      baseURL: "https://api.runinfra.ai/v1",
      requestId: "req_models_123",
      generatedAt: "2026-05-25T00:00:00.000Z",
      models: [
        {
          id: "llama-3.1-chat",
          object: "model",
          capabilities: ["chat.completions", "responses"],
          internal_only_note: "do-not-serialize",
        },
        { id: "text-embedding-3-small", task: "embeddings" },
        { id: "flux-image", metadata: { modality: "image_generation" } },
        { id: "sonic-tts", tags: ["text-to-speech"] },
        { id: "whisper-asr", capabilities: { transcription: true } },
        { id: "catalog-only-unknown", description: "generic serving target" },
      ],
    });

    expect(report.status).toBe("completed");
    expect(report.baseURL).toBe("https://api.runinfra.ai/v1");
    expect(report.catalog).toMatchObject({
      count: 6,
      requestId: "req_models_123",
      unclassifiedCount: 1,
    });
    expect(report.candidatesByEnv.RUNINFRA_LLM_MODEL.candidateIds).toEqual(["llama-3.1-chat"]);
    expect(report.candidatesByEnv.RUNINFRA_EMBEDDING_MODEL.candidateIds).toEqual(["text-embedding-3-small"]);
    expect(report.candidatesByEnv.RUNINFRA_IMAGE_MODEL.candidateIds).toEqual(["flux-image"]);
    expect(report.candidatesByEnv.RUNINFRA_TTS_MODEL.candidateIds).toEqual(["sonic-tts"]);
    expect(report.candidatesByEnv.RUNINFRA_ASR_MODEL.candidateIds).toEqual(["whisper-asr"]);
    expect(report.candidatesByEnv.RUNINFRA_LLM_MODEL.evidence).toEqual(["capabilities"]);
    expect(JSON.stringify(report)).not.toContain("do-not-serialize");
    expect(JSON.stringify(report)).not.toContain("catalog-only-unknown");
  });

  it("documents the safe live-canary env-file flag instead of Node's flag", () => {
    const docs = [
      readFileSync(new URL("../../README.md", import.meta.url), "utf8"),
      readFileSync(new URL("../../LIVE-CANARIES.md", import.meta.url), "utf8"),
      readFileSync(new URL("../../AGENT-NOTES.md", import.meta.url), "utf8"),
      readFileSync(new URL("../README.md", import.meta.url), "utf8"),
      readFileSync(new URL("../../python/README.md", import.meta.url), "utf8"),
    ];
    const gitignore = readFileSync(new URL("../../.gitignore", import.meta.url), "utf8");

    for (const doc of docs) {
      expect(doc).toContain("`--runinfra-env-file <path-to-env-file>`");
      expect(doc).toContain("--write-env-template");
      expect(doc).toContain("--write-missing-env-template");
      expect(doc).toContain("--readiness-report");
      expect(doc).toContain("missing strict live-canary env patch");
      expect(doc).toContain(".env.sdk-live.local");
      expect(doc).toContain("Do not use Node's `--env-file` option in promotion commands");
    }
    expect(gitignore).toContain(".env.*.local");
  });

  it("documents model discovery as informational and separate from strict preflight", () => {
    const liveCanaries = readFileSync(new URL("../../LIVE-CANARIES.md", import.meta.url), "utf8");

    expect(liveCanaries).toContain("node scripts/run-sdk-live-canaries.mjs --discover-models");
    expect(liveCanaries).toContain("Model discovery is informational");
    expect(liveCanaries).toContain("does not make strict preflight ready");
  });

  it("fails workflow policy when either publish job loses OIDC permission", async () => {
    const publish = readFileSync(new URL("../../.github/workflows/publish.yml", import.meta.url), "utf8");
    const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
    const { evaluateWorkflowPolicy } = await import("../../scripts/workflow-policy.mjs");

    for (const jobName of ["publish-npm", "publish-pypi"]) {
      const mutatedPublish = publish.replace(
        new RegExp(`(\\n  ${jobName}:[\\s\\S]*?\\n    permissions:[\\s\\S]*?\\n      id-token:\\s*)write`, "u"),
        "$1none",
      );
      expect(mutatedPublish).not.toBe(publish);

      const checks = evaluateWorkflowPolicy({
        publish: mutatedPublish,
        ci,
        hasCustomCodeqlWorkflow: false,
      });

      expect(checks.find((check) => check.label === "publish jobs request OIDC id-token permission")?.ok)
        .toBe(false);
    }
    expect(
      readFileSync(new URL("../../scripts/verify-workflow-policy.mjs", import.meta.url), "utf8"),
    ).not.toContain("RUNINFRA_WORKFLOW_POLICY");
  });

  it("requires CI to exercise every declared runtime support line", async () => {
    const publish = readFileSync(new URL("../../.github/workflows/publish.yml", import.meta.url), "utf8");
    const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { engines?: { node?: string } };
    const { evaluateWorkflowPolicy } = await import("../../scripts/workflow-policy.mjs");
    const nodeLabel = "CI tests every supported Node major";
    const pythonLabel = "CI tests every supported Python minor";

    expect(packageJson.engines?.node).toBe(">=18 <25");
    const checks = evaluateWorkflowPolicy({ publish, ci, hasCustomCodeqlWorkflow: false });
    expect(checks.find((check) => check.label === nodeLabel)?.ok).toBe(true);
    expect(checks.find((check) => check.label === pythonLabel)?.ok).toBe(true);

    const withoutNode18 = ci.replace("node-version: [18, 20, 22, 24]", "node-version: [20, 22, 24]");
    expect(withoutNode18).not.toBe(ci);
    expect(evaluateWorkflowPolicy({ publish, ci: withoutNode18, hasCustomCodeqlWorkflow: false })
      .find((check) => check.label === nodeLabel)?.ok).toBe(false);

    const withoutPython39 = ci.replace(
      'python-version: ["3.9", "3.10", "3.11", "3.12", "3.13", "3.14"]',
      'python-version: ["3.10", "3.11", "3.12", "3.13", "3.14"]',
    );
    expect(withoutPython39).not.toBe(ci);
    expect(evaluateWorkflowPolicy({ publish, ci: withoutPython39, hasCustomCodeqlWorkflow: false })
      .find((check) => check.label === pythonLabel)?.ok).toBe(false);
  });

  it("keeps Python test tooling compatible with the declared Python floor", () => {
    const pyproject = readFileSync(new URL("../../python/pyproject.toml", import.meta.url), "utf8");
    const requirements = readFileSync(new URL("../../python/requirements-dev.txt", import.meta.url), "utf8");

    expect(pyproject).toContain('requires-python = ">=3.9"');
    expect(pyproject).toContain('requires = ["setuptools==82.0.1"]');
    expect(pyproject).not.toContain("setuptools>=");
    expect(requirements).toContain("pytest==8.4.2");
    expect(requirements).not.toMatch(/^pytest==9\./mu);
  });

  it("requires real publish to pass strict promotion reports for the exact package artifacts", async () => {
    const publish = readFileSync(new URL("../../.github/workflows/publish.yml", import.meta.url), "utf8");
    const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
    const { evaluateWorkflowPolicy } = await import("../../scripts/workflow-policy.mjs");
    const promotionReportCommand = "node scripts/verify-promotion-reports.mjs --readiness artifacts/sdk/live-canary-readiness.json --live artifacts/sdk/live-canary.json --artifacts-root .";
    const checks = evaluateWorkflowPolicy({ publish, ci, hasCustomCodeqlWorkflow: false });

    expect(checks.find((check) => check.label === "publish workflow gates real publishes on strict promotion reports")?.ok)
      .toBe(true);
    expect(checks.find((check) => check.label === "publish jobs use the exact promoted package artifacts")?.ok)
      .toBe(true);

    const promotionIndex = publish.indexOf(promotionReportCommand);
    const npmPublishIndex = publish.indexOf("npm publish");
    const pypiPublishIndex = publish.indexOf("uses: pypa/gh-action-pypi-publish@cef221092ed1bacb1cc03d23a2d87d1d172e277b");
    expect(promotionIndex).toBeGreaterThan(-1);
    expect(npmPublishIndex).toBeGreaterThan(promotionIndex);
    expect(pypiPublishIndex).toBeGreaterThan(promotionIndex);

    const withoutPromotionGate = publish.replace(
      promotionReportCommand,
      "echo skipped promotion report verification",
    );
    expect(withoutPromotionGate).not.toBe(publish);

    const mutatedChecks = evaluateWorkflowPolicy({
      publish: withoutPromotionGate,
      ci,
      hasCustomCodeqlWorkflow: false,
    });
    expect(mutatedChecks.find((check) => check.label === "publish workflow gates real publishes on strict promotion reports")?.ok)
      .toBe(false);
  });

  it("requires the promotion gate to verify GitHub code scanning before live canaries", async () => {
    const publish = readFileSync(new URL("../../.github/workflows/publish.yml", import.meta.url), "utf8");
    const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
    const { evaluateWorkflowPolicy } = await import("../../scripts/workflow-policy.mjs");
    const label = "promotion gate verifies GitHub code scanning has no open high/critical alerts";

    expect(evaluateWorkflowPolicy({ publish, ci, hasCustomCodeqlWorkflow: false }).find((check) => check.label === label)?.ok)
      .toBe(true);

    const withoutSecurityStep = publish.replace(
      "node scripts/verify-github-security-status.mjs --repo RightNow-AI/runinfra-sdk",
      "echo skipped-security-status",
    );
    expect(evaluateWorkflowPolicy({ publish: withoutSecurityStep, ci, hasCustomCodeqlWorkflow: false }).find((check) => check.label === label)?.ok)
      .toBe(false);

    const withoutSecurityPermission = publish.replace(/\r?\n      security-events:\s*read/u, "");
    expect(evaluateWorkflowPolicy({ publish: withoutSecurityPermission, ci, hasCustomCodeqlWorkflow: false }).find((check) => check.label === label)?.ok)
      .toBe(false);

    expect(publish).toContain("GITHUB_TOKEN: ${{ github.token }}");
    const withoutGithubTokenEnv = publish.replace(
      /\r?\n        env:\r?\n          GITHUB_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}/u,
      "",
    );
    expect(withoutGithubTokenEnv).not.toBe(publish);
    expect(evaluateWorkflowPolicy({ publish: withoutGithubTokenEnv, ci, hasCustomCodeqlWorkflow: false }).find((check) => check.label === label)?.ok)
      .toBe(false);
  });

  it("stages every promoted artifact before the strict artifact canary", async () => {
    const publish = readFileSync(new URL("../../.github/workflows/publish.yml", import.meta.url), "utf8");
    const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
    const { evaluateWorkflowPolicy } = await import("../../scripts/workflow-policy.mjs");
    const checks = evaluateWorkflowPolicy({ publish, ci, hasCustomCodeqlWorkflow: false });

    expect(checks.find((check) => check.label === "promotion gate stages every promoted artifact for strict canaries")?.ok)
      .toBe(true);

    const withoutSdistStaging = publish.replace(
      /\n\s+cp artifacts\/python-local\/runinfra-\*\.tar\.gz python\/dist\//u,
      "",
    );
    expect(withoutSdistStaging).not.toBe(publish);

    const mutatedChecks = evaluateWorkflowPolicy({
      publish: withoutSdistStaging,
      ci,
      hasCustomCodeqlWorkflow: false,
    });
    expect(mutatedChecks.find((check) => check.label === "promotion gate stages every promoted artifact for strict canaries")?.ok)
      .toBe(false);
  });

  it("requires Python artifact clean installs to exercise wheel and sdist artifacts", async () => {
    const publish = readFileSync(new URL("../../.github/workflows/publish.yml", import.meta.url), "utf8");
    const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
    const { evaluateWorkflowPolicy } = await import("../../scripts/workflow-policy.mjs");
    const checks = evaluateWorkflowPolicy({ publish, ci, hasCustomCodeqlWorkflow: false });

    expect(checks.find((check) => check.label === "Python artifact clean installs exercise wheel and sdist")?.ok)
      .toBe(true);

    const withoutSdistCleanInstall = publish.replace(/\s+--python-sdist artifacts\/python-local\/runinfra-\*\.tar\.gz/u, "");
    expect(withoutSdistCleanInstall).not.toBe(publish);

    const mutatedChecks = evaluateWorkflowPolicy({
      publish: withoutSdistCleanInstall,
      ci,
      hasCustomCodeqlWorkflow: false,
    });
    expect(mutatedChecks.find((check) => check.label === "Python artifact clean installs exercise wheel and sdist")?.ok)
      .toBe(false);
  });

  it("keeps non-publishing promotion jobs read-only", async () => {
    const publish = readUtf8Normalized(new URL("../../.github/workflows/publish.yml", import.meta.url));
    const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
    const { evaluateWorkflowPolicy } = await import("../../scripts/workflow-policy.mjs");
    const checks = evaluateWorkflowPolicy({ publish, ci, hasCustomCodeqlWorkflow: false });

    expect(checks.find((check) => check.label === "non-publishing promotion jobs use read-only contents permission")?.ok)
      .toBe(true);

    const withoutBuildReadOnly = publish.replace(
      /(\n  build-artifacts:[\s\S]*?\n    permissions:\n      contents:\s*)read/u,
      "$1write",
    );
    expect(withoutBuildReadOnly).not.toBe(publish);

    const mutatedChecks = evaluateWorkflowPolicy({
      publish: withoutBuildReadOnly,
      ci,
      hasCustomCodeqlWorkflow: false,
    });
    expect(mutatedChecks.find((check) => check.label === "non-publishing promotion jobs use read-only contents permission")?.ok)
      .toBe(false);
  });

  it("verifies downloaded promoted artifact layout before promotion and publishing", async () => {
    const publish = readUtf8Normalized(new URL("../../.github/workflows/publish.yml", import.meta.url));
    const ci = readFileSync(new URL("../../.github/workflows/ci.yml", import.meta.url), "utf8");
    const { evaluateWorkflowPolicy } = await import("../../scripts/workflow-policy.mjs");
    const checks = evaluateWorkflowPolicy({ publish, ci, hasCustomCodeqlWorkflow: false });

    expect(checks.find((check) => check.label === "publish workflow verifies downloaded promoted artifact layout")?.ok)
      .toBe(true);

    const withoutLayoutVerifier = publish.replaceAll(
      "node scripts/verify-promoted-artifacts.mjs artifacts",
      "echo skipped promoted artifact layout verification",
    );
    expect(withoutLayoutVerifier).not.toBe(publish);

    const mutatedChecks = evaluateWorkflowPolicy({
      publish: withoutLayoutVerifier,
      ci,
      hasCustomCodeqlWorkflow: false,
    });
    expect(mutatedChecks.find((check) => check.label === "publish workflow verifies downloaded promoted artifact layout")?.ok)
      .toBe(false);

    const movedAfterNpmArtifactUse = publish.replace(
      [
        "      - name: Verify promoted artifact download layout",
        "        run: node scripts/verify-promoted-artifacts.mjs artifacts",
        "",
        "      - name: Verify exact npm artifact contents (no leaks)",
      ].join("\n"),
      [
        "      - name: Verify exact npm artifact contents (no leaks)",
        "        run: |",
        "          TGZ=$(ls artifacts/npm-local/runinfra-sdk-*.tgz)",
        "          echo \"=== Tarball: $TGZ ===\"",
        "          node scripts/verify-npm-package.mjs \"$TGZ\"",
        "",
        "      - name: Verify promoted artifact download layout",
        "        run: node scripts/verify-promoted-artifacts.mjs artifacts",
      ].join("\n"),
    );
    expect(movedAfterNpmArtifactUse).not.toBe(publish);

    const movedChecks = evaluateWorkflowPolicy({
      publish: movedAfterNpmArtifactUse,
      ci,
      hasCustomCodeqlWorkflow: false,
    });
    expect(movedChecks.find((check) => check.label === "publish workflow verifies downloaded promoted artifact layout")?.ok)
      .toBe(false);
  });

  it("rejects malformed promoted artifact download layouts", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-promoted-artifacts-"));
    try {
      const packageJson = JSON.parse(
        readFileSync(new URL("../package.json", import.meta.url), "utf8"),
      ) as { version: string };
      const version = packageJson.version;
      const artifactRoot = join(tmp, "artifacts");
      mkdirSync(join(artifactRoot, "npm-local"), { recursive: true });
      mkdirSync(join(artifactRoot, "python-local"), { recursive: true });
      writeFileSync(join(artifactRoot, "npm-local", `runinfra-sdk-${version}.tgz`), "npm artifact");
      writeFileSync(join(artifactRoot, "python-local", `runinfra-${version}-py3-none-any.whl`), "wheel artifact");
      writeFileSync(join(artifactRoot, "python-local", `runinfra-${version}.tar.gz`), "sdist artifact");

      const valid = spawnSync(process.execPath, [
        "../scripts/verify-promoted-artifacts.mjs",
        artifactRoot,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });
      expect(valid.status, valid.stdout + valid.stderr).toBe(0);
      expect(valid.stdout).toContain("Verified promoted artifact layout");

      writeFileSync(join(artifactRoot, `runinfra-sdk-${version}.tgz`), "flattened duplicate");
      const malformed = spawnSync(process.execPath, [
        "../scripts/verify-promoted-artifacts.mjs",
        artifactRoot,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });
      expect(malformed.status, malformed.stdout + malformed.stderr).toBe(1);
      expect(malformed.stderr).toContain("unexpected promoted artifact file");
      expect(malformed.stderr).toContain(`runinfra-sdk-${version}.tgz`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reports a non-directory promoted artifact root without a stack trace", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-promoted-artifacts-root-"));
    try {
      const artifactRoot = join(tmp, "artifacts");
      writeFileSync(artifactRoot, "not a directory");

      const malformed = spawnSync(process.execPath, [
        "../scripts/verify-promoted-artifacts.mjs",
        artifactRoot,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });

      expect(malformed.status, malformed.stdout + malformed.stderr).toBe(1);
      expect(malformed.stderr).toContain("promoted artifact root is not a directory");
      expect(malformed.stderr).not.toContain("Error:");
      expect(malformed.stderr).not.toContain("at ");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects promoted artifact downloads for the wrong SDK version", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-promoted-artifacts-version-"));
    try {
      const artifactRoot = join(tmp, "artifacts");
      mkdirSync(join(artifactRoot, "npm-local"), { recursive: true });
      mkdirSync(join(artifactRoot, "python-local"), { recursive: true });
      writeFileSync(join(artifactRoot, "npm-local", "runinfra-sdk-0.0.0.tgz"), "npm artifact");
      writeFileSync(join(artifactRoot, "python-local", "runinfra-0.0.0-py3-none-any.whl"), "wheel artifact");
      writeFileSync(join(artifactRoot, "python-local", "runinfra-0.0.0.tar.gz"), "sdist artifact");

      const malformed = spawnSync(process.execPath, [
        "../scripts/verify-promoted-artifacts.mjs",
        artifactRoot,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });

      const packageJson = JSON.parse(
        readFileSync(new URL("../package.json", import.meta.url), "utf8"),
      ) as { version: string };
      expect(malformed.status, malformed.stdout + malformed.stderr).toBe(1);
      expect(malformed.stderr).toContain(`SDK version ${packageJson.version}`);
      expect(malformed.stderr).toContain("runinfra-sdk-0.0.0.tgz");
      expect(malformed.stderr).toContain("runinfra-0.0.0-py3-none-any.whl");
      expect(malformed.stderr).toContain("runinfra-0.0.0.tar.gz");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("pins registry clean-install checks to canonical npm and PyPI indexes", async () => {
    const { canonicalRegistryInstallEnv, npmRegistryInstallArgs, pythonRegistryInstallArgs, pythonRegistrySourceInstallArgs } =
      await import("../../scripts/clean-install-policy.mjs");
    const env = canonicalRegistryInstallEnv({
      npm_config_registry: "http://127.0.0.1:9/",
      NPM_CONFIG_REGISTRY: "http://127.0.0.1:9/",
      PIP_INDEX_URL: "http://127.0.0.1:9/simple",
      PIP_EXTRA_INDEX_URL: "http://127.0.0.1:9/extra",
      PIP_NO_INDEX: "1",
      PIP_FIND_LINKS: "file:///tmp/packages",
    });

    expect(npmRegistryInstallArgs("0.1.3")).toContain("--registry=https://registry.npmjs.org/");
    expect(pythonRegistryInstallArgs("0.1.3")).toEqual([
      "-m",
      "pip",
      "install",
      "--index-url",
      "https://pypi.org/simple",
      "--no-deps",
      "runinfra==0.1.3",
    ]);
    expect(pythonRegistrySourceInstallArgs("0.1.3")).toEqual([
      "-m",
      "pip",
      "install",
      "--index-url",
      "https://pypi.org/simple",
      "--no-deps",
      "--no-binary",
      "runinfra",
      "runinfra==0.1.3",
    ]);
    expect(env.npm_config_registry).toBe("https://registry.npmjs.org/");
    expect(env.NPM_CONFIG_REGISTRY).toBe("https://registry.npmjs.org/");
    expect(env.PIP_INDEX_URL).toBe("https://pypi.org/simple");
    expect(env.PIP_EXTRA_INDEX_URL).toBe("");
    expect("PIP_NO_INDEX" in env).toBe(false);
    expect("PIP_FIND_LINKS" in env).toBe(false);

    const cleanInstallVerifier = readFileSync(
      new URL("../../scripts/verify-clean-installs.mjs", import.meta.url),
      "utf8",
    );
    expect(cleanInstallVerifier).toContain("pythonRegistrySourceInstallArgs(version)");
    expect(cleanInstallVerifier).toContain('verifyPythonInstall(workspace, "registry-sdist"');
  });

  it("blocks broader credential and local-path families in release scanners", async () => {
    const { findForbiddenContent } = await import("../../scripts/secret-scan-policy.mjs");
    const samples = [
      "github_pat_" + "A".repeat(82),
      "ghs_" + "A".repeat(36),
      "AKIA" + "A".repeat(16),
      "sk_live_" + "A".repeat(24),
      "whsec_" + "A".repeat(32),
      "eyJ" + "A".repeat(20) + "." + "B".repeat(20) + "." + "C".repeat(20),
      "-----BEGIN ENCRYPTED PRIVATE KEY-----",
      "-----BEGIN PGP PRIVATE KEY BLOCK-----",
      "C:\\Users\\someone\\project",
      "/Users/someone/project/.env.local",
      "/home/someone/project/.env.local",
      "//registry.npmjs.org/:_authToken=TOKEN",
      "[pypi]\nusername = __token__\npassword = TOKEN",
      "machine upload.pypi.org login __token__ password TOKEN",
      "[global]\nindex-url = https://user:pass@example.invalid/simple",
      "[global]\nextra-index-url = https://user:pass@example.invalid/simple",
      ".env",
      ".env.local",
      "package/.env.local",
      "/tmp/project/.env.local",
      "//# sourceMappingURL=index.js.map",
      "sourceURL=runinfra-sdk://dist/index.js",
      '{"sourcesContent":["secret source"]}',
      "webpack://runinfra-sdk/./src/index.ts",
    ];

    for (const sample of samples) {
      expect(findForbiddenContent(sample), sample).not.toBeNull();
    }
    expect(findForbiddenContent("Package scanners reject `.pypirc`, `.netrc`, `pip.conf`, and `pip.ini` files.")).toBeNull();
  });

  it("rejects npm package tarballs with wrong package metadata", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-npm-metadata-"));
    try {
      const packageJson = JSON.parse(
        readFileSync(new URL("../package.json", import.meta.url), "utf8"),
      ) as { version: string };
      const tarball = join(tmp, "wrong-metadata-package.tar");
      writeTarball(tarball, [
        { name: "package/CHANGELOG.md", content: "# Changelog\n" },
        { name: "package/LICENSE", content: "MIT\n" },
        { name: "package/README.md", content: "# RunInfra SDK\n" },
        { name: "package/dist/index.d.ts", content: "export declare const value: string;\n" },
        { name: "package/dist/index.js", content: "export const value = 'ok';\n" },
        {
          name: "package/package.json",
          content: JSON.stringify({
            name: "@runinfra/wrong",
            version: "0.0.0",
            type: "commonjs",
            main: "./src/index.ts",
            module: "./dist/index.js",
            types: "./dist/index.d.ts",
            exports: {
              ".": {
                types: "./dist/index.d.ts",
                import: "./src/index.ts",
                default: "./dist/index.js",
              },
            },
          }),
        },
      ]);

      const result = spawnSync(process.execPath, [
        "../scripts/verify-npm-package.mjs",
        tarball,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });

      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain("Invalid package metadata:");
      expect(result.stderr).toContain("package.json name must be @runinfra/sdk");
      expect(result.stderr).toContain(`package.json version must be ${packageJson.version}`);
      expect(result.stderr).toContain("package.json type must be module");
      expect(result.stderr).toContain("package.json main must be ./dist/index.js");
      expect(result.stderr).toContain('package.json exports["."].import must be ./dist/index.js');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects npm package tarballs with extra export entrypoints", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-npm-extra-exports-"));
    try {
      const packageJson = JSON.parse(
        readFileSync(new URL("../package.json", import.meta.url), "utf8"),
      ) as { version: string };
      const tarball = join(tmp, "extra-exports-package.tar");
      writeTarball(tarball, [
        { name: "package/CHANGELOG.md", content: "# Changelog\n" },
        { name: "package/LICENSE", content: "MIT\n" },
        { name: "package/README.md", content: "# RunInfra SDK\n" },
        { name: "package/dist/index.d.ts", content: "export declare const value: string;\n" },
        { name: "package/dist/index.js", content: "export const value = 'ok';\n" },
        {
          name: "package/package.json",
          content: JSON.stringify({
            name: "@runinfra/sdk",
            version: packageJson.version,
            type: "module",
            main: "./dist/index.js",
            module: "./dist/index.js",
            types: "./dist/index.d.ts",
            exports: {
              ".": {
                types: "./dist/index.d.ts",
                import: "./dist/index.js",
                default: "./dist/index.js",
                require: "./dist/index.cjs",
              },
              "./internal": "./dist/internal.js",
            },
          }),
        },
      ]);

      const result = spawnSync(process.execPath, [
        "../scripts/verify-npm-package.mjs",
        tarball,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });

      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain('package.json exports must expose only "."');
      expect(result.stderr).toContain('package.json exports["."] must expose only default, import, types');
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects npm package tarballs with runtime dependencies or install hooks", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-npm-runtime-deps-"));
    try {
      const packageJson = JSON.parse(
        readFileSync(new URL("../package.json", import.meta.url), "utf8"),
      ) as { version: string };
      const tarball = join(tmp, "runtime-deps-package.tar");
      writeTarball(tarball, [
        { name: "package/CHANGELOG.md", content: "# Changelog\n" },
        { name: "package/LICENSE", content: "MIT\n" },
        { name: "package/README.md", content: "# RunInfra SDK\n" },
        { name: "package/dist/index.d.ts", content: "export declare const value: string;\n" },
        { name: "package/dist/index.js", content: "export const value = 'ok';\n" },
        {
          name: "package/package.json",
          content: JSON.stringify({
            name: "@runinfra/sdk",
            version: packageJson.version,
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
            dependencies: { "left-pad": "1.3.0" },
            optionalDependencies: { "debug": "4.3.7" },
            peerDependencies: { react: "^19.0.0" },
            bundledDependencies: ["left-pad"],
            bundleDependencies: ["debug"],
            scripts: {
              build: "tsc -p tsconfig.json",
              preinstall: "node ./dist/preinstall.js",
              install: "node ./dist/install.js",
              postinstall: "node ./dist/postinstall.js",
              prepare: "node ./dist/prepare.js",
              prepublish: "node ./dist/prepublish.js",
              prepublishOnly: "node ./dist/prepublishOnly.js",
            },
          }),
        },
      ]);

      const result = spawnSync(process.execPath, [
        "../scripts/verify-npm-package.mjs",
        tarball,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });

      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain("package.json dependencies must be absent or empty");
      expect(result.stderr).toContain("package.json optionalDependencies must be absent or empty");
      expect(result.stderr).toContain("package.json peerDependencies must be absent or empty");
      expect(result.stderr).toContain("package.json bundledDependencies must be absent or empty");
      expect(result.stderr).toContain("package.json bundleDependencies must be absent or empty");
      expect(result.stderr).toContain("package.json scripts.preinstall is not allowed in published artifacts");
      expect(result.stderr).toContain("package.json scripts.install is not allowed in published artifacts");
      expect(result.stderr).toContain("package.json scripts.postinstall is not allowed in published artifacts");
      expect(result.stderr).toContain("package.json scripts.prepare is not allowed in published artifacts");
      expect(result.stderr).toContain("package.json scripts.prepublish is not allowed in published artifacts");
      expect(result.stderr).toContain("package.json scripts.prepublishOnly is not allowed in published artifacts");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects npm package tarballs with malformed dependency metadata fields", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-npm-malformed-deps-"));
    try {
      const packageJson = JSON.parse(
        readFileSync(new URL("../package.json", import.meta.url), "utf8"),
      ) as { version: string };
      const tarball = join(tmp, "malformed-deps-package.tar");
      writeTarball(tarball, [
        { name: "package/CHANGELOG.md", content: "# Changelog\n" },
        { name: "package/LICENSE", content: "MIT\n" },
        { name: "package/README.md", content: "# RunInfra SDK\n" },
        { name: "package/dist/index.d.ts", content: "export declare const value: string;\n" },
        { name: "package/dist/index.js", content: "export const value = 'ok';\n" },
        {
          name: "package/package.json",
          content: JSON.stringify({
            name: "@runinfra/sdk",
            version: packageJson.version,
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
            dependencies: "left-pad@1.3.0",
          }),
        },
      ]);

      const result = spawnSync(process.execPath, [
        "../scripts/verify-npm-package.mjs",
        tarball,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });

      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain("package.json dependencies must be absent or empty");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects npm package tarballs with duplicate file entries", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-npm-duplicate-"));
    try {
      const distDir = join(tmp, "package", "dist");
      mkdirSync(distDir, { recursive: true });
      const files = new Map([
        ["package/CHANGELOG.md", "# Changelog\n"],
        ["package/LICENSE", "MIT\n"],
        ["package/README.md", "# RunInfra SDK\n"],
        ["package/dist/index.d.ts", "export declare const value: string;\n"],
        ["package/dist/index.js", "export const value = 'ok';\n"],
        ["package/package.json", "{\"name\":\"@runinfra/sdk\",\"version\":\"0.0.0\"}\n"],
      ]);
      for (const [file, content] of files) {
        writeFileSync(join(tmp, file), content);
      }

      const tarball = join(tmp, "duplicate-package.tar");
      const tarResult = spawnSync("tar", [
        "-cf",
        tarball,
        "-C",
        tmp,
        ...files.keys(),
        "package/README.md",
      ], { encoding: "utf8" });
      expect(tarResult.status, tarResult.stderr).toBe(0);

      const result = spawnSync(process.execPath, [
        "../scripts/verify-npm-package.mjs",
        tarball,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });

      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain("Duplicate files:");
      expect(result.stderr).toContain("package/README.md");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects npm package tarballs with non-regular file entries", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-npm-nonregular-"));
    try {
      const tarball = join(tmp, "nonregular-package.tar");
      writeTarball(tarball, [
        { name: "package/CHANGELOG.md", content: "# Changelog\n" },
        { name: "package/LICENSE", content: "MIT\n" },
        { name: "package/dist/index.d.ts", content: "export declare const value: string;\n" },
        { name: "package/dist/index.js", content: "export const value = 'ok';\n" },
        { name: "package/package.json", content: "{\"name\":\"@runinfra/sdk\",\"version\":\"0.0.0\"}\n" },
        { name: "package/README.md", type: "2", linkname: "LICENSE" },
      ]);

      const result = spawnSync(process.execPath, [
        "../scripts/verify-npm-package.mjs",
        tarball,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });

      expect(result.status, result.stdout + result.stderr).toBe(1);
      expect(result.stderr).toContain("Non-regular files:");
      expect(result.stderr).toContain("package/README.md");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("verifies public SDK surface has canary row coverage", () => {
    const result = spawnSync(process.execPath, [
      "../scripts/run-sdk-live-canaries.mjs",
      "--verify-surface-coverage",
    ], {
      cwd: new URL("..", import.meta.url),
      encoding: "utf8",
      env: {
        ...process.env,
        RUNINFRA_API_KEY: "",
      },
    });

    expect(result.status, result.stderr).toBe(0);
    const output = JSON.parse(result.stdout) as {
      status?: string;
      declaredSurfaces?: string[];
      uncoveredSurfaces?: string[];
      uncoveredRows?: string[];
      surfaceCount?: number;
      rowCount?: number;
      surfaces?: string[];
    };
    expect(output.status).toBe("passed");
    expect(output.uncoveredSurfaces).toEqual([]);
    expect(output.uncoveredRows).toEqual([]);
    expect(output.surfaceCount).toBeGreaterThanOrEqual(17);
    expect(output.rowCount).toBeGreaterThanOrEqual(39);
    expect(output.surfaces).toEqual(expect.arrayContaining([
      "client.chat.completions.create",
      "client.responses.create",
      "client.embeddings.create",
      "client.images.generate",
      "client.audio.speech.create",
      "client.audio.transcriptions.create",
      "client.voice.pipeline.create",
      "client.webhooks.verifySignature",
      "verifyWebhookSignature",
      "RunInfraAudioResponse.blob",
    ]));
    expect(output.declaredSurfaces).toEqual(expect.arrayContaining([
      "client.models.list",
      "client.models.retrieve",
      "client.chat.completions.create",
      "client.responses.create",
      "client.embeddings.create",
      "client.images.generate",
      "client.audio.speech.create",
      "client.audio.transcriptions.create",
      "client.voice.pipeline.create",
      "client.webhooks.verifySignature",
      "client.webhooks.verify_signature",
      "verifyWebhookSignature",
      "verify_webhook_signature",
      "RunInfraAudioResponse.arrayBuffer",
      "RunInfraAudioResponse.blob",
      "RunInfraAudioResponse.stream",
      "RunInfraStream[Symbol.asyncIterator]",
      "RunInfraStream.__iter__",
    ]));
  });

  it("writes surface coverage into early full-run failure reports", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-full-failure-"));
    const configReportPath = join(tmp, "config-report.json");
    const artifactReportPath = join(tmp, "artifact-report.json");
    const runnerPath = join(process.cwd(), "..", "scripts", "run-sdk-live-canaries.mjs");
    try {
      const configFailure = spawnSync(process.execPath, [
        "../scripts/run-sdk-live-canaries.mjs",
        "--package-source",
        "source",
        "--report",
        configReportPath,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        env: {
          ...process.env,
          RUNINFRA_CANARY_TIMEOUT_SECONDS: "NaN",
          RUNINFRA_API_KEY: "",
        },
      });

      expect(configFailure.status).toBe(1);
      const configReport = JSON.parse(readFileSync(configReportPath, "utf8")) as {
        surfaceCoverage?: { status?: string; uncoveredSurfaces?: string[] };
        parity?: { errors?: string[] };
      };
      expect(configReport.surfaceCoverage?.status).toBe("passed");
      expect(configReport.surfaceCoverage?.uncoveredSurfaces).toEqual([]);
      expect(configReport.parity?.errors).toEqual(expect.arrayContaining([
        "RUNINFRA_CANARY_TIMEOUT_SECONDS positive finite number <= 600",
      ]));

      const artifactFailure = spawnSync(process.execPath, [
        runnerPath,
        "--package-source",
        "artifact",
        "--report",
        artifactReportPath,
      ], {
        cwd: tmp,
        encoding: "utf8",
        env: {
          ...process.env,
          RUNINFRA_API_KEY: "",
        },
      });

      expect(artifactFailure.status).toBe(1);
      const artifactReport = JSON.parse(readFileSync(artifactReportPath, "utf8")) as {
        surfaceCoverage?: { status?: string; uncoveredSurfaces?: string[] };
        parity?: { errors?: string[] };
      };
      expect(artifactReport.surfaceCoverage?.status).toBe("passed");
      expect(artifactReport.surfaceCoverage?.uncoveredSurfaces).toEqual([]);
      expect(artifactReport.parity?.errors?.some((error) =>
        error.startsWith("artifact canary package setup failed"),
      )).toBe(true);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails artifact live-canary setup when artifacts do not match the current SDK version", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-artifact-version-"));
    const reportPath = join(tmp, "artifact-report.json");
    const runnerPath = join(process.cwd(), "..", "scripts", "run-sdk-live-canaries.mjs");
    try {
      mkdirSync(join(tmp, "typescript"), { recursive: true });
      mkdirSync(join(tmp, "python", "dist"), { recursive: true });
      writeFileSync(join(tmp, "typescript", "runinfra-sdk-0.0.0.tgz"), "stale");
      writeFileSync(join(tmp, "python", "dist", "runinfra-0.0.0-py3-none-any.whl"), "stale");

      const result = spawnSync(process.execPath, [
        runnerPath,
        "--package-source",
        "artifact",
        "--report",
        reportPath,
      ], {
        cwd: tmp,
        encoding: "utf8",
        env: {
          ...process.env,
          RUNINFRA_API_KEY: "",
        },
      });

      expect(result.status).toBe(1);
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
        parity?: { errors?: string[] };
      };
      expect(report.parity?.errors).toContain(
        `artifact canary package setup failed: npm artifact for SDK version ${RUNINFRA_SDK_VERSION} not found. Build package artifacts first.`,
      );
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("writes artifact digests into artifact setup failure reports after artifacts resolve", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-artifact-digest-failure-"));
    const reportPath = join(tmp, "artifact-report.json");
    const runnerPath = join(process.cwd(), "..", "scripts", "run-sdk-live-canaries.mjs");
    try {
      const npmName = `runinfra-sdk-${RUNINFRA_SDK_VERSION}.tgz`;
      const wheelName = `runinfra-${RUNINFRA_SDK_VERSION}-py3-none-any.whl`;
      const sdistName = `runinfra-${RUNINFRA_SDK_VERSION}.tar.gz`;
      mkdirSync(join(tmp, "typescript"), { recursive: true });
      mkdirSync(join(tmp, "python", "dist"), { recursive: true });
      writeFileSync(join(tmp, "typescript", npmName), "not a valid npm tarball");
      writeFileSync(join(tmp, "python", "dist", wheelName), "not a valid Python wheel");
      writeFileSync(join(tmp, "python", "dist", sdistName), "not a valid Python sdist");

      const result = spawnSync(process.execPath, [
        runnerPath,
        "--package-source",
        "artifact",
        "--report",
        reportPath,
      ], {
        cwd: tmp,
        encoding: "utf8",
        env: {
          ...process.env,
          RUNINFRA_API_KEY: "",
        },
      });

      expect(result.status).toBe(1);
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
        candidate?: {
          packageSource?: string;
          artifactDigestsChecked?: boolean;
          artifacts?: Array<{ fileName?: string; sha256?: string }>;
        };
      };
      expect(report.candidate?.packageSource).toBe("artifact");
      expect(report.candidate?.artifactDigestsChecked).toBe(true);
      expect(report.candidate?.artifacts?.map((artifact) => artifact.fileName)).toEqual([npmName, wheelName, sdistName]);
      for (const artifact of report.candidate?.artifacts ?? []) {
        expect(artifact.fileName).not.toMatch(/[\\/]/u);
        expect(artifact.sha256).toMatch(/^[a-f0-9]{64}$/u);
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("suppresses successful artifact setup command output before child canaries run", () => {
    const runner = readUtf8Normalized(new URL("../../scripts/run-sdk-live-canaries.mjs", import.meta.url));
    const runCheckedBlock = runner.match(/function runChecked[\s\S]*?\n\}\n/u)?.[0] ?? "";

    expect(runCheckedBlock).toContain('stdio: "pipe"');
    expect(runCheckedBlock).toContain("maxBuffer:");
    expect(runner).toContain("safeSetupOutputSummary(result)");
    expect(runner).toContain("redactSetupOutputTail");
    expect(runner).toContain("[redacted-path]");
    expect(runCheckedBlock).not.toContain('stdio: "inherit"');
  });

  it("removes parent live-canary temporary child reports when artifact failure report writing fails", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-artifact-report-write-failure-"));
    const reportParent = join(tmp, "not-a-directory");
    const reportPath = join(reportParent, "live-canary.json");
    const runnerPath = join(process.cwd(), "..", "scripts", "run-sdk-live-canaries.mjs");
    try {
      writeFileSync(reportParent, "blocks report directory creation");

      const result = spawnSync(process.execPath, [
        runnerPath,
        "--package-source",
        "artifact",
        "--report",
        reportPath,
      ], {
        cwd: tmp,
        encoding: "utf8",
        env: {
          ...process.env,
          RUNINFRA_API_KEY: "",
        },
      });

      expect(result.status).toBe(1);
      expect(existsSync(join(tmp, ".canary-tmp"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails parent live-canary parity when child reports use the wrong SDK version", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-child-version-"));
    const reportPath = join(tmp, "live-canary.json");
    const runnerPath = join(process.cwd(), "..", "scripts", "run-sdk-live-canaries.mjs");
    try {
      mkdirSync(join(tmp, "scripts"), { recursive: true });
      writeFileSync(join(tmp, "scripts", "sdk-live-canary-typescript.mjs"), `
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const report = process.argv[process.argv.indexOf("--report") + 1];
mkdirSync(dirname(report), { recursive: true });
writeFileSync(report, JSON.stringify({ language: "typescript", sdkVersion: "0.0.0", results: [] }));
`);
      writeFileSync(join(tmp, "scripts", "sdk-live-canary-python.py"), `
import json
import os
import sys
report = sys.argv[sys.argv.index("--report") + 1]
os.makedirs(os.path.dirname(report), exist_ok=True)
with open(report, "w", encoding="utf-8") as handle:
    json.dump({"language": "python", "sdkVersion": "0.0.0", "results": []}, handle)
`);

      const result = spawnSync(process.execPath, [
        runnerPath,
        "--package-source",
        "source",
        "--report",
        reportPath,
      ], {
        cwd: tmp,
        encoding: "utf8",
        env: {
          ...process.env,
          RUNINFRA_API_KEY: "",
        },
      });

      expect(result.status).toBe(1);
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
        parity?: { errors?: string[] };
      };
      expect(report.parity?.errors).toContain(`typescript SDK version 0.0.0 != ${RUNINFRA_SDK_VERSION}`);
      expect(report.parity?.errors).toContain(`python SDK version 0.0.0 != ${RUNINFRA_SDK_VERSION}`);
      expect(existsSync(join(tmp, ".canary-tmp"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails strict parent live-canary parity when child reports contain failed or skipped rows", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-child-status-parity-"));
    const reportPath = join(tmp, "live-canary.json");
    const runnerPath = join(process.cwd(), "..", "scripts", "run-sdk-live-canaries.mjs");
    const { expectedRows } = await import("../../scripts/live-canary-matrix.mjs") as { expectedRows: string[] };
    const rowsJson = JSON.stringify(expectedRows);
    try {
      mkdirSync(join(tmp, "scripts"), { recursive: true });
      writeFileSync(join(tmp, "scripts", "sdk-live-canary-typescript.mjs"), `
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const expectedRows = ${rowsJson};
const report = process.argv[process.argv.indexOf("--report") + 1];
const results = expectedRows.map((name, index) => ({
  name,
  status: index === 0 ? "failed" : index === 1 ? "skipped" : "passed",
}));
mkdirSync(dirname(report), { recursive: true });
writeFileSync(report, JSON.stringify({
  language: "typescript",
  sdkVersion: "${RUNINFRA_SDK_VERSION}",
  strict: true,
  baseURL: "https://api.runinfra.ai/v1",
  summary: { passed: expectedRows.length - 2, failed: 1, skipped: 1 },
  results,
}));
`);
      writeFileSync(join(tmp, "scripts", "sdk-live-canary-python.py"), `
import json
import os
import sys
expected_rows = ${JSON.stringify(expectedRows)}
report = sys.argv[sys.argv.index("--report") + 1]
os.makedirs(os.path.dirname(report), exist_ok=True)
with open(report, "w", encoding="utf-8") as handle:
    json.dump({
        "language": "python",
        "sdkVersion": "${RUNINFRA_SDK_VERSION}",
        "strict": True,
        "baseURL": "https://api.runinfra.ai/v1",
        "summary": {"passed": len(expected_rows), "failed": 0, "skipped": 0},
        "results": [{"name": name, "status": "passed"} for name in expected_rows],
    }, handle)
`);

      const result = spawnSync(process.execPath, [
        runnerPath,
        "--package-source",
        "source",
        "--strict",
        "--report",
        reportPath,
      ], {
        cwd: tmp,
        encoding: "utf8",
        env: {
          ...process.env,
          RUNINFRA_API_KEY: "",
        },
      });

      expect(result.status).toBe(1);
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
        parity?: { status?: string; errors?: string[] };
      };
      expect(report.parity?.status).toBe("failed");
      expect(report.parity?.errors).toContain(`typescript row ${expectedRows[0]} must be passed`);
      expect(report.parity?.errors).toContain(`typescript row ${expectedRows[1]} must be passed`);
      expect(report.parity?.errors).toContain(`typescript summary failed count must be 0`);
      expect(report.parity?.errors).toContain(`typescript summary skipped count must be 0`);
      expect(existsSync(join(tmp, ".canary-tmp"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("removes parent live-canary temporary child reports when final report writing fails", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-report-write-failure-"));
    const reportParent = join(tmp, "not-a-directory");
    const reportPath = join(reportParent, "live-canary.json");
    const runnerPath = join(process.cwd(), "..", "scripts", "run-sdk-live-canaries.mjs");
    try {
      mkdirSync(join(tmp, "scripts"), { recursive: true });
      writeFileSync(reportParent, "blocks report directory creation");
      writeFileSync(join(tmp, "scripts", "sdk-live-canary-typescript.mjs"), `
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
const report = process.argv[process.argv.indexOf("--report") + 1];
mkdirSync(dirname(report), { recursive: true });
writeFileSync(report, JSON.stringify({ language: "typescript", sdkVersion: "${RUNINFRA_SDK_VERSION}", results: [] }));
`);
      writeFileSync(join(tmp, "scripts", "sdk-live-canary-python.py"), `
import json
import os
import sys
report = sys.argv[sys.argv.index("--report") + 1]
os.makedirs(os.path.dirname(report), exist_ok=True)
with open(report, "w", encoding="utf-8") as handle:
    json.dump({"language": "python", "sdkVersion": "${RUNINFRA_SDK_VERSION}", "results": []}, handle)
`);

      const result = spawnSync(process.execPath, [
        runnerPath,
        "--package-source",
        "source",
        "--report",
        reportPath,
      ], {
        cwd: tmp,
        encoding: "utf8",
        env: {
          ...process.env,
          RUNINFRA_API_KEY: "",
        },
      });

      expect(result.status).toBe(1);
      expect(existsSync(join(tmp, ".canary-tmp"))).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("writes a redacted strict live-canary preflight report without running live calls", async () => {
    const sourceManifest = await import("../../scripts/live-canary-source-files.mjs") as { sourceDigestFileLabels: string[] };
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-preflight-"));
    const reportPath = join(tmp, "readiness.json");
    try {
      const fakeKey = "preflight-api-key-placeholder";
      const result = spawnSync(process.execPath, [
        "../scripts/run-sdk-live-canaries.mjs",
        "--preflight",
        "--strict",
        "--package-source",
        "source",
        "--report",
        reportPath,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        env: {
          ...process.env,
          RUNINFRA_API_KEY: fakeKey,
          RUNINFRA_LLM_MODEL: "llm-preflight-model",
          RUNINFRA_EMBEDDING_MODEL: "",
          RUNINFRA_IMAGE_MODEL: "",
          RUNINFRA_TTS_MODEL: "",
          RUNINFRA_ASR_MODEL: "",
          RUNINFRA_ASR_FIXTURE_PATH: "",
          RUNINFRA_ASR_EXPECTED_TEXT: "",
          RUNINFRA_CANARY_ENABLE_IDEMPOTENCY: "",
        },
      });

      expect(result.status).toBe(1);
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
        expectedRows?: string[];
        candidate?: {
          sdkVersion?: string;
          packageSource?: string;
          sourceDigestSha256?: string;
          sourceFileCount?: number;
          artifactDigestsChecked?: boolean;
          artifacts?: unknown[];
        };
        readiness?: {
          status?: string;
          env?: Record<string, string>;
          missing?: string[];
          rows?: Array<{ name: string; status: string; missing?: string[] }>;
        };
        reports?: unknown[];
      };
      expect(report.reports).toEqual([]);
      expect(report.candidate).toMatchObject({
        sdkVersion: RUNINFRA_SDK_VERSION,
        packageSource: "source",
        artifactDigestsChecked: false,
        artifacts: [],
      });
      expect(report.candidate?.sourceDigestSha256).toMatch(/^[a-f0-9]{64}$/u);
      expect(report.candidate?.sourceFileCount).toBe(sourceManifest.sourceDigestFileLabels.length);
      expect(report.readiness?.status).toBe("blocked");
      expect(report.readiness?.rows?.map((row) => row.name)).toEqual(report.expectedRows);
      expect(report.expectedRows).toEqual(expect.arrayContaining([
        "webhooks.delivery_surface.absent",
        "webhooks.verify_signature.export",
        "webhooks.construct_event.export",
      ]));
      expect(report.expectedRows).not.toContain("webhooks.create.unsupported");
      expect(report.expectedRows).not.toContain("webhooks.list.unsupported");
      expect(report.readiness?.env?.RUNINFRA_API_KEY).toBe("set_redacted");
      expect(report.readiness?.env?.RUNINFRA_LLM_MODEL).toBe("set_redacted");
      expect(report.readiness?.missing).toContain("RUNINFRA_EMBEDDING_MODEL");
      expect(report.expectedRows).toContain("error.model.not_found");
      expect(
        report.readiness?.rows?.find((row) => row.name === "error.model.not_found")?.missing,
      ).toEqual([]);
      expect(report.expectedRows).toEqual(expect.arrayContaining([
        "models.retrieve.llm",
        "models.retrieve.embedding",
        "models.retrieve.image",
        "models.retrieve.tts",
        "models.retrieve.asr",
      ]));
      expect(
        report.readiness?.rows?.find((row) => row.name === "models.retrieve.llm")?.missing,
      ).toEqual([]);
      expect(
        report.readiness?.rows?.find((row) => row.name === "models.retrieve.embedding")?.missing,
      ).toEqual(["RUNINFRA_EMBEDDING_MODEL"]);
      expect(
        report.readiness?.rows?.find((row) => row.name === "models.retrieve.image")?.missing,
      ).toEqual(["RUNINFRA_IMAGE_MODEL"]);
      expect(
        report.readiness?.rows?.find((row) => row.name === "models.retrieve.tts")?.missing,
      ).toEqual(["RUNINFRA_TTS_MODEL"]);
      expect(
        report.readiness?.rows?.find((row) => row.name === "models.retrieve.asr")?.missing,
      ).toEqual(["RUNINFRA_ASR_MODEL"]);
      expect(report.expectedRows).toContain("openai.params.chat.stream_options");
      expect(
        report.readiness?.rows?.find((row) => row.name === "openai.params.chat.stream_options")?.missing,
      ).toEqual([]);
      expect(
        report.readiness?.rows?.find((row) => row.name === "audio.transcriptions.create")?.missing,
      ).toEqual(expect.arrayContaining([
        "RUNINFRA_ASR_MODEL",
        "RUNINFRA_ASR_FIXTURE_PATH",
        "RUNINFRA_ASR_EXPECTED_TEXT",
      ]));
      expect(report.expectedRows).toContain("openai.params.audio.transcriptions");
      expect(
        report.readiness?.rows?.find((row) => row.name === "openai.params.audio.transcriptions")?.missing,
      ).toEqual(expect.arrayContaining([
        "RUNINFRA_ASR_MODEL",
        "RUNINFRA_ASR_LANGUAGE",
        "RUNINFRA_ASR_RESPONSE_FORMAT",
        "RUNINFRA_ASR_FIXTURE_PATH",
        "RUNINFRA_ASR_EXPECTED_TEXT",
      ]));
      expect(report.expectedRows).toContain("audio.speech.binary_interfaces");
      expect(
        report.readiness?.rows?.find((row) => row.name === "audio.speech.binary_interfaces")?.missing,
      ).toEqual(expect.arrayContaining([
        "RUNINFRA_TTS_MODEL",
        "RUNINFRA_TTS_VOICE or RUNINFRA_TTS_REF_AUDIO plus RUNINFRA_TTS_REF_TEXT",
      ]));
      expect(report.expectedRows).toContain("openai.params.audio.speech");
      expect(
        report.readiness?.rows?.find((row) => row.name === "openai.params.audio.speech")?.missing,
      ).toEqual(expect.arrayContaining([
        "RUNINFRA_TTS_MODEL",
        "RUNINFRA_TTS_RESPONSE_FORMAT",
        "RUNINFRA_TTS_VOICE or RUNINFRA_TTS_REF_AUDIO plus RUNINFRA_TTS_REF_TEXT",
      ]));

      const invalidFormatReportPath = join(tmp, "invalid-tts-format.json");
      const invalidFormatResult = spawnSync(process.execPath, [
        "../scripts/run-sdk-live-canaries.mjs",
        "--preflight",
        "--strict",
        "--package-source",
        "source",
        "--report",
        invalidFormatReportPath,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        env: {
          ...process.env,
          RUNINFRA_API_KEY: fakeKey,
          RUNINFRA_LLM_MODEL: "llm-preflight-model",
          RUNINFRA_TTS_MODEL: "tts-preflight-model",
          RUNINFRA_TTS_VOICE: "voice-preflight",
          RUNINFRA_TTS_RESPONSE_FORMAT: "json",
          RUNINFRA_ASR_MODEL: "",
          RUNINFRA_ASR_FIXTURE_PATH: "",
          RUNINFRA_ASR_EXPECTED_TEXT: "",
          RUNINFRA_CANARY_ENABLE_IDEMPOTENCY: "",
        },
      });
      expect(invalidFormatResult.status).toBe(1);
      const invalidFormatReport = JSON.parse(readFileSync(invalidFormatReportPath, "utf8")) as {
        readiness?: { rows?: Array<{ name: string; missing?: string[] }> };
      };
      expect(
        invalidFormatReport.readiness?.rows?.find((row) => row.name === "openai.params.audio.speech")?.missing,
      ).toContain("RUNINFRA_TTS_RESPONSE_FORMAT mp3, opus, aac, flac, wav, or pcm");
      expect(JSON.stringify(invalidFormatReport)).not.toContain("json");
      expect(report.expectedRows).toContain("openai.params.images");
      expect(
        report.readiness?.rows?.find((row) => row.name === "openai.params.images")?.missing,
      ).toEqual(expect.arrayContaining([
        "RUNINFRA_IMAGE_MODEL",
        "RUNINFRA_IMAGE_SIZE",
        "RUNINFRA_IMAGE_RESPONSE_FORMAT",
      ]));
      expect(JSON.stringify(report)).not.toContain(fakeKey);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("accepts RunPipe sdk-live TEST aliases in strict preflight without leaking values", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-preflight-aliases-"));
    const reportPath = join(tmp, "readiness.json");
    try {
      const fakeKey = "preflight-api-key-placeholder";
      const result = spawnSync(process.execPath, [
        "../scripts/run-sdk-live-canaries.mjs",
        "--preflight",
        "--strict",
        "--package-source",
        "source",
        "--report",
        reportPath,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        env: {
          ...process.env,
          RUNINFRA_API_KEY: fakeKey,
          TEST_MODEL: "llm-alias-model",
          TEST_EMBEDDING_MODEL: "embedding-alias-model",
          RUNINFRA_EMBEDDING_DIMENSIONS: "384",
          TEST_IMAGE_MODEL: "image-alias-model",
          RUNINFRA_IMAGE_SIZE: "1024x1024",
          RUNINFRA_IMAGE_RESPONSE_FORMAT: "b64_json",
          TEST_TTS_MODEL: "tts-alias-model",
          TEST_TTS_VOICE: "alloy",
          RUNINFRA_TTS_RESPONSE_FORMAT: "mp3",
          TEST_ASR_MODEL: "asr-alias-model",
          TEST_ASR_FILE: __filename,
          RUNINFRA_ASR_EXPECTED_TEXT: "hello",
          RUNINFRA_ASR_LANGUAGE: "en",
          RUNINFRA_ASR_RESPONSE_FORMAT: "json",
          TEST_PIPELINE_ID: "pipeline-alias",
          RUNINFRA_CANARY_ENABLE_IDEMPOTENCY: "1",
        },
      });

      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
        readiness?: {
          status?: string;
          env?: Record<string, string>;
          missing?: string[];
          rows?: Array<{ name: string; status: string; missing?: string[] }>;
          aliases?: Record<string, string[]>;
        };
      };
      expect(report.readiness?.status).toBe("ready");
      expect(report.readiness?.missing).toEqual([]);
      expect(report.readiness?.rows?.every((row) => row.status === "ready")).toBe(true);
      expect(report.readiness?.env?.RUNINFRA_LLM_MODEL).toBe("set_redacted");
      expect(report.readiness?.env?.RUNINFRA_ASR_FIXTURE_PATH).toBe("set_redacted");
      expect(report.readiness?.env?.TEST_PIPELINE_ID).toBeUndefined();
      expect(report.readiness?.aliases?.RUNINFRA_LLM_MODEL).toContain("TEST_MODEL");
      expect(report.readiness?.aliases?.RUNINFRA_VOICE_PIPELINE_ID).toContain("TEST_PIPELINE_ID");
      expect(JSON.stringify(report)).not.toContain(fakeKey);
      expect(JSON.stringify(report)).not.toContain("llm-alias-model");
      expect(JSON.stringify(report)).not.toContain("pipeline-alias");
      expect(JSON.stringify(report)).not.toContain(__filename);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("loads strict preflight inputs from --runinfra-env-file without leaking values", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-preflight-env-file-"));
    const reportPath = join(tmp, "readiness.json");
    const envPath = join(tmp, "runinfra-live-inputs");
    try {
      const fakeKey = "env-file-api-key-placeholder";
      writeFileSync(envPath, [
        `RUNINFRA_API_KEY=${fakeKey}`,
        "TEST_MODEL=llm-env-file-model",
        "TEST_EMBEDDING_MODEL=embedding-env-file-model",
        "RUNINFRA_EMBEDDING_DIMENSIONS=384",
        "TEST_IMAGE_MODEL=image-env-file-model",
        "RUNINFRA_IMAGE_SIZE=1024x1024",
        "RUNINFRA_IMAGE_RESPONSE_FORMAT=b64_json",
        "TEST_TTS_MODEL=tts-env-file-model",
        "TEST_TTS_VOICE=alloy",
        "RUNINFRA_TTS_RESPONSE_FORMAT=mp3",
        "TEST_ASR_MODEL=asr-env-file-model",
        `TEST_ASR_FILE=${__filename}`,
        "RUNINFRA_ASR_EXPECTED_TEXT=env-file transcript",
        "RUNINFRA_ASR_LANGUAGE=en",
        "RUNINFRA_ASR_RESPONSE_FORMAT=json",
        "TEST_PIPELINE_ID=pipeline-env-file",
        "RUNINFRA_CANARY_ENABLE_IDEMPOTENCY=1",
        "",
      ].join("\n"));

      const result = spawnSync(process.execPath, [
        "../scripts/run-sdk-live-canaries.mjs",
        "--runinfra-env-file",
        envPath,
        "--preflight",
        "--strict",
        "--package-source",
        "source",
        "--report",
        reportPath,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        env: {
          ...process.env,
          RUNINFRA_API_KEY: "",
          RUNINFRA_LLM_MODEL: "",
          RUNINFRA_EMBEDDING_MODEL: "",
          RUNINFRA_IMAGE_MODEL: "",
          RUNINFRA_TTS_MODEL: "shell-tts-model",
          RUNINFRA_ASR_MODEL: "",
          RUNINFRA_VOICE_PIPELINE_ID: "",
        },
      });

      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
        readiness?: {
          status?: string;
          env?: Record<string, string>;
          missing?: string[];
          rows?: Array<{ status: string }>;
          aliases?: Record<string, string[]>;
        };
      };
      expect(report.readiness?.status).toBe("ready");
      expect(report.readiness?.missing).toEqual([]);
      expect(report.readiness?.rows?.every((row) => row.status === "ready")).toBe(true);
      expect(report.readiness?.env?.RUNINFRA_API_KEY).toBe("set_redacted");
      expect(report.readiness?.env?.RUNINFRA_LLM_MODEL).toBe("set_redacted");
      expect(report.readiness?.aliases?.RUNINFRA_LLM_MODEL).toContain("TEST_MODEL");
      expect(report.readiness?.aliases?.RUNINFRA_TTS_MODEL).toBeUndefined();
      expect(JSON.stringify(report)).not.toContain(fakeKey);
      expect(JSON.stringify(report)).not.toContain("env-file transcript");
      expect(JSON.stringify(report)).not.toContain(__filename);
      expect(JSON.stringify(report)).not.toContain("shell-tts-model");
      expect(JSON.stringify(report)).not.toContain("tts-env-file-model");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("lets explicit shell aliases override canonical values from --runinfra-env-file", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-preflight-env-file-alias-"));
    const reportPath = join(tmp, "readiness.json");
    const envPath = join(tmp, "runinfra-live-inputs");
    const missingFixturePath = join(tmp, "missing-audio.wav");
    try {
      writeFileSync(envPath, [
        "RUNINFRA_API_KEY=env-file-api-key-placeholder",
        "RUNINFRA_LLM_MODEL=llm-env-file-model",
        "RUNINFRA_EMBEDDING_MODEL=embedding-env-file-model",
        "RUNINFRA_EMBEDDING_DIMENSIONS=384",
        "RUNINFRA_IMAGE_MODEL=image-env-file-model",
        "RUNINFRA_IMAGE_SIZE=1024x1024",
        "RUNINFRA_IMAGE_RESPONSE_FORMAT=b64_json",
        "RUNINFRA_TTS_MODEL=tts-env-file-model",
        "RUNINFRA_TTS_VOICE=alloy",
        "RUNINFRA_TTS_RESPONSE_FORMAT=mp3",
        "RUNINFRA_ASR_MODEL=asr-env-file-model",
        `RUNINFRA_ASR_FIXTURE_PATH=${missingFixturePath}`,
        "RUNINFRA_ASR_EXPECTED_TEXT=env-file transcript",
        "RUNINFRA_ASR_LANGUAGE=en",
        "RUNINFRA_ASR_RESPONSE_FORMAT=json",
        "RUNINFRA_VOICE_PIPELINE_ID=pipeline-env-file",
        "RUNINFRA_CANARY_ENABLE_IDEMPOTENCY=1",
        "",
      ].join("\n"));

      const result = spawnSync(process.execPath, [
        "../scripts/run-sdk-live-canaries.mjs",
        "--runinfra-env-file",
        envPath,
        "--preflight",
        "--strict",
        "--package-source",
        "source",
        "--report",
        reportPath,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        env: {
          ...process.env,
          RUNINFRA_ASR_FIXTURE_PATH: "",
          TEST_ASR_FILE: __filename,
        },
      });

      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
        readiness?: {
          status?: string;
          aliases?: Record<string, string[]>;
        };
      };
      expect(report.readiness?.status).toBe("ready");
      expect(report.readiness?.aliases?.RUNINFRA_ASR_FIXTURE_PATH).toContain("TEST_ASR_FILE");
      expect(JSON.stringify(report)).not.toContain(missingFixturePath);
      expect(JSON.stringify(report)).not.toContain(__filename);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("preserves explicit shell aliases when Node consumes --env-file with inline comments", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-preflight-node-env-file-"));
    const reportPath = join(tmp, "readiness.json");
    const envPath = join(tmp, "runinfra-live-inputs");
    const missingFixturePath = join(tmp, "missing-audio.wav");
    try {
      writeFileSync(envPath, [
        "RUNINFRA_API_KEY=env-file-api-key-placeholder",
        "RUNINFRA_LLM_MODEL=llm-env-file-model",
        "RUNINFRA_EMBEDDING_MODEL=embedding-env-file-model",
        "RUNINFRA_EMBEDDING_DIMENSIONS=384",
        "RUNINFRA_IMAGE_MODEL=image-env-file-model",
        "RUNINFRA_IMAGE_SIZE=1024x1024",
        "RUNINFRA_IMAGE_RESPONSE_FORMAT=b64_json",
        "RUNINFRA_TTS_MODEL=tts-env-file-model",
        "RUNINFRA_TTS_VOICE=alloy",
        "RUNINFRA_TTS_RESPONSE_FORMAT=mp3",
        "RUNINFRA_ASR_MODEL=asr-env-file-model",
        `RUNINFRA_ASR_FIXTURE_PATH=${missingFixturePath} # ignored by Node env-file parsing`,
        "RUNINFRA_ASR_EXPECTED_TEXT=env-file transcript",
        "RUNINFRA_ASR_LANGUAGE=en",
        "RUNINFRA_ASR_RESPONSE_FORMAT=json",
        "RUNINFRA_VOICE_PIPELINE_ID=pipeline-env-file",
        "RUNINFRA_CANARY_ENABLE_IDEMPOTENCY=1",
        "",
      ].join("\n"));

      const result = spawnSync(process.execPath, [
        "--env-file",
        envPath,
        "../scripts/run-sdk-live-canaries.mjs",
        "--preflight",
        "--strict",
        "--package-source",
        "source",
        "--report",
        reportPath,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        env: {
          ...process.env,
          RUNINFRA_ASR_FIXTURE_PATH: "",
          TEST_ASR_FILE: __filename,
        },
      });

      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
        readiness?: {
          status?: string;
          aliases?: Record<string, string[]>;
        };
      };
      expect(report.readiness?.status).toBe("ready");
      expect(report.readiness?.aliases?.RUNINFRA_ASR_FIXTURE_PATH).toContain("TEST_ASR_FILE");
      expect(JSON.stringify(report)).not.toContain(missingFixturePath);
      expect(JSON.stringify(report)).not.toContain(__filename);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("redacts missing --runinfra-env-file paths from stderr", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-preflight-missing-env-file-"));
    const envPath = join(tmp, "private-canary-env");
    try {
      const result = spawnSync(process.execPath, [
        "../scripts/run-sdk-live-canaries.mjs",
        "--runinfra-env-file",
        envPath,
        "--preflight",
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("--runinfra-env-file does not exist");
      expect(result.stderr).not.toContain(envPath);
      expect(result.stderr).not.toContain("private-canary-env");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("writes a static strict live-canary env template without leaking current env values", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-env-template-"));
    const templatePath = join(tmp, "sdk-live.env");
    try {
      const result = spawnSync(process.execPath, [
        "../scripts/run-sdk-live-canaries.mjs",
        "--write-env-template",
        templatePath,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        env: {
          ...process.env,
          RUNINFRA_API_KEY: "template-secret-api-key",
          RUNINFRA_LLM_MODEL: "template-secret-llm-model",
          RUNINFRA_ASR_EXPECTED_TEXT: "template-secret-transcript",
          NPM_TOKEN: "template-secret-npm-token",
        },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Wrote strict live-canary env template.");
      const template = readFileSync(templatePath, "utf8");
      expect(template).toContain("RUNINFRA_API_KEY=");
      expect(template).toContain("RUNINFRA_LLM_MODEL=");
      expect(template).toContain("RUNINFRA_EMBEDDING_DIMENSIONS=");
      expect(template).toContain("RUNINFRA_IMAGE_RESPONSE_FORMAT=b64_json");
      expect(template).toContain("RUNINFRA_TTS_RESPONSE_FORMAT=mp3");
      expect(template).toContain("RUNINFRA_ASR_RESPONSE_FORMAT=json");
      expect(template).toContain("RUNINFRA_CANARY_ENABLE_IDEMPOTENCY=1");
      expect(template).toContain("# RUNINFRA_ASR_FIXTURE_BASE64=");
      expect(template).toContain("# RUNINFRA_VOICE_PIPELINE_AUDIO_BASE64=");
      expect(template).toContain("RUNINFRA_VOICE_PIPELINE_ID=");
      expect(template).toContain("RUNINFRA_VOICE_PIPELINE_API_KEY=");
      expect(template).toContain("TEST_PIPELINE_ID=");
      expect(template).not.toContain("template-secret-api-key");
      expect(template).not.toContain("template-secret-llm-model");
      expect(template).not.toContain("template-secret-transcript");
      expect(template).not.toContain("template-secret-npm-token");
      expect(result.stderr).not.toContain(templatePath);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite a strict live-canary env template unless forced", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-env-template-overwrite-"));
    const templatePath = join(tmp, "sdk-live.env");
    try {
      writeFileSync(templatePath, "do-not-overwrite\n");

      const refused = spawnSync(process.execPath, [
        "../scripts/run-sdk-live-canaries.mjs",
        "--write-env-template",
        templatePath,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });

      expect(refused.status).toBe(2);
      expect(refused.stderr).toContain("strict live-canary env template already exists");
      expect(refused.stderr).not.toContain(templatePath);
      expect(readFileSync(templatePath, "utf8")).toBe("do-not-overwrite\n");

      const forced = spawnSync(process.execPath, [
        "../scripts/run-sdk-live-canaries.mjs",
        "--write-env-template",
        templatePath,
        "--force-env-template",
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });

      expect(forced.status, forced.stderr).toBe(0);
      expect(readFileSync(templatePath, "utf8")).toContain("RUNINFRA_CANARY_ENABLE_IDEMPOTENCY=1");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("writes a redacted missing-env patch from a blocked readiness report", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-missing-env-template-"));
    const readinessPath = join(tmp, "readiness.json");
    const templatePath = join(tmp, "missing.env");
    try {
      writeFileSync(readinessPath, `${JSON.stringify(await canonicalReadinessFixture(
        [
          "RUNINFRA_EMBEDDING_MODEL",
          "RUNINFRA_IMAGE_RESPONSE_FORMAT url or b64_json",
          "RUNINFRA_TTS_VOICE or RUNINFRA_TTS_REF_AUDIO plus RUNINFRA_TTS_REF_TEXT",
          "RUNINFRA_CANARY_ENABLE_IDEMPOTENCY=1",
        ],
        {
          "models.retrieve.embedding": ["RUNINFRA_EMBEDDING_MODEL"],
          "openai.params.images": ["RUNINFRA_IMAGE_RESPONSE_FORMAT url or b64_json"],
          "openai.params.audio.speech": [
            "RUNINFRA_TTS_VOICE or RUNINFRA_TTS_REF_AUDIO plus RUNINFRA_TTS_REF_TEXT",
          ],
          "idempotency.replay.responses": ["RUNINFRA_CANARY_ENABLE_IDEMPOTENCY=1"],
        },
      ), null, 2)}\n`);

      const result = spawnSync(process.execPath, [
        "../scripts/run-sdk-live-canaries.mjs",
        "--readiness-report",
        readinessPath,
        "--write-missing-env-template",
        templatePath,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        env: {
          ...process.env,
          RUNINFRA_API_KEY: "missing-patch-secret-api-key",
          RUNINFRA_LLM_MODEL: "missing-patch-secret-model",
          NPM_TOKEN: "missing-patch-secret-npm-token",
        },
      });

      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toContain("Wrote missing strict live-canary env patch.");
      const template = readFileSync(templatePath, "utf8");
      expect(template).toContain("RUNINFRA_EMBEDDING_MODEL=");
      expect(template).toContain("RUNINFRA_IMAGE_RESPONSE_FORMAT=b64_json");
      expect(template).toContain("RUNINFRA_TTS_VOICE=");
      expect(template).toContain("RUNINFRA_TTS_REF_AUDIO=");
      expect(template).toContain("RUNINFRA_TTS_REF_TEXT=");
      expect(template).toContain("RUNINFRA_CANARY_ENABLE_IDEMPOTENCY=1");
      expect(template).not.toContain("RUNINFRA_API_KEY=");
      expect(template).not.toContain("RUNINFRA_LLM_MODEL=");
      expect(template).not.toContain("missing-patch-secret-api-key");
      expect(template).not.toContain("missing-patch-secret-model");
      expect(template).not.toContain("missing-patch-secret-npm-token");
      expect(template).not.toContain(readinessPath);
      expect(result.stderr).not.toContain(readinessPath);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("refuses to overwrite a missing-env patch unless forced", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-missing-env-template-overwrite-"));
    const readinessPath = join(tmp, "readiness.json");
    const templatePath = join(tmp, "missing.env");
    try {
      writeFileSync(readinessPath, `${JSON.stringify(await canonicalReadinessFixture(
        ["RUNINFRA_IMAGE_MODEL"],
        { "models.retrieve.image": ["RUNINFRA_IMAGE_MODEL"] },
      ), null, 2)}\n`);
      writeFileSync(templatePath, "do-not-overwrite\n");

      const refused = spawnSync(process.execPath, [
        "../scripts/run-sdk-live-canaries.mjs",
        "--readiness-report",
        readinessPath,
        "--write-missing-env-template",
        templatePath,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });

      expect(refused.status).toBe(2);
      expect(refused.stderr).toContain("missing strict live-canary env patch already exists");
      expect(refused.stderr).not.toContain(templatePath);
      expect(readFileSync(templatePath, "utf8")).toBe("do-not-overwrite\n");

      const forced = spawnSync(process.execPath, [
        "../scripts/run-sdk-live-canaries.mjs",
        "--readiness-report",
        readinessPath,
        "--write-missing-env-template",
        templatePath,
        "--force-env-template",
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });

      expect(forced.status, forced.stderr).toBe(0);
      expect(readFileSync(templatePath, "utf8")).toContain("RUNINFRA_IMAGE_MODEL=");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects missing-env patch reports that contain sensitive env values", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-missing-env-template-leak-"));
    const readinessPath = join(tmp, "readiness.json");
    const templatePath = join(tmp, "missing.env");
    const leakedToken = "missing-patch-sensitive-token";
    try {
      writeFileSync(readinessPath, `${JSON.stringify(await canonicalReadinessFixture(
        ["RUNINFRA_IMAGE_MODEL"],
        { "models.retrieve.image": ["RUNINFRA_IMAGE_MODEL"] },
        { candidate: { leakedToken } },
      ), null, 2)}\n`);

      const result = spawnSync(process.execPath, [
        "../scripts/run-sdk-live-canaries.mjs",
        "--readiness-report",
        readinessPath,
        "--write-missing-env-template",
        templatePath,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        env: {
          ...process.env,
          NPM_TOKEN: leakedToken,
        },
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("live canary report contains a sensitive environment value");
      expect(result.stderr).not.toContain(leakedToken);
      expect(result.stderr).not.toContain(readinessPath);
      expect(existsSync(templatePath)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects missing-env patch reports without canonical readiness rows", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-missing-env-template-shape-"));
    const readinessPath = join(tmp, "readiness.json");
    const templatePath = join(tmp, "missing.env");
    try {
      const report = await canonicalReadinessFixture(
        ["RUNINFRA_IMAGE_MODEL"],
        { "models.retrieve.image": ["RUNINFRA_IMAGE_MODEL"] },
      );
      delete report.expectedRows;
      writeFileSync(readinessPath, `${JSON.stringify(report, null, 2)}\n`);

      const result = spawnSync(process.execPath, [
        "../scripts/run-sdk-live-canaries.mjs",
        "--readiness-report",
        readinessPath,
        "--write-missing-env-template",
        templatePath,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("readiness report expected rows must match the canonical strict matrix");
      expect(result.stderr).not.toContain(readinessPath);
      expect(existsSync(templatePath)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects missing-env patch reports without the strict preflight envelope", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-missing-env-template-envelope-"));
    const readinessPath = join(tmp, "readiness.json");
    const templatePath = join(tmp, "missing.env");
    try {
      const report = await canonicalReadinessFixture(
        ["RUNINFRA_IMAGE_MODEL"],
        { "models.retrieve.image": ["RUNINFRA_IMAGE_MODEL"] },
      );
      delete report.generatedAt;
      delete report.strict;
      delete report.packageSource;
      delete report.candidate;
      delete report.surfaceCoverage;
      delete report.parity;
      delete report.reports;
      writeFileSync(readinessPath, `${JSON.stringify(report, null, 2)}\n`);

      const result = spawnSync(process.execPath, [
        "../scripts/run-sdk-live-canaries.mjs",
        "--readiness-report",
        readinessPath,
        "--write-missing-env-template",
        templatePath,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("readiness report must be a strict preflight report");
      expect(result.stderr).not.toContain(readinessPath);
      expect(existsSync(templatePath)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects missing-env patch reports whose readiness row names drift from expected rows", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-missing-env-template-row-drift-"));
    const readinessPath = join(tmp, "readiness.json");
    const templatePath = join(tmp, "missing.env");
    try {
      const report = await canonicalReadinessFixture(
        ["RUNINFRA_IMAGE_MODEL"],
        { "models.retrieve.image": ["RUNINFRA_IMAGE_MODEL"] },
      );
      const readiness = report.readiness as { rows: Array<{ name: string }> };
      readiness.rows[0].name = "noncanonical.row";
      writeFileSync(readinessPath, `${JSON.stringify(report, null, 2)}\n`);

      const result = spawnSync(process.execPath, [
        "../scripts/run-sdk-live-canaries.mjs",
        "--readiness-report",
        readinessPath,
        "--write-missing-env-template",
        templatePath,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("readiness report row names must match expected rows");
      expect(result.stderr).not.toContain(readinessPath);
      expect(existsSync(templatePath)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects missing-env patch reports whose readiness summary disagrees with missing rows", async () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-missing-env-template-missing-drift-"));
    const readinessPath = join(tmp, "readiness.json");
    const templatePath = join(tmp, "missing.env");
    try {
      const report = await canonicalReadinessFixture(
        ["RUNINFRA_IMAGE_MODEL"],
        { "models.retrieve.image": ["RUNINFRA_IMAGE_MODEL"] },
      );
      const readiness = report.readiness as {
        status: string;
        summary: { ready: number; blocked: number };
        rows: Array<{ status: string; missing: string[] }>;
      };
      readiness.status = "ready";
      readiness.summary = { ready: readiness.rows.length, blocked: 0 };
      readiness.rows = readiness.rows.map((row) => ({ ...row, status: "ready", missing: [] }));
      writeFileSync(readinessPath, `${JSON.stringify(report, null, 2)}\n`);

      const result = spawnSync(process.execPath, [
        "../scripts/run-sdk-live-canaries.mjs",
        "--readiness-report",
        readinessPath,
        "--write-missing-env-template",
        templatePath,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
      });

      expect(result.status).toBe(2);
      expect(result.stderr).toContain("readiness report missing inputs must match readiness rows");
      expect(result.stderr).not.toContain(readinessPath);
      expect(existsSync(templatePath)).toBe(false);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects missing-env patch reports with a stale candidate source digest", async () => {
    await expectMissingEnvPatchRejectsCandidateSourceIdentityMutation("stale-source-digest", (candidate) => {
      candidate.sourceDigestSha256 = "f".repeat(64);
    });
  });

  it("rejects missing-env patch reports with a stale candidate source file count", async () => {
    await expectMissingEnvPatchRejectsCandidateSourceIdentityMutation("stale-source-count", (candidate) => {
      candidate.sourceFileCount += 1;
    });
  });

  it("does not report stale TEST aliases when canonical live-canary env wins", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-preflight-canonical-"));
    const reportPath = join(tmp, "readiness.json");
    try {
      const result = spawnSync(process.execPath, [
        "../scripts/run-sdk-live-canaries.mjs",
        "--preflight",
        "--package-source",
        "source",
        "--report",
        reportPath,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        env: {
          ...process.env,
          RUNINFRA_LLM_MODEL: "canonical-model",
          TEST_MODEL: "stale-alias-model",
          RUNINFRA_VOICE_PIPELINE_ID: "canonical-pipeline",
          TEST_PIPELINE_ID: "stale-pipeline-alias",
        },
      });

      expect(result.status, result.stderr).toBe(0);
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
        readiness?: {
          env?: Record<string, string>;
          aliases?: Record<string, string[]>;
        };
      };
      expect(report.readiness?.env?.RUNINFRA_LLM_MODEL).toBe("set_redacted");
      expect(report.readiness?.env?.RUNINFRA_VOICE_PIPELINE_ID).toBe("set_redacted");
      expect(report.readiness?.env?.TEST_PIPELINE_ID).toBeUndefined();
      expect(report.readiness?.aliases?.RUNINFRA_LLM_MODEL).toBeUndefined();
      expect(report.readiness?.aliases?.RUNINFRA_VOICE_PIPELINE_ID).toBeUndefined();
      expect(JSON.stringify(report)).not.toContain("canonical-model");
      expect(JSON.stringify(report)).not.toContain("stale-alias-model");
      expect(JSON.stringify(report)).not.toContain("canonical-pipeline");
      expect(JSON.stringify(report)).not.toContain("stale-pipeline-alias");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("blocks strict live-canary preflight on invalid positive-integer readiness inputs", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-preflight-"));
    const reportPath = join(tmp, "readiness.json");
    try {
      const result = spawnSync(process.execPath, [
        "../scripts/run-sdk-live-canaries.mjs",
        "--preflight",
        "--strict",
        "--package-source",
        "source",
        "--report",
        reportPath,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        env: {
          ...process.env,
          RUNINFRA_API_KEY: "preflight-api-key-placeholder",
          RUNINFRA_LLM_MODEL: "llm-preflight-model",
          RUNINFRA_EMBEDDING_MODEL: "embedding-preflight-model",
          RUNINFRA_EMBEDDING_DIMENSIONS: "not-a-positive-integer",
          RUNINFRA_IMAGE_MODEL: "image-preflight-model",
          RUNINFRA_TTS_MODEL: "tts-preflight-model",
          RUNINFRA_TTS_VOICE: "voice-preflight",
          RUNINFRA_ASR_MODEL: "asr-preflight-model",
          RUNINFRA_ASR_FIXTURE_PATH: __filename,
          RUNINFRA_ASR_EXPECTED_TEXT: "hello",
          TEST_PIPELINE_ID: "pipeline-preflight",
          RUNINFRA_CANARY_ENABLE_IDEMPOTENCY: "1",
        },
      });

      expect(result.status).toBe(1);
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
        readiness?: {
          missing?: string[];
          rows?: Array<{ name: string; status: string; missing?: string[] }>;
        };
      };
      expect(report.readiness?.missing).toContain("RUNINFRA_EMBEDDING_DIMENSIONS positive integer");
      expect(
        report.readiness?.rows?.find((row) => row.name === "openai.params.embeddings")?.missing,
      ).toContain("RUNINFRA_EMBEDDING_DIMENSIONS positive integer");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("blocks strict live-canary preflight on invalid timeout readiness inputs", () => {
    for (const timeout of ["not-a-positive-number", "1".repeat(400)]) {
      const tmp = mkdtempSync(join(tmpdir(), "runinfra-preflight-"));
      const reportPath = join(tmp, "readiness.json");
      try {
        const result = spawnSync(process.execPath, [
          "../scripts/run-sdk-live-canaries.mjs",
          "--preflight",
          "--strict",
          "--package-source",
          "source",
          "--report",
          reportPath,
        ], {
          cwd: new URL("..", import.meta.url),
          encoding: "utf8",
          env: {
            ...process.env,
            RUNINFRA_API_KEY: "preflight-api-key-placeholder",
            RUNINFRA_CANARY_TIMEOUT_SECONDS: timeout,
            RUNINFRA_LLM_MODEL: "llm-preflight-model",
            RUNINFRA_EMBEDDING_MODEL: "embedding-preflight-model",
            RUNINFRA_EMBEDDING_DIMENSIONS: "128",
            RUNINFRA_IMAGE_MODEL: "image-preflight-model",
            RUNINFRA_TTS_MODEL: "tts-preflight-model",
            RUNINFRA_TTS_VOICE: "voice-preflight",
            RUNINFRA_ASR_MODEL: "asr-preflight-model",
            RUNINFRA_ASR_FIXTURE_PATH: __filename,
            RUNINFRA_ASR_EXPECTED_TEXT: "hello",
            TEST_PIPELINE_ID: "pipeline-preflight",
            RUNINFRA_CANARY_ENABLE_IDEMPOTENCY: "1",
          },
        });

        expect(result.status).toBe(1);
        const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
          readiness?: {
            missing?: string[];
          };
        };
        expect(report.readiness?.missing).toContain("RUNINFRA_CANARY_TIMEOUT_SECONDS positive finite number <= 600");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
  });

  it("blocks strict live-canary preflight on excessive timeout readiness inputs", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-preflight-timeout-bound-"));
    const reportPath = join(tmp, "readiness.json");
    try {
      const result = spawnSync(process.execPath, [
        "../scripts/run-sdk-live-canaries.mjs",
        "--preflight",
        "--strict",
        "--package-source",
        "source",
        "--report",
        reportPath,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        env: {
          ...process.env,
          RUNINFRA_API_KEY: "preflight-api-key-placeholder",
          RUNINFRA_CANARY_TIMEOUT_SECONDS: "601",
          RUNINFRA_LLM_MODEL: "llm-preflight-model",
          RUNINFRA_EMBEDDING_MODEL: "embedding-preflight-model",
          RUNINFRA_EMBEDDING_DIMENSIONS: "128",
          RUNINFRA_IMAGE_MODEL: "image-preflight-model",
          RUNINFRA_IMAGE_SIZE: "1024x1024",
          RUNINFRA_IMAGE_RESPONSE_FORMAT: "b64_json",
          RUNINFRA_TTS_MODEL: "tts-preflight-model",
          RUNINFRA_TTS_VOICE: "voice-preflight",
          RUNINFRA_TTS_RESPONSE_FORMAT: "mp3",
          RUNINFRA_ASR_MODEL: "asr-preflight-model",
          RUNINFRA_ASR_LANGUAGE: "en",
          RUNINFRA_ASR_RESPONSE_FORMAT: "json",
          RUNINFRA_ASR_FIXTURE_PATH: __filename,
          RUNINFRA_ASR_EXPECTED_TEXT: "hello",
          TEST_PIPELINE_ID: "pipeline-preflight",
          RUNINFRA_CANARY_ENABLE_IDEMPOTENCY: "1",
        },
      });

      expect(result.status).toBe(1);
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
        readiness?: {
          missing?: string[];
          rows?: Array<{ name: string; missing?: string[] }>;
        };
      };
      expect(report.readiness?.missing).toEqual(["RUNINFRA_CANARY_TIMEOUT_SECONDS positive finite number <= 600"]);
      expect(
        report.readiness?.rows?.find((row) => row.name === "models.list")?.missing,
      ).toEqual(["RUNINFRA_CANARY_TIMEOUT_SECONDS positive finite number <= 600"]);
      expect(JSON.stringify(report)).not.toContain("601");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("blocks slow-consumer stream rows on invalid optional delay input", () => {
    for (const delay of ["not-a-delay", "6000"]) {
      const tmp = mkdtempSync(join(tmpdir(), "runinfra-preflight-"));
      const reportPath = join(tmp, "readiness.json");
      try {
        const result = spawnSync(process.execPath, [
          "../scripts/run-sdk-live-canaries.mjs",
          "--preflight",
          "--strict",
          "--package-source",
          "source",
          "--report",
          reportPath,
        ], {
          cwd: new URL("..", import.meta.url),
          encoding: "utf8",
          env: {
            ...process.env,
            RUNINFRA_API_KEY: "preflight-api-key-placeholder",
            RUNINFRA_LLM_MODEL: "llm-preflight-model",
            RUNINFRA_CANARY_STREAM_SLOW_CONSUMER_DELAY_MS: delay,
            RUNINFRA_CANARY_ENABLE_IDEMPOTENCY: "",
          },
        });

        expect(result.status).toBe(1);
        const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
          readiness?: {
            env?: Record<string, string>;
            rows?: Array<{ name: string; status: string; missing?: string[] }>;
          };
        };

        expect(report.readiness?.env?.RUNINFRA_CANARY_STREAM_SLOW_CONSUMER_DELAY_MS).toBe("set_redacted");
        expect(
          report.readiness?.rows?.find((row) => row.name === "chat.completions.stream.slow_consumer")?.missing,
        ).toContain("RUNINFRA_CANARY_STREAM_SLOW_CONSUMER_DELAY_MS non-negative integer <= 5000");
        expect(
          report.readiness?.rows?.find((row) => row.name === "responses.stream.slow_consumer")?.missing,
        ).toContain("RUNINFRA_CANARY_STREAM_SLOW_CONSUMER_DELAY_MS non-negative integer <= 5000");
        expect(
          report.readiness?.rows?.find((row) => row.name === "chat.completions.stream.final")?.missing,
        ).toEqual([]);
        expect(JSON.stringify(report)).not.toContain(delay);
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
    }
  });

  it("blocks strict preflight on unsafe custom base URLs without leaking values", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-preflight-base-url-"));
    const reportPath = join(tmp, "readiness.json");
    const unsafeBaseURL = "http://runinfra.ai/v1?probe=blocked";
    const baseUrlError = "RUNINFRA_BASE_URL safe http(s) URL without credentials, query strings, or fragments";
    try {
      const result = spawnSync(process.execPath, [
        "../scripts/run-sdk-live-canaries.mjs",
        "--preflight",
        "--strict",
        "--package-source",
        "source",
        "--report",
        reportPath,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        env: {
          ...process.env,
          RUNINFRA_API_KEY: "preflight-api-key-placeholder",
          RUNINFRA_BASE_URL: unsafeBaseURL,
          RUNINFRA_LLM_MODEL: "llm-preflight-model",
          RUNINFRA_EMBEDDING_MODEL: "embedding-preflight-model",
          RUNINFRA_EMBEDDING_DIMENSIONS: "128",
          RUNINFRA_IMAGE_MODEL: "image-preflight-model",
          RUNINFRA_IMAGE_SIZE: "1024x1024",
          RUNINFRA_IMAGE_RESPONSE_FORMAT: "b64_json",
          RUNINFRA_TTS_MODEL: "tts-preflight-model",
          RUNINFRA_TTS_VOICE: "voice-preflight",
          RUNINFRA_TTS_RESPONSE_FORMAT: "mp3",
          RUNINFRA_ASR_MODEL: "asr-preflight-model",
          RUNINFRA_ASR_LANGUAGE: "en",
          RUNINFRA_ASR_RESPONSE_FORMAT: "json",
          RUNINFRA_ASR_FIXTURE_PATH: __filename,
          RUNINFRA_ASR_EXPECTED_TEXT: "hello",
          TEST_PIPELINE_ID: "pipeline-preflight",
          RUNINFRA_CANARY_ENABLE_IDEMPOTENCY: "1",
        },
      });

      expect(result.status).toBe(1);
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
        readiness?: {
          env?: Record<string, string>;
          missing?: string[];
          rows?: Array<{ name: string; missing?: string[] }>;
        };
      };
      expect(report.readiness?.env?.RUNINFRA_BASE_URL).toBe("set_redacted");
      expect(report.readiness?.missing).toContain(baseUrlError);
      expect(
        report.readiness?.rows?.find((row) => row.name === "models.list")?.missing,
      ).toContain(baseUrlError);
      expect(JSON.stringify(report)).not.toContain(unsafeBaseURL);
      expect(`${result.stdout}${result.stderr}`).not.toContain(unsafeBaseURL);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("blocks idempotency replay evidence field paths that could leak report data", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-preflight-idempotency-field-"));
    const reportPath = join(tmp, "readiness.json");
    const unsafeField = "/Users/example/.env.local";
    try {
      const result = spawnSync(process.execPath, [
        "../scripts/run-sdk-live-canaries.mjs",
        "--preflight",
        "--strict",
        "--package-source",
        "source",
        "--report",
        reportPath,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        env: {
          ...process.env,
          RUNINFRA_API_KEY: "preflight-api-key-placeholder",
          RUNINFRA_LLM_MODEL: "llm-preflight-model",
          RUNINFRA_CANARY_ENABLE_IDEMPOTENCY: "1",
          RUNINFRA_CANARY_IDEMPOTENCY_EVIDENCE_FIELD: unsafeField,
        },
      });

      expect(result.status).toBe(1);
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
        readiness?: {
          env?: Record<string, string>;
          rows?: Array<{ name: string; status: string; missing?: string[] }>;
        };
      };
      expect(report.readiness?.env?.RUNINFRA_CANARY_IDEMPOTENCY_EVIDENCE_FIELD).toBe("set_redacted");
      expect(
        report.readiness?.rows?.find((row) => row.name === "idempotency.replay.responses")?.missing,
      ).toContain("RUNINFRA_CANARY_IDEMPOTENCY_EVIDENCE_FIELD dot-separated response field paths");
      expect(JSON.stringify(report)).not.toContain(unsafeField);
      expect(result.stderr).not.toContain(unsafeField);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("blocks full live-canary runs on unsafe custom base URLs before child canaries spawn", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-canary-base-url-"));
    const reportPath = join(tmp, "live-canary.json");
    const unsafeBaseURL = "http://runinfra.ai/v1?probe=blocked";
    const baseUrlError = "RUNINFRA_BASE_URL safe http(s) URL without credentials, query strings, or fragments";
    try {
      const result = spawnSync(process.execPath, [
        "../scripts/run-sdk-live-canaries.mjs",
        "--package-source",
        "source",
        "--report",
        reportPath,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        env: {
          ...process.env,
          RUNINFRA_BASE_URL: unsafeBaseURL,
        },
      });

      expect(result.status).toBe(1);
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
        parity?: { status?: string; errors?: string[] };
        reports?: unknown[];
      };
      expect(report.parity?.status).toBe("failed");
      expect(report.parity?.errors).toContain(baseUrlError);
      expect(report.reports).toEqual([]);
      expect(JSON.stringify(report)).not.toContain(unsafeBaseURL);
      expect(`${result.stdout}${result.stderr}`).not.toContain(unsafeBaseURL);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("blocks full live-canary runs on excessive timeout inputs before child canaries spawn", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-canary-timeout-bound-"));
    const reportPath = join(tmp, "live-canary.json");
    const timeoutError = "RUNINFRA_CANARY_TIMEOUT_SECONDS positive finite number <= 600";
    try {
      const result = spawnSync(process.execPath, [
        "../scripts/run-sdk-live-canaries.mjs",
        "--package-source",
        "source",
        "--report",
        reportPath,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        env: {
          ...process.env,
          RUNINFRA_CANARY_TIMEOUT_SECONDS: "601",
        },
      });

      expect(result.status).toBe(1);
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
        parity?: { status?: string; errors?: string[] };
        reports?: unknown[];
      };
      expect(report.parity?.status).toBe("failed");
      expect(report.parity?.errors).toContain(timeoutError);
      expect(report.reports).toEqual([]);
      expect(JSON.stringify(report)).not.toContain("601");
      expect(`${result.stdout}${result.stderr}`).not.toContain("601");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("fails model discovery closed without an API key and does not run child canaries", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-model-discovery-"));
    const reportPath = join(tmp, "models.json");
    try {
      const result = spawnSync(process.execPath, [
        "../scripts/run-sdk-live-canaries.mjs",
        "--discover-models",
        "--package-source",
        "source",
        "--report",
        reportPath,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        env: {
          ...process.env,
          RUNINFRA_API_KEY: "",
          RUNINFRA_BASE_URL: "http://localhost:1/v1",
        },
      });

      expect(result.status).toBe(1);
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
        discovery?: {
          status?: string;
          env?: Record<string, string>;
          missing?: string[];
          candidatesByEnv?: Record<string, { candidateIds?: string[] }>;
        };
        reports?: unknown[];
      };
      expect(report.discovery?.status).toBe("blocked");
      expect(report.discovery?.env?.RUNINFRA_API_KEY).toBe("missing");
      expect(report.discovery?.env?.RUNINFRA_BASE_URL).toBe("set_redacted");
      expect(report.discovery?.missing).toEqual(["RUNINFRA_API_KEY"]);
      expect(report.discovery?.candidatesByEnv?.RUNINFRA_LLM_MODEL?.candidateIds).toEqual([]);
      expect(report.reports).toEqual([]);
      expect(existsSync(join(tmp, ".canary-tmp"))).toBe(false);
      expect(`${result.stdout}${result.stderr}`).not.toContain("http://localhost:1/v1");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("bounds stalled model discovery requests with the canary timeout", async () => {
    const { createServer } = await import("node:http");
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-model-discovery-timeout-"));
    const reportPath = join(tmp, "models.json");
    const server = createServer(() => undefined);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server did not bind to a port");
      const result = spawnSync(process.execPath, [
        "../scripts/run-sdk-live-canaries.mjs",
        "--discover-models",
        "--package-source",
        "source",
        "--report",
        reportPath,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        timeout: 5000,
        env: {
          ...process.env,
          RUNINFRA_API_KEY: "model-discovery-api-key-placeholder",
          RUNINFRA_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
          RUNINFRA_CANARY_TIMEOUT_SECONDS: "0.05",
        },
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
        discovery?: { status?: string; error?: string };
        reports?: unknown[];
      };
      expect(report.discovery?.status).toBe("failed");
      expect(report.discovery?.error).toBe("models.list timed out");
      expect(report.reports).toEqual([]);
      expect(JSON.stringify(report)).not.toContain("model-discovery-api-key-placeholder");
      expect(JSON.stringify(report)).not.toContain(`127.0.0.1:${address.port}`);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("bounds stalled model discovery JSON bodies with the canary timeout", async () => {
    const { createServer } = await import("node:http");
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-model-discovery-body-timeout-"));
    const reportPath = join(tmp, "models.json");
    const server = createServer((_request, response) => {
      response.writeHead(200, {
        "Content-Type": "application/json",
        "x-request-id": "req_stalled_body",
      });
      response.write('{"object":"list","data":');
    });
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => resolve());
    });
    try {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server did not bind to a port");
      const result = spawnSync(process.execPath, [
        "../scripts/run-sdk-live-canaries.mjs",
        "--discover-models",
        "--package-source",
        "source",
        "--report",
        reportPath,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        timeout: 5000,
        env: {
          ...process.env,
          RUNINFRA_API_KEY: "model-discovery-api-key-placeholder",
          RUNINFRA_BASE_URL: `http://127.0.0.1:${address.port}/v1`,
          RUNINFRA_CANARY_TIMEOUT_SECONDS: "0.05",
        },
      });

      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
        discovery?: { status?: string; error?: string };
        reports?: unknown[];
      };
      expect(report.discovery?.status).toBe("failed");
      expect(report.discovery?.error).toBe("models.list timed out");
      expect(report.reports).toEqual([]);
      expect(JSON.stringify(report)).not.toContain("model-discovery-api-key-placeholder");
      expect(JSON.stringify(report)).not.toContain(`127.0.0.1:${address.port}`);
      expect(JSON.stringify(report)).not.toContain("req_stalled_body");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("rejects conflicting live-canary runner modes before discovery can bypass preflight", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-model-discovery-mode-conflict-"));
    const reportPath = join(tmp, "models.json");
    try {
      const result = spawnSync(process.execPath, [
        "../scripts/run-sdk-live-canaries.mjs",
        "--discover-models",
        "--preflight",
        "--strict",
        "--package-source",
        "source",
        "--report",
        reportPath,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        env: {
          ...process.env,
          RUNINFRA_API_KEY: "model-discovery-api-key-placeholder",
          RUNINFRA_BASE_URL: "http://127.0.0.1:1/v1",
        },
      });

      expect(result.status).toBe(2);
      expect(existsSync(reportPath)).toBe(false);
      expect(result.stderr).toContain("--discover-models cannot be combined with --preflight or --verify-surface-coverage");
      expect(`${result.stdout}${result.stderr}`).not.toContain("model-discovery-api-key-placeholder");
      expect(`${result.stdout}${result.stderr}`).not.toContain("127.0.0.1");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("blocks full live-canary runs on invalid optional slow-consumer delay before child canaries spawn", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-canary-config-"));
    const reportPath = join(tmp, "live-canary.json");
    try {
      const result = spawnSync(process.execPath, [
        "../scripts/run-sdk-live-canaries.mjs",
        "--package-source",
        "source",
        "--report",
        reportPath,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        env: {
          ...process.env,
          RUNINFRA_BASE_URL: "http://localhost:1/v1",
          RUNINFRA_CANARY_STREAM_SLOW_CONSUMER_DELAY_MS: "6000",
          RUNINFRA_CANARY_ENABLE_IDEMPOTENCY: "",
        },
      });

      expect(result.status).toBe(1);
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
        parity?: { status?: string; errors?: string[] };
        reports?: unknown[];
      };
      expect(report.parity?.status).toBe("failed");
      expect(report.parity?.errors).toContain(
        "RUNINFRA_CANARY_STREAM_SLOW_CONSUMER_DELAY_MS non-negative integer <= 5000",
      );
      expect(report.reports).toEqual([]);
      expect(JSON.stringify(report)).not.toContain("6000");
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("blocks full live-canary runs on invalid idempotency evidence fields before child canaries spawn", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-canary-idempotency-field-"));
    const reportPath = join(tmp, "live-canary.json");
    const unsafeField = "sk-ri-" + "A".repeat(24);
    try {
      const result = spawnSync(process.execPath, [
        "../scripts/run-sdk-live-canaries.mjs",
        "--package-source",
        "source",
        "--report",
        reportPath,
      ], {
        cwd: new URL("..", import.meta.url),
        encoding: "utf8",
        env: {
          ...process.env,
          RUNINFRA_BASE_URL: "http://localhost:1/v1",
          RUNINFRA_CANARY_IDEMPOTENCY_EVIDENCE_FIELD: unsafeField,
        },
      });

      expect(result.status).toBe(1);
      const report = JSON.parse(readFileSync(reportPath, "utf8")) as {
        parity?: { status?: string; errors?: string[] };
        reports?: unknown[];
      };
      expect(report.parity?.status).toBe("failed");
      expect(report.parity?.errors).toContain(
        "RUNINFRA_CANARY_IDEMPOTENCY_EVIDENCE_FIELD dot-separated response field paths",
      );
      expect(report.reports).toEqual([]);
      expect(JSON.stringify(report)).not.toContain(unsafeField);
      expect(result.stderr).not.toContain(unsafeField);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("bounds TypeScript audio stream canary reads", () => {
    const script = readFileSync(new URL("../../scripts/sdk-live-canary-typescript.mjs", import.meta.url), "utf8");

    expect(script).toContain("function readStreamChunkWithTimeout");
    expect(script).toContain("function remainingStreamMs");
    expect(script).toContain("const deadlineMs = performance.now() + canaryTimeoutMs()");
    expect(script).toContain("remainingStreamMs(deadlineMs, label)");
    expect(script).toContain("function cancelReaderWithTimeout");
    expect(script).toContain("Promise.race([read, timeout])");
    expect(script).toContain("Promise.race([");
    expect(script).toContain("setTimeout(resolve, 1000)");
    expect(script).toContain("clearTimeout(timeoutId)");
    expect(script).toContain("await cancelReaderWithTimeout(reader)");
    expect(script).not.toContain("const { done, value } = await reader.read()");
    expect(script).not.toContain("await reader.cancel().catch(() => undefined)");
  });

  it("calls pipeline-scoped OpenAI-compatible chat completions", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({ choices: [{ message: { content: "hi" } }] }),
    );
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      pipelineId: "pipe-123",
      baseURL: "https://api.runinfra.ai/v1",
      fetch: fetcher,
    });

    await client.chat.completions.create({
      model: "llama-3.1-8b",
      messages: [{ role: "user", content: "Hi" }],
    });

    expect(fetcher).toHaveBeenCalledWith(
      "https://api.runinfra.ai/v1/pipe-123/chat/completions",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          Authorization: "Bearer sk-ri-test",
          "Content-Type": "application/json",
          "X-RunInfra-SDK": "typescript",
          "X-RunInfra-SDK-Version": RUNINFRA_SDK_VERSION,
        }),
        body: expect.stringContaining('"model":"llama-3.1-8b"'),
      }),
    );
  });

  it("rejects missing API keys before any request is sent", () => {
    expect(() => new RunInfra({ apiKey: "" })).toThrow(/apiKey is required/);
    expect(() => new RunInfra({ apiKey: "   " })).toThrow(/apiKey is required/);
  });

  it("rejects missing constructor options before any request is sent", () => {
    expect(() => new RunInfra(undefined as unknown as RunInfraOptions)).toThrow(
      /RunInfra options are required/,
    );
    expect(() => new RunInfra(null as unknown as RunInfraOptions)).toThrow(
      /RunInfra options are required/,
    );
  });

  it("rejects non-string API keys before any request is sent", () => {
    expect(() => new RunInfra({ apiKey: undefined as unknown as string })).toThrow(
      /apiKey must be a string/,
    );
    expect(() => new RunInfra({ apiKey: 123 as unknown as string })).toThrow(
      /apiKey must be a string/,
    );
  });

  it("rejects non-boolean browser overrides before any request is sent", () => {
    for (const dangerouslyAllowBrowser of ["true", "false", "0", 1, {}]) {
      expect(() => new RunInfra({
        apiKey: "sk-ri-test",
        dangerouslyAllowBrowser: dangerouslyAllowBrowser as unknown as boolean,
      })).toThrow(/dangerouslyAllowBrowser must be a boolean/);
    }
  });

  it("normalizes environment-style API keys before sending Authorization", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ object: "list", data: [] }));
    const client = new RunInfra({
      apiKey: " \tsk-ri-test\n",
      fetch: fetcher,
    });

    await client.models.list();

    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-ri-test");
  });

  it("rejects API keys with non-printable characters after trimming", () => {
    expect(() => new RunInfra({ apiKey: "sk-ri-\ntest" })).toThrow(/apiKey must be ASCII/);
  });

  it("rejects unsafe or malformed base URLs before sending bearer keys", () => {
    for (const baseURL of ["javascript:alert(1)", "file:///tmp/key", "ftp://runinfra.ai/api/v1", "not-a-url"]) {
      expect(() => new RunInfra({ apiKey: "sk-ri-test", baseURL })).toThrow(
        /baseURL must be an http or https URL/,
      );
    }
  });

  it("rejects non-string base URLs before sending bearer keys", () => {
    expect(() => new RunInfra({
      apiKey: "sk-ri-test",
      baseURL: 123 as unknown as string,
    })).toThrow(/baseURL must be a string/);
  });

  it("rejects remote cleartext base URLs before sending bearer keys but permits local development hosts", async () => {
    expect(() => new RunInfra({
      apiKey: "sk-ri-test",
      baseURL: "http://runinfra.ai/api/v1",
    })).toThrow(/Remote baseURL must use https/);

    for (const baseURL of [
      "http://localhost:3000/api/v1",
      "http://127.0.0.1:3000/api/v1",
      "http://0.0.0.0:3000/api/v1",
      "http://[::1]:3000/api/v1",
    ]) {
      const fetcher = vi.fn().mockResolvedValue(jsonResponse({ object: "list", data: [] }));
      const client = new RunInfra({
        apiKey: "sk-ri-test",
        baseURL,
        fetch: fetcher,
      });

      await client.models.list();

      expect(fetcher).toHaveBeenCalledWith(
        `${baseURL}/models`,
        expect.objectContaining({ method: "GET" }),
      );
    }
  });

  it("rejects base URLs with embedded credentials before sending bearer keys", () => {
    for (const baseURL of [
      "https://user:pass@runinfra.ai/api/v1",
      "https://user@runinfra.ai/api/v1",
      "http://user:pass@127.0.0.1:3000/api/v1",
    ]) {
      expect(() => new RunInfra({ apiKey: "sk-ri-test", baseURL })).toThrow(
        /baseURL must not include credentials/,
      );
    }
  });

  it("rejects base URLs with query strings or fragments before path construction", () => {
    for (const baseURL of [
      "https://api.runinfra.ai/v1?api_key=secret",
      "https://api.runinfra.ai/v1#models",
    ]) {
      expect(() => new RunInfra({ apiKey: "sk-ri-test", baseURL })).toThrow(
        /baseURL must not include query strings or fragments/,
      );
    }
  });

  it("encodes pipeline ids when building pipeline-scoped URLs", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ object: "list", data: [] }));
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      pipelineId: "pipe/needs encoding",
      baseURL: "https://api.runinfra.ai/v1",
      fetch: fetcher,
    });

    await client.models.list();

    expect(fetcher).toHaveBeenCalledWith(
      "https://api.runinfra.ai/v1/pipe%2Fneeds%20encoding/models",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("rejects blank pipeline ids before any request is sent", () => {
    expect(() => new RunInfra({
      apiKey: "sk-ri-test",
      pipelineId: "   ",
    })).toThrow(/pipelineId must not be blank/);
  });

  it("handles long trailing-slash base URLs without regex backtracking risk", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ object: "list", data: [] }));
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      baseURL: `http://localhost:8787/v1${"/".repeat(10_000)}`,
      fetch: fetcher,
    });

    await client.models.list();

    expect(fetcher).toHaveBeenCalledWith(
      "http://localhost:8787/v1/models",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("does not double-append a pipeline id when baseURL is already scoped", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ object: "list", data: [] }));
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      pipelineId: "pipe-123",
      baseURL: "https://api.runinfra.ai/v1/pipe-123",
      fetch: fetcher,
    });

    await client.models.list();

    expect(fetcher).toHaveBeenCalledWith(
      "https://api.runinfra.ai/v1/pipe-123/models",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("fails closed in browser runtimes unless explicitly allowed", () => {
    const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
    const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
    Object.defineProperty(globalThis, "window", { configurable: true, value: {} });
    Object.defineProperty(globalThis, "document", { configurable: true, value: {} });

    try {
      expect(() => new RunInfra({ apiKey: "sk-ri-test" })).toThrow(
        /server-side environments/,
      );
      expect(() =>
        new RunInfra({ apiKey: "sk-ri-test", dangerouslyAllowBrowser: true }),
      ).not.toThrow();
    } finally {
      if (originalWindow) {
        Object.defineProperty(globalThis, "window", originalWindow);
      } else {
        Reflect.deleteProperty(globalThis, "window");
      }
      if (originalDocument) {
        Object.defineProperty(globalThis, "document", originalDocument);
      } else {
        Reflect.deleteProperty(globalThis, "document");
      }
    }
  });

  it("fails closed in browser worker runtimes unless explicitly allowed", () => {
    const originalSelf = Object.getOwnPropertyDescriptor(globalThis, "self");
    const originalWorkerGlobalScope = Object.getOwnPropertyDescriptor(
      globalThis,
      "WorkerGlobalScope",
    );
    function WorkerGlobalScope() {}
    const workerGlobal = Object.create(WorkerGlobalScope.prototype);
    Object.defineProperty(globalThis, "WorkerGlobalScope", {
      configurable: true,
      value: WorkerGlobalScope,
    });
    Object.defineProperty(globalThis, "self", {
      configurable: true,
      value: workerGlobal,
    });

    try {
      expect(() => new RunInfra({ apiKey: "sk-ri-test" })).toThrow(
        /server-side environments/,
      );
      expect(() =>
        new RunInfra({ apiKey: "sk-ri-test", dangerouslyAllowBrowser: true }),
      ).not.toThrow();
    } finally {
      if (originalSelf) {
        Object.defineProperty(globalThis, "self", originalSelf);
      } else {
        Reflect.deleteProperty(globalThis, "self");
      }
      if (originalWorkerGlobalScope) {
        Object.defineProperty(globalThis, "WorkerGlobalScope", originalWorkerGlobalScope);
      } else {
        Reflect.deleteProperty(globalThis, "WorkerGlobalScope");
      }
    }
  });

  it("supports workspace-scoped OpenAI-compatible embeddings without a pipeline id", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({ data: [{ embedding: [0.1, 0.2], index: 0 }] }),
    );
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      baseURL: "https://api.runinfra.ai/v1",
      fetch: fetcher,
    });

    const embeddings = await client.embeddings.create({ model: "bge-m3", input: ["a", "b"] });
    const firstVectorValue: number = embeddings.data[0].embedding[0];
    expect(firstVectorValue).toBe(0.1);

    expect(fetcher).toHaveBeenCalledWith(
      "https://api.runinfra.ai/v1/embeddings",
      expect.objectContaining({ method: "POST" }),
    );
  });

  it("passes through typed OpenAI-compatible embedding dimensions and float format", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({ data: [{ embedding: [0.1, 0.2], index: 0 }] }),
    );
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      fetch: fetcher,
    });

    await client.embeddings.create({
      model: "bge-m3",
      input: "hello",
      encoding_format: "float",
      dimensions: 256,
    });

    const body = JSON.parse(String((fetcher.mock.calls[0]?.[1] as RequestInit).body)) as Record<string, unknown>;
    expect(body).toMatchObject({
      model: "bge-m3",
      input: "hello",
      encoding_format: "float",
      dimensions: 256,
    });
  });

  it("rejects blank inference model ids before sending", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({}));
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      fetch: fetcher,
    });
    const expectInvalidModel = async (run: () => unknown): Promise<void> => {
      await expect(Promise.resolve().then(run)).rejects.toMatchObject({
        type: "invalid_request_options",
      });
    };

    await expectInvalidModel(() =>
      client.chat.completions.create({
        model: "   ",
        messages: [{ role: "user", content: "Hi" }],
      }),
    );
    await expectInvalidModel(() =>
      client.responses.create({ model: "   ", input: "Hi" }),
    );
    await expectInvalidModel(() =>
      client.embeddings.create({ model: "   ", input: "Hi" }),
    );
    await expectInvalidModel(() =>
      client.audio.speech.create({ model: "   ", input: "Hi", voice: "default" }),
    );
    await expectInvalidModel(() =>
      client.audio.transcriptions.create({
        model: "   ",
        file: new Blob([new Uint8Array([1])], { type: "audio/wav" }),
      }),
    );
    await expectInvalidModel(() =>
      client.images.generate({ model: "   ", prompt: "cat" }),
    );

    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects non-string inference model ids before sending", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({}));
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      fetch: fetcher,
    });

    await expect(Promise.resolve().then(() =>
      client.embeddings.create({
        model: 123 as unknown as string,
        input: "Hi",
      }),
    )).rejects.toMatchObject({
      type: "invalid_request_options",
      message: "model must be a string",
    });

    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects invalid required inference payload fields before sending", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({}));
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      fetch: fetcher,
    });
    const expectInvalidPayload = async (
      run: () => unknown,
      message: string,
    ): Promise<void> => {
      await expect(Promise.resolve().then(run)).rejects.toMatchObject({
        type: "invalid_request_options",
        message,
      });
    };

    await expectInvalidPayload(
      () => client.chat.completions.create({ model: "llama", messages: [] }),
      "messages must be a non-empty array",
    );
    await expectInvalidPayload(
      () => client.chat.completions.create({
        model: "llama",
        messages: ["bad"] as unknown as never[],
      }),
      "messages[0] must be an object with a non-empty role",
    );
    await expectInvalidPayload(
      () => client.chat.completions.create({
        model: "llama",
        messages: [{}] as unknown as never[],
      }),
      "messages[0] must be an object with a non-empty role",
    );
    await expectInvalidPayload(
      () => client.responses.create({ model: "llama", input: "   " }),
      "input must be a non-empty string or array",
    );
    await expectInvalidPayload(
      () => client.responses.create({
        model: "llama",
        input: ["bad"] as unknown as never[],
      }),
      "input[0] must be an object",
    );
    await expectInvalidPayload(
      () => client.embeddings.create({ model: "bge-m3", input: [] }),
      "input must be a non-empty string or array of strings",
    );
    await expectInvalidPayload(
      () => client.audio.speech.create({ model: "kokoro", input: "   ", voice: "default" }),
      "input must be a non-empty string",
    );
    await expectInvalidPayload(
      () => client.audio.speech.create({ model: "kokoro", input: "hello", voice: "   " }),
      "voice must be a non-empty string",
    );
    await expectInvalidPayload(
      () => client.audio.transcriptions.create({
        model: "whisper",
        file: undefined as unknown as Blob,
      }),
      "file must be a Blob",
    );
    await expectInvalidPayload(
      () => client.audio.transcriptions.create({
        model: "whisper",
        file: new Blob([], { type: "audio/wav" }),
      }),
      "file must not be empty",
    );
    await expectInvalidPayload(
      () => client.images.generate({ model: "flux", prompt: "   " }),
      "prompt must be a non-empty string",
    );
    await expectInvalidPayload(
      () => client.responses.create(
        {
          model: "llama",
          input: "Hi",
        },
        { extraBody: { metadata: { value: Number.NaN } } },
      ),
      "JSON request body must be JSON-serializable and contain only finite numbers",
    );
    await expectInvalidPayload(
      () => client.responses.create(
        {
          model: "llama",
          input: "Hi",
        },
        { extraBody: { metadata: BigInt(1) as unknown } },
      ),
      "JSON request body must be JSON-serializable and contain only finite numbers",
    );
    const cyclicArray: unknown[] = [];
    cyclicArray.push(cyclicArray);
    await expectInvalidPayload(
      () => client.responses.create(
        {
          model: "llama",
          input: "Hi",
        },
        { extraBody: { metadata: cyclicArray } },
      ),
      "JSON request body must be JSON-serializable and contain only finite numbers",
    );

    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects native embedding response shapes it cannot type before sending", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({}));
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      fetch: fetcher,
    });

    await expect(Promise.resolve().then(() =>
      client.embeddings.create({
        model: "bge-m3",
        input: "hello",
        encoding_format: "base64",
      }),
    )).rejects.toMatchObject({
      type: "invalid_request_options",
      message: "embedding encoding_format must be float for native SDK typed responses",
    });

    await expect(Promise.resolve().then(() =>
      client.embeddings.create({
        model: "bge-m3",
        input: "hello",
        dimensions: 0,
      }),
    )).rejects.toMatchObject({
      type: "invalid_request_options",
      message: "embedding dimensions must be a positive integer",
    });

    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects unsafe transcription multipart metadata before sending", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({}));
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      fetch: fetcher,
    });
    const file = new Blob([new Uint8Array([1])], { type: "audio/wav" });

    const cases: Array<() => Promise<unknown>> = [
      () =>
        client.audio.transcriptions.create({
          model: "whisper",
          file,
          filename: 'clip"\r\nX-Bad: 1.wav',
        }),
      () =>
        client.audio.transcriptions.create({
          model: "whisper",
          file,
          ["bad\r\nfield"]: "value",
        }),
      () =>
        client.audio.transcriptions.create({
          model: "whisper",
          file,
          runinfra_probe: "value",
        } as Parameters<typeof client.audio.transcriptions.create>[0]),
      () =>
        client.audio.transcriptions.create({
          model: "whisper",
          file,
          temperature: { value: 0 } as unknown,
        }),
      () =>
        client.audio.transcriptions.create({
          model: "whisper",
          file,
          prompt: ["bad"] as unknown,
        }),
      () =>
        client.audio.transcriptions.create({
          model: "whisper",
          file,
          temperature: Number.NaN,
        }),
      () =>
        client.audio.transcriptions.create({
          model: "whisper",
          file,
          temperature: Number.POSITIVE_INFINITY,
        }),
    ];

    for (const run of cases) {
      await expect(Promise.resolve().then(run)).rejects.toMatchObject({
        type: "invalid_request_options",
      });
    }

    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects native ASR response formats it cannot parse as JSON before sending", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({}));
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      fetch: fetcher,
    });

    await expect(Promise.resolve().then(() =>
      client.audio.transcriptions.create({
        model: "whisper",
        file: new Blob([new Uint8Array([1])], { type: "audio/wav" }),
        response_format: "text",
      }),
    )).rejects.toMatchObject({
      type: "invalid_request_options",
      message: "audio transcription response_format must be json or verbose_json for native SDK typed responses",
    });

    expect(fetcher).not.toHaveBeenCalled();
  });

  it("calls pipeline-scoped OpenAI-compatible Responses API", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({ object: "response", output_text: "hi" }),
    );
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      pipelineId: "pipe-123",
      baseURL: "https://api.runinfra.ai/v1",
      fetch: fetcher,
    });

    await client.responses.create({
      model: "llama-3.1-8b",
      input: "Hi",
      max_output_tokens: 64,
    });

    expect(fetcher).toHaveBeenCalledWith(
      "https://api.runinfra.ai/v1/pipe-123/responses",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"max_output_tokens":64'),
      }),
    );
  });

  it("sends tracing and idempotency headers without adding SDK options to the JSON body", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({ object: "response", output_text: "hi" }),
    );
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      pipelineId: "pipe-123",
      fetch: fetcher,
    });

    await client.responses.create(
      {
        model: "llama-3.1-8b",
        input: "Hi",
      },
      {
        clientRequestId: "req-user-123",
        idempotencyKey: "idem-user-123",
        headers: { "X-RunInfra-Test": "trace" },
      },
    );

    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(init.headers).toEqual(
      expect.objectContaining({
        "X-Client-Request-Id": "req-user-123",
        "Idempotency-Key": "idem-user-123",
        "X-RunInfra-Test": "trace",
      }),
    );
    expect(init.body).toBe('{"model":"llama-3.1-8b","input":"Hi"}');
  });

  it("uses extraBody as the explicit JSON body escape hatch and blocks typed overrides", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ object: "response", output_text: "hi" }));
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      fetch: fetcher,
    });

    await client.responses.create(
      {
        model: "llama-3.1-8b",
        input: "Hi",
      },
      {
        extraBody: {
          runinfra_unsupported_parameter_probe: "must_error",
        },
      },
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((fetcher.mock.calls[0]?.[1] as RequestInit).body).toBe(
      '{"model":"llama-3.1-8b","input":"Hi","runinfra_unsupported_parameter_probe":"must_error"}',
    );

    await expect(
      client.responses.create(
        {
          model: "llama-3.1-8b",
          input: "Hi",
        },
        {
          extraBody: {
            model: "other",
          },
        },
      ),
    ).rejects.toMatchObject({
      type: "invalid_request_options",
      message: "extraBody must not override typed request field: model",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("rejects unknown direct request fields before sending and keeps extraBody as the escape hatch", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ object: "response", output_text: "hi" }));
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      pipelineId: "pipe-unknown-fields",
      fetch: fetcher,
    });

    await expect(Promise.resolve().then(() =>
      client.responses.create({
        model: "llama-3.1-8b",
        input: "Hi",
        runinfra_unsupported_parameter_probe: "must-use-extra-body",
      } as Parameters<typeof client.responses.create>[0]),
    )).rejects.toMatchObject({
      type: "invalid_request_options",
      message: "Unknown responses request field: runinfra_unsupported_parameter_probe",
    });

    await expect(Promise.resolve().then(() =>
      client.chat.completions.create({
        model: "llama-3.1-8b",
        messages: [{ role: "user", content: "Hi" }],
        runinfra_unsupported_parameter_probe: "must-use-extra-body",
      } as Parameters<typeof client.chat.completions.create>[0]),
    )).rejects.toMatchObject({
      type: "invalid_request_options",
      message: "Unknown chat completion request field: runinfra_unsupported_parameter_probe",
    });

    await expect(Promise.resolve().then(() =>
      client.embeddings.create({
        model: "embedding-model",
        input: "Hi",
        runinfra_unsupported_parameter_probe: "must-use-extra-body",
      } as Parameters<typeof client.embeddings.create>[0]),
    )).rejects.toMatchObject({
      type: "invalid_request_options",
      message: "Unknown embedding request field: runinfra_unsupported_parameter_probe",
    });

    await expect(Promise.resolve().then(() =>
      client.images.generate({
        model: "image-model",
        prompt: "Hi",
        runinfra_unsupported_parameter_probe: "must-use-extra-body",
      } as Parameters<typeof client.images.generate>[0]),
    )).rejects.toMatchObject({
      type: "invalid_request_options",
      message: "Unknown image generation request field: runinfra_unsupported_parameter_probe",
    });

    await expect(Promise.resolve().then(() =>
      client.audio.speech.create({
        model: "tts-model",
        input: "Hi",
        voice: "alloy",
        runinfra_unsupported_parameter_probe: "must-use-extra-body",
      } as Parameters<typeof client.audio.speech.create>[0]),
    )).rejects.toMatchObject({
      type: "invalid_request_options",
      message: "Unknown audio speech request field: runinfra_unsupported_parameter_probe",
    });

    await expect(Promise.resolve().then(() =>
      client.voice.pipeline.create({
        audio: new Uint8Array([1, 2, 3]),
        mimeType: "audio/wav",
        runinfra_unsupported_parameter_probe: "not-allowed",
      } as Parameters<typeof client.voice.pipeline.create>[0]),
    )).rejects.toMatchObject({
      type: "invalid_request_options",
      message: "Unknown voice pipeline request field: runinfra_unsupported_parameter_probe",
    });

    expect(fetcher).not.toHaveBeenCalled();

    await client.responses.create(
      {
        model: "llama-3.1-8b",
        input: "Hi",
      },
      {
        extraBody: {
          runinfra_unsupported_parameter_probe: "must_error",
        },
      },
    );

    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((fetcher.mock.calls[0]?.[1] as RequestInit).body).toContain(
      '"runinfra_unsupported_parameter_probe":"must_error"',
    );
  });

  it("rejects extraBody keys for omitted typed request fields before sending", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ object: "response", output_text: "hi" }));
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      fetch: fetcher,
    });

    await expect(
      client.responses.create(
        {
          model: "llama-3.1-8b",
          input: "Hi",
        },
        {
          extraBody: {
            stream: true,
          },
        },
      ),
    ).rejects.toMatchObject({
      type: "invalid_request_options",
      message: "extraBody must not override typed request field: stream",
    });

    await expect(
      client.embeddings.create(
        {
          model: "bge-m3",
          input: "Hi",
        },
        {
          extraBody: {
            encoding_format: "base64",
          },
        },
      ),
    ).rejects.toMatchObject({
      type: "invalid_request_options",
      message: "extraBody must not override typed request field: encoding_format",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects extraBody on non-JSON and no-body request paths before sending", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ object: "list", data: [] }));
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      pipelineId: "pipe-extra-body",
      fetch: fetcher,
    });

    await expect(
      client.models.list({
        extraBody: {
          runinfra_probe: true,
        },
      }),
    ).rejects.toMatchObject({
      type: "invalid_request_options",
      message: "extraBody can only be used with JSON request bodies",
    });

    await expect(
      client.audio.transcriptions.create(
        {
          model: "whisper",
          file: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }),
          filename: "sample.wav",
        },
        {
          extraBody: {
            runinfra_probe: true,
          },
        },
      ),
    ).rejects.toMatchObject({
      type: "invalid_request_options",
      message: "extraBody can only be used with JSON request bodies",
    });

    await expect(
      client.voice.pipeline.create(
        {
          audio: new Uint8Array([1, 2, 3]),
          mimeType: "audio/wav",
        },
        {
          extraBody: {
            runinfra_probe: true,
          },
        },
      ),
    ).rejects.toMatchObject({
      type: "invalid_request_options",
      message: "extraBody can only be used with JSON request bodies",
    });

    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects blank client request ids and idempotency keys before sending", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ object: "response" }));
    const client = new RunInfra({ apiKey: "sk-ri-test", fetch: fetcher });

    await expect(
      client.responses.create(
        { model: "llama-3.1-8b", input: "Hi" },
        { clientRequestId: "   " },
      ),
    ).rejects.toMatchObject({ type: "invalid_request_options" });
    await expect(
      client.responses.create(
        { model: "llama-3.1-8b", input: "Hi" },
        { idempotencyKey: "   " },
      ),
    ).rejects.toMatchObject({ type: "invalid_request_options" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects idempotency keys over 255 characters before sending", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ object: "response" }));
    const client = new RunInfra({ apiKey: "sk-ri-test", fetch: fetcher });

    await expect(
      client.responses.create(
        { model: "llama-3.1-8b", input: "Hi" },
        { idempotencyKey: "i".repeat(256) },
      ),
    ).rejects.toMatchObject({
      type: "invalid_request_options",
      message: "idempotencyKey must be ASCII and 255 characters or less",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects custom headers that try to override SDK-controlled headers", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ object: "response" }));
    const client = new RunInfra({ apiKey: "sk-ri-test", fetch: fetcher });

    await expect(
      client.responses.create(
        { model: "llama-3.1-8b", input: "Hi" },
        {
          headers: {
            authorization: "Bearer attacker",
            "X-RunInfra-Test": "trace",
          },
        },
      ),
    ).rejects.toMatchObject({ type: "invalid_request_options" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects custom transport and credential headers before sending", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ object: "response" }));
    const client = new RunInfra({ apiKey: "sk-ri-test", fetch: fetcher });

    for (const headerName of [
      "Host",
      "Cookie",
      "Content-Length",
      "Transfer-Encoding",
      "Connection",
      "Proxy-Authorization",
      "X-API-Key",
      "Api-Key",
      "X-Auth-Token",
      "X-Access-Token",
    ]) {
      await expect(
        client.responses.create(
          { model: "llama-3.1-8b", input: "Hi" },
          { headers: { [headerName]: "bad" } },
        ),
      ).rejects.toMatchObject({
        type: "invalid_request_options",
        message: `${headerName} is controlled by the RunInfra SDK`,
      });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects non-object custom headers before sending", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ object: "response" }));
    const client = new RunInfra({ apiKey: "sk-ri-test", fetch: fetcher });

    for (const headers of [
      "bad",
      ["bad"],
      new Map([["X-RunInfra-Test", "trace"]]),
      new Headers({ "X-RunInfra-Test": "trace" }),
    ]) {
      await expect(
        client.responses.create(
          { model: "llama-3.1-8b", input: "Hi" },
          { headers: headers as unknown as Record<string, string> },
        ),
      ).rejects.toMatchObject({
        type: "invalid_request_options",
        message: "headers must be an object with string names and values",
      });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects custom header values with control characters before sending", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ object: "response" }));
    const client = new RunInfra({ apiKey: "sk-ri-test", fetch: fetcher });

    await expect(
      client.responses.create(
        { model: "llama-3.1-8b", input: "Hi" },
        { headers: { "X-RunInfra-Test": "bad\r\nvalue" } },
      ),
    ).rejects.toMatchObject({ type: "invalid_request_options" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects invalid constructor retry and timeout options", () => {
    const fetcher = vi.fn();

    expect(() => new RunInfra({ apiKey: "sk-ri-test", fetch: fetcher, timeoutMs: 0 }))
      .toThrowError(expect.objectContaining({ type: "invalid_request_options" }));
    expect(() => new RunInfra({ apiKey: "sk-ri-test", fetch: fetcher, maxRetries: -1 }))
      .toThrowError(expect.objectContaining({ type: "invalid_request_options" }));
    expect(() => new RunInfra({ apiKey: "sk-ri-test", fetch: fetcher, retryBaseMs: -1 }))
      .toThrowError(expect.objectContaining({ type: "invalid_request_options" }));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects unknown constructor option keys", () => {
    const fetcher = vi.fn();

    expect(() => new RunInfra({
      apiKey: "sk-ri-test",
      fetch: fetcher,
      baseUrl: "https://example.com/api/v1",
    } as unknown as RunInfraOptions)).toThrowError(expect.objectContaining({
      type: "invalid_request_options",
      message: "Unknown RunInfra option: baseUrl",
    }));
    expect(() => new RunInfra({
      api_key: "sk-ri-test",
      fetch: fetcher,
    } as unknown as RunInfraOptions)).toThrowError(expect.objectContaining({
      type: "invalid_request_options",
      message: "Unknown RunInfra option: api_key",
    }));
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects invalid custom fetch hooks before any request is sent", () => {
    expect(() => new RunInfra({
      apiKey: "sk-ri-test",
      fetch: 123 as unknown as typeof fetch,
    })).toThrowError(expect.objectContaining({
      type: "invalid_request_options",
      message: "fetch must be a function",
    }));
  });

  it("rejects invalid per-request retry and timeout options before sending", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ object: "response" }));
    const client = new RunInfra({ apiKey: "sk-ri-test", fetch: fetcher });

    await expect(
      client.responses.create(
        { model: "llama-3.1-8b", input: "Hi" },
        { timeoutMs: 0 },
      ),
    ).rejects.toMatchObject({ type: "invalid_request_options" });
    await expect(
      client.responses.create(
        { model: "llama-3.1-8b", input: "Hi" },
        { maxRetries: -1 },
      ),
    ).rejects.toMatchObject({ type: "invalid_request_options" });
    await expect(
      client.responses.create(
        { model: "llama-3.1-8b", input: "Hi" },
        { retryBaseMs: -1 },
      ),
    ).rejects.toMatchObject({ type: "invalid_request_options" });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects non-object request options before sending", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ object: "response" }));
    const client = new RunInfra({ apiKey: "sk-ri-test", fetch: fetcher });

    for (const requestOptions of ["bad", ["bad"], new Map([["timeoutMs", 1000]])]) {
      await expect(
        client.responses.create(
          { model: "llama-3.1-8b", input: "Hi" },
          requestOptions as unknown as RunInfraRequestOptions,
        ),
      ).rejects.toMatchObject({
        type: "invalid_request_options",
        message: "requestOptions must be an object",
      });
    }
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects unknown request option keys before sending", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ object: "response" }));
    const client = new RunInfra({ apiKey: "sk-ri-test", fetch: fetcher });

    await expect(
      client.responses.create(
        { model: "llama-3.1-8b", input: "Hi" },
        { idempotency_key: "idem-123" } as unknown as RunInfraRequestOptions,
      ),
    ).rejects.toMatchObject({
      type: "invalid_request_options",
      message: "Unknown request option: idempotency_key",
    });
    await expect(
      client.responses.create(
        { model: "llama-3.1-8b", input: "Hi" },
        { maxRetry: 0 } as unknown as RunInfraRequestOptions,
      ),
    ).rejects.toMatchObject({
      type: "invalid_request_options",
      message: "Unknown request option: maxRetry",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("returns binary audio responses for TTS", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2, 3]), {
        status: 200,
        headers: { "Content-Type": "audio/mpeg", "x-request-id": "req-audio-123" },
      }),
    );
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      pipelineId: "pipe-tts",
      fetch: fetcher,
    });

    const response = await client.audio.speech.create({
      model: "kokoro",
      input: "hello",
      voice: "default",
    });

    expect(response.contentType).toBe("audio/mpeg");
    expect(response.requestId).toBe("req-audio-123");
    await expect(response.arrayBuffer()).resolves.toBeInstanceOf(ArrayBuffer);
  });

  it("allows TTS reference-audio requests without a configured voice", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      new Response(new Uint8Array([1, 2]), {
        status: 200,
        headers: { "Content-Type": "audio/wav" },
      }),
    );
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      pipelineId: "pipe-tts",
      fetch: fetcher,
    });

    await client.audio.speech.create({
      model: "qwen3-tts",
      input: "hello",
      task_type: "Base",
      ref_audio: "https://example.com/ref.wav",
      ref_text: "reference voice text",
    });

    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBe(JSON.stringify({
      model: "qwen3-tts",
      input: "hello",
      task_type: "Base",
      ref_audio: "https://example.com/ref.wav",
      ref_text: "reference voice text",
    }));
  });

  it("maps binary audio arrayBuffer body failures to typed connection errors", async () => {
    const failingBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("socket closed"));
      },
    });
    const response = new RunInfraAudioResponse(
      new Response(failingBody, {
        status: 200,
        headers: { "x-request-id": "req-audio-array-fail" },
      }),
    );

    await expect(response.arrayBuffer()).rejects.toMatchObject({
      name: "RunInfraConnectionError",
      requestId: "req-audio-array-fail",
      type: "connection_error",
      message: "socket closed",
    });
  });

  it("maps binary audio blob body failures to typed connection errors", async () => {
    const failingBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new Error("socket closed"));
      },
    });
    const response = new RunInfraAudioResponse(
      new Response(failingBody, {
        status: 200,
        headers: { "x-request-id": "req-audio-blob-fail" },
      }),
    );

    await expect(response.blob()).rejects.toMatchObject({
      name: "RunInfraConnectionError",
      requestId: "req-audio-blob-fail",
      type: "connection_error",
      message: "socket closed",
    });
  });

  it("times out stalled binary audio body reads with request ids", async () => {
    vi.useFakeTimers();
    try {
      const response = new RunInfraAudioResponse(
        {
          headers: new Headers({ "x-request-id": "req-audio-timeout" }),
          arrayBuffer: () =>
            new Promise<ArrayBuffer>((resolve) => {
              setTimeout(() => resolve(new ArrayBuffer(0)), 1_000);
            }),
        } as unknown as Response,
        20,
      );

      const pending = expect(response.arrayBuffer()).rejects.toMatchObject({
        name: "RunInfraTimeoutError",
        requestId: "req-audio-timeout",
        type: "timeout_error",
        message: "RunInfra audio response timed out while reading body",
      });
      await vi.advanceTimersByTimeAsync(1_000);
      await pending;
    } finally {
      vi.useRealTimers();
    }
  });

  it("uploads audio transcription requests as multipart form data", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ text: "hello" }));
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      pipelineId: "pipe-asr",
      fetch: fetcher,
    });

    await client.audio.transcriptions.create({
      model: "whisper-large-v3",
      file: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }),
      filename: "clip.wav",
    });

    const init = fetcher.mock.calls[0]?.[1] as RequestInit;
    expect(init.body).toBeInstanceOf(FormData);
    expect((init.headers as Record<string, string>)["Content-Type"]).toBeUndefined();
  });

  it("maps OpenAI-compatible error responses to typed SDK errors", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse(
        { error: { message: "Invalid API key", type: "auth_error" } },
        { status: 401 },
      ),
    );
    const client = new RunInfra({ apiKey: "bad", fetch: fetcher });

    await expect(client.models.list()).rejects.toBeInstanceOf(AuthenticationError);
  });

  it("attaches server request ids to successful JSON responses", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse(
        { object: "list", data: [] },
        {
          headers: {
            "x-request-id": "req-server-123",
            "x-runinfra-idempotent-replay": "true",
          },
        },
      ),
    );
    const client = new RunInfra({ apiKey: "sk-ri-test", fetch: fetcher });

    await expect(client.models.list()).resolves.toMatchObject({
      object: "list",
      _request_id: "req-server-123",
      _idempotent_replay: true,
    });
  });

  it("rejects malformed JSON response shapes before returning user data", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse("OK.", { headers: { "x-request-id": "req-raw-text" } }),
    );
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      pipelineId: "pipe-chat",
      fetch: fetcher,
    });

    await expect(
      client.chat.completions.create({
        model: "llama-3.1-8b",
        messages: [{ role: "user", content: "Hi" }],
      }),
    ).rejects.toMatchObject({
      name: "RunInfraError",
      status: 200,
      type: "response_shape_error",
      requestId: "req-raw-text",
    } satisfies Partial<RunInfraError>);
  });

  it("retrieves an OpenAI-compatible model object by id", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({
        id: "bge-m3",
        object: "model",
        created: 1,
        owned_by: "runinfra",
      }),
    );
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      pipelineId: "pipe-123",
      baseURL: "https://api.runinfra.ai/v1",
      fetch: fetcher,
    });

    const model = await client.models.retrieve("bge-m3");
    const modelId: string = model.id;
    expect(modelId).toBe("bge-m3");
    expect(model).toMatchObject({ object: "model" });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.runinfra.ai/v1/pipe-123/models/bge-m3",
      expect.objectContaining({ method: "GET" }),
    );
  });

  it("rejects blank model ids for model retrieval before sending", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ id: "bge-m3" }));
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      fetch: fetcher,
    });

    await expect(client.models.retrieve("   ")).rejects.toMatchObject({
      type: "invalid_request_options",
      message: "model must not be blank",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("rejects non-string model ids for model retrieval before sending", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({ id: "bge-m3" }));
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      fetch: fetcher,
    });

    await expect(
      client.models.retrieve(123 as unknown as string),
    ).rejects.toMatchObject({
      type: "invalid_request_options",
      message: "model must be a string",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("retries transient upstream failures and rate limits", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: "busy" } }, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ object: "list", data: [] }));
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      fetch: fetcher,
      maxRetries: 1,
      retryBaseMs: 0,
    });

    await expect(client.models.list()).resolves.toEqual({ object: "list", data: [] });
    expect(fetcher).toHaveBeenCalledTimes(2);

    const rateLimitedFetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse(
          { error: { message: "slow down", type: "rate_limit_error" } },
          { status: 429 },
        ),
      )
      .mockResolvedValueOnce(jsonResponse({ object: "list", data: [] }));
    const rateLimitedClient = new RunInfra({
      apiKey: "sk-ri-test",
      fetch: rateLimitedFetcher,
      maxRetries: 1,
      retryBaseMs: 0,
    });

    await expect(rateLimitedClient.models.list()).resolves.toEqual({ object: "list", data: [] });
    expect(rateLimitedFetcher).toHaveBeenCalledTimes(2);
  });

  it("cancels failed retryable response bodies before retrying", async () => {
    const cancel = vi.fn();
    const failedBody = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('{"error":{"message":"busy"}}'));
      },
      cancel,
    });
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(failedBody, {
          status: 503,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ object: "list", data: [] }));
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      fetch: fetcher,
      maxRetries: 1,
      retryBaseMs: 0,
    });

    await expect(client.models.list()).resolves.toEqual({ object: "list", data: [] });

    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("retries safe GET JSON body read failures after headers arrive", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonReadFailureResponse("socket closed", {
          headers: { "x-request-id": "req-body-fail" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { object: "list", data: [] },
          { headers: { "x-request-id": "req-body-ok" } },
        ),
      );
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      fetch: fetcher,
      maxRetries: 1,
      retryBaseMs: 0,
    });

    await expect(client.models.list()).resolves.toEqual({
      object: "list",
      data: [],
      _request_id: "req-body-ok",
    });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("maps exhausted JSON body read failures to typed errors with request ids", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonReadFailureResponse("socket closed", {
        headers: { "x-request-id": "req-body-fail" },
      }),
    );
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      fetch: fetcher,
      maxRetries: 0,
    });

    await expect(client.models.list()).rejects.toMatchObject({
      name: "RunInfraConnectionError",
      requestId: "req-body-fail",
      type: "connection_error",
      message: "socket closed",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("retries idempotent JSON POST body read failures after headers arrive", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonReadFailureResponse("socket closed", {
          headers: { "x-request-id": "req-post-body-fail" },
        }),
      )
      .mockResolvedValueOnce(
        jsonResponse(
          { id: "resp_123" },
          { headers: { "x-request-id": "req-post-body-ok" } },
        ),
      );
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      fetch: fetcher,
      maxRetries: 1,
      retryBaseMs: 0,
    });

    await expect(
      client.responses.create(
        { model: "llama-3.1-8b", input: "Hi" },
        { idempotencyKey: "idem-json-body-read" },
      ),
    ).resolves.toEqual({ id: "resp_123", _request_id: "req-post-body-ok" });
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("does not retry non-idempotent JSON POST body read failures after headers arrive", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        jsonReadFailureResponse("socket closed", {
          headers: { "x-request-id": "req-post-body-fail" },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ id: "resp_123" }));
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      fetch: fetcher,
      maxRetries: 1,
      retryBaseMs: 0,
    });

    await expect(
      client.responses.create({ model: "llama-3.1-8b", input: "Hi" }),
    ).rejects.toMatchObject({
      name: "RunInfraConnectionError",
      requestId: "req-post-body-fail",
      type: "connection_error",
    });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("exposes Retry-After timing on rate-limit errors", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse(
        { error: { message: "slow down", type: "rate_limit_error" } },
        { status: 429, headers: { "Retry-After": "2" } },
      ),
    );
    const client = new RunInfra({ apiKey: "sk-ri-test", fetch: fetcher, maxRetries: 0 });

    await expect(client.models.list()).rejects.toMatchObject({
      retryAfterMs: 2000,
    });
  });

  it("exposes HTTP-date Retry-After timing on rate-limit errors", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-13T10:00:00.000Z"));
    try {
      const fetcher = vi.fn().mockResolvedValue(
        jsonResponse(
          { error: { message: "slow down", type: "rate_limit_error" } },
          {
            status: 429,
            headers: { "Retry-After": "Wed, 13 May 2026 10:00:02 GMT" },
          },
        ),
      );
      const client = new RunInfra({ apiKey: "sk-ri-test", fetch: fetcher, maxRetries: 0 });

      await expect(client.models.list()).rejects.toMatchObject({
        retryAfterMs: 2000,
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("respects reasonable HTTP-date Retry-After values on transient retries", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-13T10:00:00.000Z"));
    try {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(
            { error: { message: "busy" } },
            {
              status: 503,
              headers: { "Retry-After": "Wed, 13 May 2026 10:00:02 GMT" },
            },
          ),
        )
        .mockResolvedValueOnce(jsonResponse({ object: "list", data: [] }));
      const client = new RunInfra({
        apiKey: "sk-ri-test",
        fetch: fetcher,
        maxRetries: 1,
        retryBaseMs: 1,
      });

      const result = client.models.list();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1999);
      expect(fetcher).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);

      expect(fetcher).toHaveBeenCalledTimes(2);
      await expect(result).resolves.toMatchObject({ object: "list", data: [] });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(["-1", "+1", "1.5", "0x10", "Infinity"])(
    "ignores non-plain Retry-After delay seconds %s on transient retries",
    async (retryAfter) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2026-05-13T10:00:00.000Z"));
      const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
      try {
        const fetcher = vi
          .fn()
          .mockResolvedValueOnce(
            jsonResponse(
              { error: { message: "busy" } },
              { status: 503, headers: { "Retry-After": retryAfter } },
            ),
          )
          .mockResolvedValueOnce(jsonResponse({ object: "list", data: [] }));
        const client = new RunInfra({
          apiKey: "sk-ri-test",
          fetch: fetcher,
          maxRetries: 1,
          retryBaseMs: 5,
        });

        const result = client.models.list();
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(4);
        expect(fetcher).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);

        expect(fetcher).toHaveBeenCalledTimes(2);
        await expect(result).resolves.toMatchObject({ object: "list", data: [] });
      } finally {
        randomSpy.mockRestore();
        vi.useRealTimers();
      }
    },
  );

  it("does not sleep for unreasonable Retry-After values on transient retries", async () => {
    vi.useFakeTimers();
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0);
    try {
      const fetcher = vi
        .fn()
        .mockResolvedValueOnce(
          jsonResponse(
            { error: { message: "busy" } },
            { status: 503, headers: { "Retry-After": "120" } },
          ),
        )
        .mockResolvedValueOnce(jsonResponse({ object: "list", data: [] }));
      const client = new RunInfra({
        apiKey: "sk-ri-test",
        fetch: fetcher,
        maxRetries: 1,
        retryBaseMs: 1,
      });

      const result = client.models.list();
      await Promise.resolve();
      await vi.advanceTimersByTimeAsync(1);

      expect(fetcher).toHaveBeenCalledTimes(2);
      await expect(result).resolves.toMatchObject({ object: "list", data: [] });
    } finally {
      randomSpy.mockRestore();
      vi.useRealTimers();
    }
  });

  it("does not retry charge-bearing POSTs unless an idempotency key is provided", async () => {
    const withoutIdempotency = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: "busy" } }, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ id: "resp_123" }));
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      fetch: withoutIdempotency,
      maxRetries: 1,
      retryBaseMs: 0,
    });

    await expect(
      client.responses.create({ model: "llama-3.1-8b", input: "Hi" }),
    ).rejects.toMatchObject({ status: 503 });
    expect(withoutIdempotency).toHaveBeenCalledTimes(1);

    const withIdempotency = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: "busy" } }, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ id: "resp_123" }));
    const retrySafeClient = new RunInfra({
      apiKey: "sk-ri-test",
      fetch: withIdempotency,
      maxRetries: 1,
      retryBaseMs: 0,
    });

    await expect(
      retrySafeClient.responses.create(
        { model: "llama-3.1-8b", input: "Hi" },
        { idempotencyKey: "idem-resp-123" },
      ),
    ).resolves.toMatchObject({ id: "resp_123" });
    expect(withIdempotency).toHaveBeenCalledTimes(2);
  });

  it("does not retry streaming POSTs even when an idempotency key is provided", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: "busy" } }, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ id: "resp_123" }));
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      fetch: fetcher,
      maxRetries: 1,
      retryBaseMs: 0,
    });

    await expect(
      client.responses.create(
        { model: "llama-3.1-8b", input: "Hi", stream: true },
        { idempotencyKey: "idem-stream-123" },
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not retry binary POSTs even when an idempotency key is provided", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: "busy" } }, { status: 503 }))
      .mockResolvedValueOnce(
        new Response(new Uint8Array([1, 2, 3]), {
          status: 200,
          headers: { "Content-Type": "audio/mpeg" },
        }),
      );
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      fetch: fetcher,
      maxRetries: 1,
      retryBaseMs: 0,
    });

    await expect(
      client.audio.speech.create(
        { model: "kokoro", input: "hello", voice: "default" },
        { idempotencyKey: "idem-tts-123" },
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("does not retry multipart POSTs even when an idempotency key is provided", async () => {
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ error: { message: "busy" } }, { status: 503 }))
      .mockResolvedValueOnce(jsonResponse({ text: "hello" }));
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      fetch: fetcher,
      maxRetries: 1,
      retryBaseMs: 0,
    });

    await expect(
      client.audio.transcriptions.create(
        {
          model: "whisper-large-v3",
          file: new Blob([new Uint8Array([1, 2, 3])], { type: "audio/wav" }),
          filename: "clip.wav",
        },
        { idempotencyKey: "idem-asr-123" },
      ),
    ).rejects.toMatchObject({ status: 503 });
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("maps exhausted network failures to a typed connection error", async () => {
    const fetcher = vi.fn().mockRejectedValue(new TypeError("fetch failed"));
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      fetch: fetcher,
      maxRetries: 1,
      retryBaseMs: 0,
    });

    await expect(client.models.list()).rejects.toBeInstanceOf(
      RunInfraConnectionError,
    );
    expect(fetcher).toHaveBeenCalledTimes(2);
  });

  it("redacts api keys from exhausted transport errors", async () => {
    const apiKey = "sk-ri-redact-local";
    const fetcher = vi.fn().mockRejectedValue(new Error(`lower transport exposed ${apiKey}`));
    const client = new RunInfra({
      apiKey,
      fetch: fetcher,
      maxRetries: 0,
      retryBaseMs: 0,
    });

    await expect(client.models.list()).rejects.toMatchObject({
      name: "RunInfraConnectionError",
      type: "connection_error",
      status: 0,
    });
    await expect(client.models.list()).rejects.not.toThrow(apiKey);
  });

  it("redacts api keys from SDK error causes", async () => {
    const apiKey = "sk-ri-redact-local";
    const sdkError = new RunInfraConnectionError("safe public message", "req-sdk-cause-redact");
    Object.defineProperty(sdkError, "cause", {
      value: new Error(`sdk cause exposed ${apiKey}`),
      configurable: true,
    });
    const fetcher = vi.fn().mockRejectedValue(sdkError);
    const client = new RunInfra({
      apiKey,
      fetch: fetcher,
      maxRetries: 0,
      retryBaseMs: 0,
    });

    let raised: unknown;
    try {
      await client.models.list();
    } catch (error) {
      raised = error;
    }

    expect(raised).toMatchObject({
      name: "RunInfraConnectionError",
      message: "safe public message",
      type: "connection_error",
      status: 0,
      requestId: "req-sdk-cause-redact",
    });
    expect(String((raised as { cause?: unknown }).cause)).not.toContain(apiKey);
    await expect(client.models.list()).rejects.not.toThrow(apiKey);
  });

  it("redacts api keys from response body read errors", async () => {
    const apiKey = "sk-ri-redact-local";
    const fetcher = vi.fn().mockResolvedValue(
      new Response(new ReadableStream({
        start(controller) {
          controller.error(new Error(`body reader exposed ${apiKey}`));
        },
      }), {
        status: 200,
        headers: { "content-type": "application/json", "x-request-id": "req-body-redact" },
      }),
    );
    const client = new RunInfra({
      apiKey,
      fetch: fetcher,
      maxRetries: 0,
      retryBaseMs: 0,
    });

    await expect(client.models.list()).rejects.toMatchObject({
      name: "RunInfraConnectionError",
      type: "connection_error",
      status: 0,
      requestId: "req-body-redact",
    });
    await expect(client.models.list()).rejects.not.toThrow(apiKey);
  });

  it("redacts api keys from status error bodies", async () => {
    const apiKey = "sk-ri-redact-local";
    const fetcher = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({ error: { message: `auth body exposed ${apiKey}`, type: "auth_error" } }),
        {
          status: 401,
          headers: { "content-type": "application/json", "x-request-id": "req-status-redact" },
        },
      ),
    );
    const client = new RunInfra({
      apiKey,
      fetch: fetcher,
      maxRetries: 0,
      retryBaseMs: 0,
    });

    await expect(client.models.list()).rejects.toMatchObject({
      name: "AuthenticationError",
      type: "auth_error",
      status: 401,
      requestId: "req-status-redact",
    });
    await expect(client.models.list()).rejects.not.toThrow(apiKey);
  });

  it("redacts api keys from stream read errors", async () => {
    const apiKey = "sk-ri-redact-local";
    const fetcher = vi.fn().mockResolvedValue(
      new Response(new ReadableStream({
        start(controller) {
          controller.error(new Error(`stream reader exposed ${apiKey}`));
        },
      }), {
        status: 200,
        headers: { "content-type": "text/event-stream", "x-request-id": "req-stream-redact" },
      }),
    );
    const client = new RunInfra({
      apiKey,
      fetch: fetcher,
      maxRetries: 0,
      retryBaseMs: 0,
    });

    const stream = await client.chat.completions.create({
      model: "llama",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });
    await expect(stream[Symbol.asyncIterator]().next()).rejects.toMatchObject({
      name: "RunInfraConnectionError",
      type: "connection_error",
      status: 0,
      requestId: "req-stream-redact",
    });

    const secondStream = await client.chat.completions.create({
      model: "llama",
      messages: [{ role: "user", content: "hello" }],
      stream: true,
    });
    await expect(secondStream[Symbol.asyncIterator]().next()).rejects.not.toThrow(apiKey);
  });

  it("maps exhausted aborts to a typed timeout error", async () => {
    const abortError = new DOMException("The operation was aborted.", "AbortError");
    const fetcher = vi.fn().mockRejectedValue(abortError);
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      fetch: fetcher,
      maxRetries: 0,
      retryBaseMs: 0,
    });

    await expect(client.models.list()).rejects.toBeInstanceOf(
      RunInfraTimeoutError,
    );
  });

  it("calls OpenAI-compatible image generation", async () => {
    const fetcher = vi.fn().mockResolvedValue(
      jsonResponse({ created: 1, data: [{ b64_json: "iVBORw0KGgo=" }] }),
    );
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      pipelineId: "pipe-image",
      fetch: fetcher,
    });

    await client.images.generate({ model: "flux", prompt: "cat", n: 1 });

    expect(fetcher).toHaveBeenCalledWith(
      "https://api.runinfra.ai/v1/pipe-image/images/generations",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"prompt":"cat"'),
      }),
    );
  });

  it("streams the final OpenAI-compatible SSE event without a trailing newline", async () => {
    const encoded = new TextEncoder().encode(
      'data: {"id":"chunk-1","choices":[{"delta":{"content":"hi"}}]}',
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded);
        controller.close();
      },
    });
    const fetcher = vi.fn().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "x-request-id": "req-stream-123",
        },
      }),
    );
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      pipelineId: "pipe-stream",
      fetch: fetcher,
    });

    const result = await client.chat.completions.create({
      model: "llama-3.1-8b",
      messages: [{ role: "user", content: "Hi" }],
      stream: true,
    });

    expect(result).toBeInstanceOf(RunInfraStream);
    expect((result as RunInfraStream).requestId).toBe("req-stream-123");
    const chunks: Array<Record<string, unknown>> = [];
    for await (const chunk of result as RunInfraStream) {
      chunks.push(chunk);
    }

    expect(chunks).toEqual([
      {
        id: "chunk-1",
        choices: [{ delta: { content: "hi" } }],
      },
    ]);
  });

  it("parses semantic OpenAI Responses SSE event frames", async () => {
    const encoded = new TextEncoder().encode(
      ': keepalive\r\n\r\n' +
        'event: response.output_text.delta\r\n' +
        'data:{"type":"response.output_text.delta","delta":"hi"}\r\n\r\n' +
        'data: [DONE]\r\n\r\n' +
        'event: response.completed\n' +
        'data: {"type":"response.completed","response":{"status":"completed"}}',
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded);
        controller.close();
      },
    });
    const fetcher = vi.fn().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "x-request-id": "req-stream-123",
        },
      }),
    );
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      pipelineId: "pipe-stream",
      fetch: fetcher,
    });

    const result = await client.responses.create({
      model: "llama-3.1-8b",
      input: "Hi",
      stream: true,
    });

    const events: Array<Record<string, unknown>> = [];
    for await (const event of result as RunInfraStream) {
      events.push(event);
    }

    expect(events).toEqual([
      { type: "response.output_text.delta", delta: "hi" },
      { type: "response.completed", response: { status: "completed" } },
    ]);
  });

  it("maps malformed SSE payloads to typed stream parse errors with request ids", async () => {
    const encoded = new TextEncoder().encode("data: {not-json}\n\n");
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded);
        controller.close();
      },
    });
    const fetcher = vi.fn().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "x-request-id": "req-stream-bad-json",
        },
      }),
    );
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      pipelineId: "pipe-stream",
      fetch: fetcher,
    });

    const result = await client.responses.create({
      model: "llama-3.1-8b",
      input: "Hi",
      stream: true,
    });

    const iterator = (result as RunInfraStream)[Symbol.asyncIterator]();
    try {
      await iterator.next();
      throw new Error("Expected malformed SSE payload to throw.");
    } catch (error) {
      expect(error).toBeInstanceOf(RunInfraStreamParseError);
      expect(error).toMatchObject({
        name: "RunInfraStreamParseError",
        requestId: "req-stream-bad-json",
        type: "stream_parse_error",
      });
    }
  });

  it("maps stalled SSE reads to typed timeout errors with request ids", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    try {
      const stream = new ReadableStream<Uint8Array>({
        start() {},
        cancel,
      });
      const fetcher = vi.fn().mockResolvedValue(
        new Response(stream, {
          status: 200,
          headers: {
            "Content-Type": "text/event-stream",
            "x-request-id": "req-stream-timeout",
          },
        }),
      );
      const client = new RunInfra({
        apiKey: "sk-ri-test",
        pipelineId: "pipe-stream",
        fetch: fetcher,
        timeoutMs: 20,
      });

      const result = await client.responses.create({
        model: "llama-3.1-8b",
        input: "Hi",
        stream: true,
      });
      const iterator = (result as RunInfraStream)[Symbol.asyncIterator]();
      const next = iterator.next();
      const timeoutAssertion = expect(next).rejects.toMatchObject({
        name: "RunInfraTimeoutError",
        requestId: "req-stream-timeout",
        type: "timeout_error",
      });

      await vi.advanceTimersByTimeAsync(19);
      expect(cancel).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);

      await timeoutAssertion;
      expect(cancel).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("maps errored SSE reads to typed connection errors with request ids", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.error(new TypeError("stream reset"));
      },
    });
    const fetcher = vi.fn().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/event-stream",
          "x-request-id": "req-stream-reset",
        },
      }),
    );
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      pipelineId: "pipe-stream",
      fetch: fetcher,
    });

    const result = await client.responses.create({
      model: "llama-3.1-8b",
      input: "Hi",
      stream: true,
    });

    await expect(
      (result as RunInfraStream)[Symbol.asyncIterator]().next(),
    ).rejects.toMatchObject({
      name: "RunInfraConnectionError",
      requestId: "req-stream-reset",
      type: "connection_error",
    });
  });

  it("cancels the underlying SSE reader when a stream consumer stops early", async () => {
    const cancel = vi.fn();
    const encoded = new TextEncoder().encode(
      'data: {"type":"response.output_text.delta","delta":"hi"}\n\n',
    );
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoded);
      },
      cancel,
    });
    const fetcher = vi.fn().mockResolvedValue(
      new Response(stream, {
        status: 200,
        headers: { "Content-Type": "text/event-stream" },
      }),
    );
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      pipelineId: "pipe-stream",
      fetch: fetcher,
    });

    const result = await client.responses.create({
      model: "llama-3.1-8b",
      input: "Hi",
      stream: true,
    });

    for await (const event of result as RunInfraStream) {
      expect(event).toMatchObject({
        type: "response.output_text.delta",
        delta: "hi",
      });
      break;
    }

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("posts voice pipeline audio to the verified pipeline route", async () => {
    const fetcher = vi.fn().mockResolvedValue(jsonResponse({
      transcript: "what is my balance",
      responseText: "Your balance is current.",
    }));
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      pipelineId: "pipe-voice",
      baseURL: "https://api.runinfra.ai/v1",
      fetch: fetcher,
    });

    const result = await client.voice.pipeline.create({
      audio: new Uint8Array([1, 2, 3]),
      mimeType: "audio/wav",
    }, {
      idempotencyKey: "idem-voice",
    });

    expect(result).toMatchObject({
      transcript: "what is my balance",
      responseText: "Your balance is current.",
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api.runinfra.ai/v1/pipe-voice/pipeline",
      expect.objectContaining({
        method: "POST",
        body: expect.any(ArrayBuffer),
        headers: expect.objectContaining({
          "Content-Type": "audio/wav",
          Accept: "application/json",
          "Idempotency-Key": "idem-voice",
        }),
      }),
    );
    const body = (fetcher.mock.calls[0]?.[1] as RequestInit | undefined)?.body;
    expect(new Uint8Array(body as ArrayBuffer)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it("rejects voice pipeline calls without a pipeline-scoped client before sending", async () => {
    const fetcher = vi.fn();
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      fetch: fetcher,
    });

    let caught: unknown;
    try {
      client.voice.pipeline.create({
        audio: new Uint8Array([1, 2, 3]),
        mimeType: "audio/wav",
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({
      type: "invalid_request_options",
      message: "voice pipeline requests require pipelineId or a pipeline-scoped baseURL",
    });
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("does not expose unshipped webhook delivery helpers on the public runtime surface", () => {
    const fetcher = vi.fn();
    const client = new RunInfra({
      apiKey: "sk-ri-test",
      fetch: fetcher,
    });
    const webhooks = client.webhooks as Record<string, unknown>;

    expect("create" in webhooks).toBe(false);
    expect("list" in webhooks).toBe(false);
    expect(Object.hasOwn(webhooks, "create")).toBe(false);
    expect(Object.hasOwn(webhooks, "list")).toBe(false);
    expect(typeof client.webhooks.verifySignature).toBe("function");
    expect(typeof client.webhooks.constructEvent).toBe("function");
    expect(fetcher).not.toHaveBeenCalled();
  });

  it("verifies signed webhook payloads using the exact raw body", () => {
    const payload = '{"id":"evt_123","type":"deployment.verified","data":{"pipeline_id":"pipe-1"}}';
    const timestamp = 1_700_000_000;
    const secret = "whsec_test_123";
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}.${payload}`)
      .digest("hex");

    const event = constructWebhookEvent({
      payload,
      signatureHeader: `t=${timestamp},v1=${signature}`,
      secret,
      now: timestamp + 60,
    });

    expect(event).toMatchObject({
      id: "evt_123",
      type: "deployment.verified",
      data: { pipeline_id: "pipe-1" },
    });
  });

  it("rejects webhook signatures for modified or stale payloads", () => {
    const payload = '{"id":"evt_123","type":"deployment.verified"}';
    const timestamp = 1_700_000_000;
    const secret = "whsec_test_123";
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}.${payload}`)
      .digest("hex");

    expect(() =>
      constructWebhookEvent({
        payload: '{"id":"evt_123","type":"deployment.failed"}',
        signatureHeader: `t=${timestamp},v1=${signature}`,
        secret,
        now: timestamp + 60,
      }),
    ).toThrow(WebhookVerificationError);

    expect(() =>
      constructWebhookEvent({
        payload,
        signatureHeader: `t=${timestamp},v1=${signature}`,
        secret,
        now: timestamp + 301,
      }),
    ).toThrow(WebhookVerificationError);
  });

  it("uses the webhook secret exactly when verifying signatures", () => {
    const payload = '{"id":"evt_123","type":"deployment.verified"}';
    const timestamp = 1_700_000_000;
    const secret = " whsec_test_123 ";
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}.${payload}`)
      .digest("hex");

    const event = constructWebhookEvent<{ id: string }>({
      payload,
      signatureHeader: `t=${timestamp},v1=${signature}`,
      secret,
      now: timestamp + 60,
    });

    expect(event.id).toBe("evt_123");
  });

  it("rejects webhook signatures with trailing odd hex nibbles", () => {
    const payload = '{"id":"evt_123","type":"deployment.verified"}';
    const timestamp = 1_700_000_000;
    const secret = "whsec_test_123";
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}.${payload}`)
      .digest("hex");

    expect(() =>
      constructWebhookEvent({
        payload,
        signatureHeader: `t=${timestamp},v1=${signature}0`,
        secret,
        now: timestamp + 60,
      }),
    ).toThrow(WebhookVerificationError);
  });

  it("rejects webhook timestamps that are not plain non-negative integer Unix seconds", () => {
    const payload = '{"id":"evt_123","type":"deployment.verified"}';
    const secret = "whsec_test_123";

    for (const [timestamp, signedTimestamp] of [
      ["1700000000.5", "1700000000.5"],
      ["-1", "-1"],
      ["+1", "1"],
      ["1e3", "1000"],
      ["0x1", "1"],
    ]) {
      const signature = createHmac("sha256", secret)
        .update(`${signedTimestamp}.${payload}`)
        .digest("hex");

      expect(() =>
        constructWebhookEvent({
          payload,
          signatureHeader: `t=${timestamp},v1=${signature}`,
          secret,
          now: Number(timestamp),
        }),
      ).toThrow(WebhookVerificationError);
    }
  });

  it("rejects webhook verification clocks that are not finite non-negative Unix seconds", () => {
    const payload = '{"id":"evt_123","type":"deployment.verified"}';
    const timestamp = 1_700_000_000;
    const secret = "whsec_test_123";
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}.${payload}`)
      .digest("hex");

    for (const now of [Number.NaN, Number.POSITIVE_INFINITY, -1]) {
      expect(() =>
        constructWebhookEvent({
          payload,
          signatureHeader: `t=${timestamp},v1=${signature}`,
          secret,
          now,
        }),
      ).toThrow(WebhookVerificationError);
    }
  });

  it("rejects invalid webhook verification inputs with typed errors", () => {
    const payload = '{"id":"evt_123","type":"deployment.verified"}';
    const timestamp = 1_700_000_000;
    const secret = "whsec_test_123";
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}.${payload}`)
      .digest("hex");

    for (const invalidSecret of [undefined, null, 123]) {
      expect(() =>
        constructWebhookEvent({
          payload,
          signatureHeader: `t=${timestamp},v1=${signature}`,
          secret: invalidSecret as unknown as string,
          now: timestamp + 60,
        }),
      ).toThrow(WebhookVerificationError);
    }

    for (const invalidSignatureHeader of [undefined, null, 123]) {
      expect(() =>
        constructWebhookEvent({
          payload,
          signatureHeader: invalidSignatureHeader as unknown as string,
          secret,
          now: timestamp + 60,
        }),
      ).toThrow(WebhookVerificationError);
    }
  });

  it("rejects oversized webhook signature headers before parsing signatures", () => {
    const payload = '{"id":"evt_123","type":"deployment.verified"}';
    const timestamp = 1_700_000_000;

    expect(() =>
      constructWebhookEvent({
        payload,
        signatureHeader: `t=${timestamp},v1=${"a".repeat(8_193)}`,
        secret: "whsec_test_123",
        now: timestamp + 60,
      }),
    ).toThrow("Webhook signature header is too large.");
  });

  it("rejects invalid webhook payload types with typed errors", () => {
    const payload = '{"id":"evt_123","type":"deployment.verified"}';
    const timestamp = 1_700_000_000;
    const secret = "whsec_test_123";
    const signature = createHmac("sha256", secret)
      .update(`${timestamp}.${payload}`)
      .digest("hex");

    for (const invalidPayload of [undefined, null, 123, {}]) {
      expect(() =>
        constructWebhookEvent({
          payload: invalidPayload as unknown as string,
          signatureHeader: `t=${timestamp},v1=${signature}`,
          secret,
          now: timestamp + 60,
        }),
      ).toThrow("Webhook payload must be a string, Uint8Array, or ArrayBuffer.");
    }
  });
});

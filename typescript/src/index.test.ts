// @vitest-environment node

import { createHmac } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

describe("RunInfra TypeScript SDK", () => {
  it("builds fresh dist files before package publication", () => {
    const packageJson = JSON.parse(
      readFileSync(new URL("../package.json", import.meta.url), "utf8"),
    ) as { files?: string[]; scripts?: Record<string, string> };

    expect(packageJson.scripts?.prepack).toBe(packageJson.scripts?.build);
    expect(packageJson.files).toEqual(expect.arrayContaining(["dist", "README.md", "package.json"]));
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
    expect(readme).not.toContain("Webhook delivery, Voice pipeline | Not shipped");
  });

  it("documents voice pipeline as experimental instead of unsupported", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const changelog = readFileSync(new URL("../CHANGELOG.md", import.meta.url), "utf8");

    expect(readme).toContain(
      "| Voice pipeline | `client.voice.pipeline.create` | **Experimental**, pipeline-scoped route, not live-canary verified |",
    );
    expect(readme).not.toContain("Voice pipeline | `client.voice.pipeline.create` | Not shipped");
    expect(changelog).not.toContain("client.voice.pipeline.create` is not shipped");
    expect(changelog).toContain("client.voice.pipeline.create` posts audio to the pipeline-scoped `/pipeline` route");
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

  it("documents the OpenAI-compatible parameter subset and local response-shape guards", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");
    const liveCanaries = readFileSync(new URL("../../LIVE-CANARIES.md", import.meta.url), "utf8");

    expect(readme).toContain("## OpenAI-compatible parameter scope");
    expect(readme).toContain("Live-gated native SDK subset");
    expect(readme).toContain("will be treated as verified only after the strict live canaries pass");
    expect(readme).toContain("`openai.params.chat.completions`");
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
    expect(readme).toContain("`encoding_format` values other than `\"float\"`");
    expect(readme).toContain("`response_format` values other than `\"json\"` or `\"verbose_json\"`");
    expect(readme).toContain("Unsupported OpenAI-style body parameters must fail with a clear traced 4xx");
    expect(liveCanaries).toContain("error.model.not_found");
    expect(liveCanaries).toContain("error.body.unsupported_parameter");
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
    expect(readme).toContain("ASR file must be a Blob");
    expect(readme).toContain("ASR multipart filenames and extra form field names and values");
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
    expect(liveCanaries).toContain("bounded by `RUNINFRA_CANARY_TIMEOUT_SECONDS`");
  });

  it("documents public-repo production promotion without stale monorepo commands", () => {
    const readme = readFileSync(new URL("../README.md", import.meta.url), "utf8");

    expect(readme).toContain("For production promotion");
    expect(readme).toContain("This public repo now includes live-canary runners for both SDKs.");
    expect(readme).toContain("node scripts/verify-workflow-policy.mjs");
    expect(readme).toContain("node scripts/verify-version-sync.mjs");
    expect(readme).toContain("node scripts/verify-npm-package.mjs typescript/runinfra-sdk-*.tgz");
    expect(readme).toContain("python scripts/verify-python-package.py python/dist");
    expect(readme).toContain("node scripts/verify-clean-installs.mjs --package both --mode artifact");
    expect(readme).toContain("node scripts/run-sdk-live-canaries.mjs --preflight --strict --report artifacts/sdk/live-canary-readiness.json");
    expect(readme).toContain("node scripts/run-sdk-live-canaries.mjs --package-source artifact --strict --report artifacts/sdk/live-canary.json");
    expect(readme).toContain("gh workflow run publish.yml --repo RightNow-AI/runinfra-sdk --ref main -f package=both -f dry_run=true -f confirm_version=<version>");
    expect(readme).toContain("A real publish must also prove registry install/import");
    expect(readme).toContain("node scripts/verify-clean-installs.mjs --package both --mode registry --version <version>");
    expect(readme).toContain("Run the strict preflight first");
    expect(readme).toContain("Then run the strict live canary matrix against the exact production gateway");
    expect(readme).toContain("Do not use npm or PyPI tokens");
    expect(readme).not.toContain("pnpm verify:sdk-release");
    expect(readme).not.toContain("pnpm test:sdk-canary:live");
    expect(readme).not.toContain("RUNINFRA_SDK_CI_TOKEN");
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

  it("pins registry clean-install checks to canonical npm and PyPI indexes", async () => {
    const { canonicalRegistryInstallEnv, npmRegistryInstallArgs, pythonRegistryInstallArgs } =
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
    expect(env.npm_config_registry).toBe("https://registry.npmjs.org/");
    expect(env.NPM_CONFIG_REGISTRY).toBe("https://registry.npmjs.org/");
    expect(env.PIP_INDEX_URL).toBe("https://pypi.org/simple");
    expect(env.PIP_EXTRA_INDEX_URL).toBe("");
    expect("PIP_NO_INDEX" in env).toBe(false);
    expect("PIP_FIND_LINKS" in env).toBe(false);
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
      ".npmrc",
      "package/.npmrc",
      ".env",
      ".env.local",
      "package/.env.local",
      "/tmp/project/.env.local",
    ];

    for (const sample of samples) {
      expect(findForbiddenContent(sample), sample).not.toBeNull();
    }
  });

  it("writes a redacted strict live-canary preflight report without running live calls", () => {
    const tmp = mkdtempSync(join(tmpdir(), "runinfra-preflight-"));
    const reportPath = join(tmp, "readiness.json");
    try {
      const fakeKey = "sk-ri-preflight-secret-1234567890";
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
        readiness?: {
          status?: string;
          env?: Record<string, string>;
          missing?: string[];
          rows?: Array<{ name: string; status: string; missing?: string[] }>;
        };
        reports?: unknown[];
      };
      expect(report.reports).toEqual([]);
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
          RUNINFRA_API_KEY: "sk-ri-preflight-secret-1234567890",
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
            RUNINFRA_API_KEY: "sk-ri-preflight-secret-1234567890",
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
        expect(report.readiness?.missing).toContain("RUNINFRA_CANARY_TIMEOUT_SECONDS positive finite number");
      } finally {
        rmSync(tmp, { recursive: true, force: true });
      }
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
            RUNINFRA_API_KEY: "sk-ri-preflight-secret-1234567890",
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
      () => client.images.generate({ model: "flux", prompt: "   " }),
      "prompt must be a non-empty string",
    );
    await expectInvalidPayload(
      () => client.responses.create({
        model: "llama",
        input: "Hi",
        metadata: { value: Number.NaN },
      }),
      "JSON request body must be JSON-serializable and contain only finite numbers",
    );
    await expectInvalidPayload(
      () => client.responses.create({
        model: "llama",
        input: "Hi",
        metadata: BigInt(1) as unknown,
      }),
      "JSON request body must be JSON-serializable and contain only finite numbers",
    );
    const cyclicArray: unknown[] = [];
    cyclicArray.push(cyclicArray);
    await expectInvalidPayload(
      () => client.responses.create({
        model: "llama",
        input: "Hi",
        metadata: cyclicArray,
      }),
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
        { headers: { "x-request-id": "req-server-123" } },
      ),
    );
    const client = new RunInfra({ apiKey: "sk-ri-test", fetch: fetcher });

    await expect(client.models.list()).resolves.toMatchObject({
      object: "list",
      _request_id: "req-server-123",
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

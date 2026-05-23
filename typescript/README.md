# RunInfra TypeScript SDK

Access optimized RunInfra deployments through the verified public gateway.

Requires Node.js 18 or newer.

## Install

```bash
npm install @runinfra/sdk
```

## Modality status (v0.1.3)

This SDK is in **beta**. The surfaces below have different verification levels:

| Modality | Surface | Status |
|---|---|---|
| LLM | `client.chat.completions.create`, `client.responses.create` | Beta, contract-tested |
| Embeddings | `client.embeddings.create` | Beta, contract-tested |
| Images | `client.images.generate` | **Experimental**, not live-canary verified |
| Audio (TTS) | `client.audio.speech.create` | **Experimental**, not live-canary verified |
| Audio (ASR) | `client.audio.transcriptions.create` | **Experimental**, not live-canary verified |
| Webhooks | `client.webhooks.*` | Local verification helpers only; remote delivery not shipped |
| Voice pipeline | `client.voice.pipeline.create` | **Experimental**, pipeline-scoped route, not live-canary verified |

Experimental surfaces match their documented gateway contracts, but we have
not yet completed a full end-to-end live-canary deployment for those
modalities in the public gateway. They will reach GA in v1.0.0 once the
canary suite covers all five model modalities plus voice pipeline. Test
against your own deployed models before using experimental surfaces in
production.

## Create a client

Use a workspace-scoped key to reach verified active deployments through the `model` field.
In RunPipe, open Settings, API Keys, Create key, and keep Scope set to Workspace.

The Deploy tab can create a pipeline-scoped key for one optimized pipeline.
The one-time secret is shown once after creation. Store it as `RUNINFRA_API_KEY`
for app snippets before leaving the page. For repo live canaries, keep the
workspace key in `RUNINFRA_API_KEY` and put the pipeline-scoped key for
`TEST_PIPELINE_ID` in `RUNINFRA_PIPELINE_API_KEY` so flat and pipeline routes
are verified independently.

After a runbook finishes in RunPipe, choose Open Deploy from the runbook handoff.
Deploy only shows SDK operations that the verified endpoint supports, so copy
the native or OpenAI-compatible snippet from there instead of guessing a route.

```ts
import { RunInfra } from "@runinfra/sdk";

const apiKey = process.env.RUNINFRA_API_KEY;
if (!apiKey) throw new Error("Set RUNINFRA_API_KEY before running this snippet.");

const client = new RunInfra({
  apiKey,
});
```

Use `pipelineId` when the key or integration should be locked to one optimized pipeline.

```ts
const apiKey = process.env.RUNINFRA_API_KEY;
if (!apiKey) throw new Error("Set RUNINFRA_API_KEY before running this snippet.");

const client = new RunInfra({
  apiKey,
  pipelineId: "pipe_123",
});
```

The default base URL is `https://api.runinfra.ai/v1`.
`pipelineId` is trimmed and URL-encoded before it is added to the base URL. Use either `pipelineId` with the default base URL, or a pipeline-scoped `baseURL` such as `https://api.runinfra.ai/v1/pipe_123`. If both point to the same pipeline, the SDK keeps the URL scoped once.
RunPipe generated native SDK snippets prefer `pipelineId` with the root `https://api.runinfra.ai/v1` base URL. OpenAI-compatible snippets use the pipeline-scoped base URL because the OpenAI SDK has no RunInfra pipeline option.
Custom base URLs must use `http` or `https`. Other schemes and malformed URLs are rejected before a bearer API key can be sent.
Remote custom base URLs must use `https`. Plain `http` is accepted only for local development hosts: `localhost`, `127.0.0.1`, `0.0.0.0`, and `[::1]`.
Custom base URLs must not include usernames or passwords.
Custom base URLs must not include query strings or fragments.

## Server-side only

The TypeScript SDK targets Node.js 18 or newer. RunInfra API keys are bearer secrets. Do not initialize this SDK in browser code with a secret API key. The SDK fails closed when it detects a browser runtime; keep calls on a Node.js server route, API service, or backend job. If you are deliberately using a controlled non-public browser-like runtime, pass `dangerouslyAllowBrowser: true` and own that risk.

Unknown TypeScript client option keys are rejected so typos such as `baseUrl` or `api_key` do not silently change the gateway, authentication, timeout, retry, or runtime-safety behavior. Use `baseURL` for custom server-side gateway URLs.

## Responses and streaming

```ts
const stream = await client.responses.create({
  model: "llama-3.1-8b",
  input: "Hello",
  max_output_tokens: 512,
  stream: true,
});

for await (const event of stream) {
  if (event.type === "response.output_text.delta") {
    process.stdout.write(event.delta ?? "");
  }
}

console.log(stream.requestId);
```

## Supported public routes

- `models.list()`
- `models.retrieve(model)`
- `responses.create()`
- `chat.completions.create()`
- `embeddings.create()`
- `audio.speech.create()`
- `audio.transcriptions.create()`
- `images.generate()`
- `voice.pipeline.create()`

## OpenAI-compatible parameter scope

The native SDK validates the minimum request fields locally, then forwards
OpenAI-style JSON or multipart fields that preserve the typed response shape.
The GA canary matrix now has dedicated rows for the verified subset:
`openai.params.chat.completions`, `openai.params.responses`, and
`openai.params.embeddings`.

Verified native SDK subset:

- Chat Completions: `model`, `messages`, `stream`, `temperature`, `top_p`,
  `max_tokens`, `stop`, `presence_penalty`, `frequency_penalty`, `user`, and
  `metadata`.
- Responses: `model`, `input`, `stream`, `instructions`, `temperature`,
  `max_output_tokens`, and `metadata`.
- Embeddings: `model`, `input`, `encoding_format: "float"`, and `dimensions`
  when the deployed embedding backend advertises dimension control.
- Images: `model`, `prompt`, `n`, plus optional `size` and `response_format`
  when the deployed image backend advertises them.
- Audio speech: `model`, `input`, `voice` or `ref_audio` plus `ref_text`, and
  optional `task_type` and `response_format`.
- Audio transcriptions: `model`, `file`, `filename`, optional `language`, and
  JSON response formats only.

The native typed helpers do not claim GA support for tool calls, structured
JSON schema outputs, logprobs, seeds, service tiers, parallel tool calls,
Responses state/include/reasoning controls, embedding base64 output, image
streaming or partial images, audio streaming, audio translations, or direct
browser API-key use until strict live canaries prove those behaviors. Embedding
`encoding_format` values other than `"float"` and transcription
`response_format` values other than `"json"` or `"verbose_json"` are rejected
locally because they would not match the typed native SDK response objects.
Unsupported OpenAI-style body parameters must fail with a clear traced 4xx
gateway error before GA.

## Text to speech

TTS deployments can expose named voices or Base/reference-audio voice cloning.
Use `RUNINFRA_TTS_VOICE` when the deployment lists a voice or speaker. Use
`RUNINFRA_TTS_REF_AUDIO` and `RUNINFRA_TTS_REF_TEXT` when the deployment expects
reference-audio input.

```ts
const voice = process.env.RUNINFRA_TTS_VOICE?.trim();
const refAudio = process.env.RUNINFRA_TTS_REF_AUDIO?.trim();
const refText = process.env.RUNINFRA_TTS_REF_TEXT?.trim();
const taskType = process.env.RUNINFRA_TTS_TASK_TYPE?.trim() || "Base";

const speechVoice = voice
  ? { voice }
  : refAudio && refText
    ? { ref_audio: refAudio, ref_text: refText, task_type: taskType }
    : null;

if (!speechVoice) {
  throw new Error("Set RUNINFRA_TTS_VOICE, or RUNINFRA_TTS_REF_AUDIO and RUNINFRA_TTS_REF_TEXT.");
}

const audio = await client.audio.speech.create({
  model: "your-tts-model-id",
  input: "Hello from your optimized RunInfra endpoint.",
  ...speechVoice,
});
```

## Timeouts and retries

```ts
const apiKey = process.env.RUNINFRA_API_KEY;
if (!apiKey) throw new Error("Set RUNINFRA_API_KEY before running this snippet.");

const client = new RunInfra({
  apiKey,
  timeoutMs: 60_000,
  maxRetries: 2,
  retryBaseMs: 250,
});
```

The SDK retries transient transport failures and `408`, `409`, `429`, `500`, `502`, `503`, and `504` responses for safe `GET` requests. Charge-bearing `POST` inference requests retry only when you provide `idempotencyKey`, and automatic POST retries are limited to non-streaming JSON calls whose gateway responses can be replayed safely. That covers `responses.create()`, non-streaming `chat.completions.create()`, `embeddings.create()`, and `images.generate()`. Streaming calls, binary TTS responses, and multipart ASR uploads are sent once even when you provide an idempotency key. The gateway still binds idempotency keys for TTS and ASR, so a manual retry with the same key will not run or charge a second inference after the first request settles. Automatic retries honor reasonable `Retry-After` values up to 60 seconds when the header is a plain integer second value or HTTP-date, then fall back to bounded exponential backoff. The SDK does not retry authentication errors, insufficient credits, or unsupported operations.

If the gateway successfully finishes a request but the response body is too large to replay from the idempotency cache, later calls with the same `idempotencyKey` return `idempotency_replay_unavailable` without running or charging the inference again.

`timeoutMs` must be positive, `maxRetries` must be a non-negative integer, and `retryBaseMs` must be non-negative. Unknown per-request option keys are rejected so typos do not silently disable idempotency, tracing, timeout, or retry behavior. Invalid values throw `RunInfraError` with `type: "invalid_request_options"` before any network request is sent.

## Request validation

Required request fields are validated before any network request is sent. The model must be a non-blank string, chat messages must be a non-empty array, each chat message must be an object with a non-empty role, Responses input must be a non-empty string or array, Responses input array items must be objects, JSON request bodies must be serializable and contain only finite numbers, embedding input must be a non-empty string or array of non-empty strings, TTS input and image prompts must be non-empty strings, and ASR file must be a Blob. ASR multipart filenames and extra form field names and values are validated before the FormData body is built. Invalid request values throw `RunInfraError` with `type: "invalid_request_options"` and do not reach the gateway or billing path.

Use per-request options when a call needs a shorter timeout, a trace ID, or a retry-safe idempotency key.
Custom headers are for app metadata only. They cannot override SDK-controlled headers such as `Authorization`, `Content-Type`, `X-Client-Request-Id`, `Idempotency-Key`, `X-RunInfra-SDK`, or `X-RunInfra-SDK-Version`, and they cannot set transport or credential headers such as `Host`, `Cookie`, `Content-Length`, `Transfer-Encoding`, `Connection`, `Proxy-Authorization`, `Api-Key`, `X-API-Key`, `X-Auth-Token`, or `X-Access-Token`.

```ts
await client.responses.create(
  {
    model: "llama-3.1-8b",
    input: "Summarize this incident.",
  },
  {
    clientRequestId: crypto.randomUUID(),
    idempotencyKey: crypto.randomUUID(),
    timeoutMs: 20_000,
    maxRetries: 0,
  },
);
```

## Typed errors

The SDK exposes `AuthenticationError`, `PermissionDeniedError`, `RateLimitError`, `InsufficientCreditsError`, `DeploymentError`, `ModelNotFoundError`, `RunInfraTimeoutError`, `RunInfraConnectionError`, `RunInfraStreamParseError`, and `UnsupportedOperationError`.
`RateLimitError` includes `retryAfterMs` when the gateway returns `Retry-After`.
`RunInfraStreamParseError` includes `requestId` when a malformed SSE frame came from a traced gateway response.
`RunInfraTimeoutError` also covers stalled streaming reads, stalled non-streaming JSON body reads, and stalled binary audio `arrayBuffer()` / `blob()` reads after headers arrive, and includes `requestId` when the response was traced.
`RunInfraConnectionError` also covers streaming body transport failures, non-streaming JSON body transport failures, and binary audio `arrayBuffer()` / `blob()` transport failures after headers arrive, and includes `requestId` when the response was traced.

JSON helpers return typed response objects for the public gateway contract:
`ModelListResponse`, `ModelObject`, `EmbeddingResponse`, `ResponsesCreateResponse`,
`ChatCompletionResponse`, `TranscriptionResponse`, and `ImageGenerationResponse`.
Binary TTS returns `RunInfraAudioResponse`, and streaming calls return `RunInfraStream`.

## Traceability

Every request includes `X-RunInfra-SDK: typescript`, `X-RunInfra-SDK-Version`, and `X-Client-Request-Id`. These headers help support trace requests without changing billing or routing.

When `idempotencyKey` is provided, the SDK sends it as `Idempotency-Key`. Use a unique value for each logical retry-safe operation. Idempotency keys must be non-blank, ASCII, 255 characters or less, and must not contain secrets or personal data.

Successful JSON object responses include `_request_id` when the gateway returns `x-request-id`. Streaming responses expose the same value as `stream.requestId`, malformed stream frames raise `RunInfraStreamParseError` with that request id, and binary audio responses expose it as `response.requestId`. Log that value with production errors and customer support reports.

## Webhook verification

Public webhook delivery routes are not shipped yet, but the SDK includes local verification helpers for signed RunInfra webhook deliveries once you receive them in your own server. Always verify the exact raw body before parsing JSON. The `RunInfra-Signature` timestamp must be a non-negative integer Unix second.

```ts
import {
  WebhookVerificationError,
  constructWebhookEvent,
  verifyWebhookSignature,
} from "@runinfra/sdk";

const webhookSecret = process.env.RUNINFRA_WEBHOOK_SECRET;
if (!webhookSecret?.trim()) throw new Error("Set RUNINFRA_WEBHOOK_SECRET before verifying webhook events.");

const event = constructWebhookEvent({
  payload: rawBody,
  signatureHeader: request.headers.get("RunInfra-Signature") ?? "",
  secret: webhookSecret,
});
```

`constructWebhookEvent` verifies the signature, checks timestamp tolerance, and parses JSON. Use `verifyWebhookSignature` when your framework parses JSON separately and you only need to validate the raw delivery. Invalid signatures, stale timestamps, and invalid webhook JSON raise `WebhookVerificationError`.

## OpenAI-compatible clients

OpenAI-compatible clients can use the same verified base URL:

```ts
import OpenAI from "openai";

const apiKey = process.env.RUNINFRA_API_KEY;
if (!apiKey) throw new Error("Set RUNINFRA_API_KEY before running this snippet.");

const client = new OpenAI({
  apiKey,
  baseURL: "https://api.runinfra.ai/v1/pipe_123",
});
```

## Production promotion

Local package tests prove SDK shape, retry behavior, streaming parsing, typed
errors, package contents, version sync, and trusted-publishing workflow policy.
They do not prove that a newly optimized deployment is ready for customers.
This public repo now includes live-canary runners for both SDKs. Non-strict
runs report skipped rows when live model env vars are missing. Strict runs fail
on any skipped or failed row and are required before GA promotion.

For production promotion from this repo, run these local checks from the
repository root before opening a release PR:

```bash
node scripts/verify-workflow-policy.mjs
node scripts/verify-version-sync.mjs
pnpm --dir typescript install --frozen-lockfile
pnpm --dir typescript exec tsc -p tsconfig.json --noEmit
pnpm --dir typescript test
pnpm --dir typescript build
pnpm --dir typescript pack
node scripts/verify-npm-package.mjs typescript/runinfra-sdk-*.tgz
python -m pip install -r python/requirements-dev.txt
python -m pytest python/tests -q
python -m build python
python scripts/verify-python-package.py python/dist
python -m twine check python/dist/*
node scripts/verify-clean-installs.mjs --package both --mode artifact
node scripts/run-sdk-live-canaries.mjs --package-source artifact --strict --report artifacts/sdk/live-canary.json
```

Then trigger a GitHub dry-run publish from `main`:

```bash
gh workflow run publish.yml --repo RightNow-AI/runinfra-sdk --ref main -f package=both -f dry_run=true -f confirm_version=<version>
```

Actual publishing must use the same workflow with `dry_run=false` after CI,
review, and environment approval. Do not use npm or PyPI tokens. OIDC trusted
publishing is the only supported publish path.

A real publish must also prove registry install/import of the exact released
version. The publish workflow runs per-package registry checks after each
successful publish; for manual post-publish verification:

```bash
node scripts/verify-clean-installs.mjs --package both --mode registry --version <version>
```

Run the strict live canary matrix against the exact production gateway,
workspace key, pipeline key, and deployed models that will serve customers. See
the root `LIVE-CANARIES.md` for required env vars, strict TS/Python row parity,
full-stream terminal-event checks, idempotency replay-evidence requirements,
and redacted report rules. GA still requires live coverage for LLM, embeddings,
image, TTS, ASR, and voice pipeline surfaces, plus explicit evidence that the
smoke keys and temporary canary resources were removed.

Co-located voice pipelines are available through the native `client.voice.pipeline.create()` helper on pipeline-scoped keys. The helper posts binary audio to the pipeline-scoped `/pipeline` route and returns the JSON transcript / response envelope. Public webhook create/list calls are intentionally unavailable until their gateway routes are verified, and the SDK throws `UnsupportedOperationError` locally for those webhook capabilities without making a request.

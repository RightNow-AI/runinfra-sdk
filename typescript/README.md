# RunInfra TypeScript SDK

Access optimized RunInfra deployments through the verified public gateway.

Requires Node.js 18 or newer.

## Install

```bash
npm install @runinfra/sdk
```

## Modality status (v0.1.1)

This SDK is in **beta**. The surfaces below have different verification levels:

| Modality | Surface | Status |
|---|---|---|
| LLM | `client.chat.completions.create`, `client.responses.create` | Beta, contract-tested |
| Embeddings | `client.embeddings.create` | Beta, contract-tested |
| Images | `client.images.generate` | **Experimental**, not live-canary verified |
| Audio (TTS) | `client.audio.speech.create` | **Experimental**, not live-canary verified |
| Audio (ASR) | `client.audio.transcriptions.create` | **Experimental**, not live-canary verified |
| Webhooks | `client.webhooks.*` | Local verification helpers only; remote delivery not shipped |
| Voice pipeline | `client.voice.pipeline.create` | Not shipped; throws `UnsupportedOperationError` |

The HTTP envelopes for experimental surfaces match the OpenAI API contract,
but we haven't yet completed a full end-to-end live-canary deployment for
those modalities in the public gateway. They will reach GA in v1.0.0 once
the canary suite covers all five modalities. Test against your own deployed
models before using experimental surfaces in production.

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

Local package tests prove SDK shape, retry behavior, streaming parsing, and
typed errors. They do not prove that a newly optimized deployment is ready for
customers. For production promotion, run the strict live SDK canary gate from
the RunPipe repo against the same base URL and API key you plan to expose. The gate starts with `test:sdk-live-api-key`, which verifies the plaintext key hashes to an active workspace-scoped `api_keys` row before any paid inference canary runs:

```bash
pnpm verify:sdk-release
pnpm test:sdk-canary:live -- --print-env-template
pnpm test:sdk-canary:live -- --env-file .env.sdk-live.local --print-env-status
pnpm sync:sdk-live-env -- --source .env.local --target .env.sdk-live.local
pnpm discover:sdk-live-targets -- --env-file .env.sdk-live.local --probe-inference --report artifacts/sdk/live-targets-discovery.json
pnpm bootstrap:sdk-live-key -- --env-file .env.sdk-live.local
pnpm discover:sdk-live-targets -- --env-file .env.sdk-live.local --probe-inference --report artifacts/sdk/live-targets-discovery.json
pnpm prepare:sdk-live-env -- --discovery-report artifacts/sdk/live-targets-discovery.json --output .env.sdk-live.local
pnpm discover:sdk-live-targets -- --env-file .env.sdk-live.local --probe-inference --report artifacts/sdk/live-targets-discovery.json
pnpm verify:sdk-live-targets -- --env-file .env.sdk-live.local --require-available --discovery-report artifacts/sdk/live-targets-discovery.json
pnpm test:sdk-canary:live -- --env-file .env.sdk-live.local --check-env-only
pnpm test:sdk-canary:live -- --env-file .env.sdk-live.local --discovery-report artifacts/sdk/live-targets-discovery.json --report artifacts/sdk/live-canary.json
pnpm verify:sdk-live-report -- artifacts/sdk/live-canary.json
pnpm test:sdk-canary -- --env-file .env.sdk-live.local --report artifacts/sdk/native-focused-smoke.json
pnpm test:openai-compat -- --env-file .env.sdk-live.local --report artifacts/sdk/openai-focused-smoke.json
pnpm verify:sdk-goal -- --release-report artifacts/sdk/release-verification.json --live-report artifacts/sdk/live-canary.json --live-targets-report artifacts/sdk/live-targets-discovery.json --env-check-report artifacts/sdk/live-canary-env-check.json --focused-smoke-report artifacts/sdk/native-focused-smoke.json --openai-focused-smoke-report artifacts/sdk/openai-focused-smoke.json --report artifacts/sdk/goal-readiness.json
pnpm verify:sdk-publish -- --release-report artifacts/sdk/release-verification.json --goal-report artifacts/sdk/goal-readiness.json --live-report artifacts/sdk/live-canary.json --live-targets-report artifacts/sdk/live-targets-discovery.json --env-check-report artifacts/sdk/live-canary-env-check.json --focused-smoke-report artifacts/sdk/native-focused-smoke.json --openai-focused-smoke-report artifacts/sdk/openai-focused-smoke.json --report artifacts/sdk/publish-readiness.json
```

Save the printed template as `.env.sdk-live.local`; it is ignored by git and
should contain the real production gateway, workspace-scoped API key, database
URL, pipeline-scoped API key for the optimized LLM pipeline, `RUNPOD_API_KEY`,
deployed model IDs, the optimized LLM `TEST_PIPELINE_ID`, TTS proof inputs, and
ASR clip path. `RUNPOD_API_KEY` is
used only by discovery to prove checked RunPod endpoint inventory. A checked
inventory needs endpointCount greater than zero, and `endpointCount: 0` blocks
promotion even if old database rows still mention active deployments. Discovery
also blocks any selected target with `endpoint_not_in_runpod_inventory` and
emits `runpod_endpoint_inventory_empty` when RunPod returns no endpoints. For
operator handoffs, set optional `RUNPOD_EXPECTED_ENDPOINT_IDS` to a
comma-separated list of endpoint IDs. Discovery compares those IDs against the
same checked inventory and reports only redacted verified or missing endpoint
IDs, so a wrong RunPod account/scope becomes an explicit blocker.
For TTS, set either `TEST_TTS_VOICE` or both `TEST_TTS_REF_AUDIO` and
`TEST_TTS_REF_TEXT` for Base/voice-cloning models.
`sync:sdk-live-env` copies `RUNPOD_API_KEY` from the source env file when it is
present. If you keep the RunPod key only in the shell, discovery uses that
process value instead of the generated placeholder in `.env.sdk-live.local`.
Use `--print-env-status` before running the canary to see missing, placeholder,
or invalid fields without printing API keys, database URLs, or file paths. Use `pnpm sync:sdk-live-env -- --source .env.local --target .env.sdk-live.local` to copy whitelisted local values such as `DATABASE_URL` without printing secrets, then use `pnpm discover:sdk-live-targets -- --env-file .env.sdk-live.local --probe-inference --report artifacts/sdk/live-targets-discovery.json` to inspect
which `active_verified` deployments can satisfy strict modality coverage without
printing API keys, key hashes, or database credentials. Deployments that are
close but not promotable appear under redacted `nearEligibleTargets` with
reasons such as `status_not_active_verified`, `missing_inference_url`, or
`missing_endpoint_id`. The discovery report also includes `nextActions`, so
deployment and SDK agents can follow safe commands without scraping error text.
A skipped probe is diagnostic only. It means discovery intentionally avoided a
live inference call after an earlier eligibility failure; only `passed` probes can promote `targets_available`.
After discovery reports eligible `active_verified` targets, `pnpm bootstrap:sdk-live-key -- --env-file .env.sdk-live.local` can create a workspace-scoped key for that workspace, store only its hash in the database, and write the plaintext once into the ignored live env file without printing it. Rerun discovery after bootstrap so the report proves the selected workspace now has an active workspace-scoped key.
When discovery is complete, use
`pnpm prepare:sdk-live-env -- --discovery-report artifacts/sdk/live-targets-discovery.json --output .env.sdk-live.local`
to fill the deployment model IDs and the optimized LLM `TEST_PIPELINE_ID`, then rerun `discover:sdk-live-targets` against the prepared env file.
`prepare:sdk-live-env` cannot recover a one-time plaintext pipeline secret. Set
`RUNINFRA_PIPELINE_API_KEY` from the Deploy tab for `TEST_PIPELINE_ID` before
strict live canaries, while keeping `RUNINFRA_API_KEY` workspace-scoped for
billing and flat-route verification.
Before running live canaries, run
`pnpm verify:sdk-live-targets -- --env-file .env.sdk-live.local --require-available --discovery-report artifacts/sdk/live-targets-discovery.json`
against the prepared-env discovery report to validate that it is redacted, same-workspace, uses exact live env values, and only promotes callable `active_verified` targets.
If the output file already has `RUNINFRA_API_KEY`, `RUNINFRA_PIPELINE_API_KEY`,
`DATABASE_URL`, `TEST_ASR_FILE`, or local TTS reference inputs, the helper
preserves them and does not print them.

That gate must cover LLM, embeddings, image, TTS, and ASR endpoints before the
deployment is treated as production verified. Those strict modality targets must
be distinct deployed model IDs in the same workspace, because the promotion
canary uses one workspace-scoped key and then proves billing for every reported
model. The generated live report also records the SDK version and source digest,
so stale canaries cannot promote a newer SDK build.
Focused `pnpm test:sdk-canary -- --report ...` smoke reports also record the
same SDK / Docs / Engine source digest and stay redacted. The raw
OpenAI-compatible focused smoke writes `artifacts/sdk/openai-focused-smoke.json`
and the native SDK smoke writes `artifacts/sdk/native-focused-smoke.json`.
`verify:sdk-goal` rejects either focused smoke report when it was generated from older source,
so focused LLM debugging evidence cannot be reused as fresh promotion evidence.
Each canary result also records redacted `checks` for the required proof checks
it emitted. If a canary exits successfully but misses a required proof line, the
strict report records `missingChecks` and stays blocked. The runner only counts
a proof line when the child canary prints `[ OK ] <required check>`; `[FAIL]` lines do not satisfy promotion evidence. The proof set covers model discovery
and retrieval, LLM responses and streaming,
pipeline-scoped native SDK responses, OpenAI-compatible pipeline-scoped `/v1/responses`, embeddings vectors, image data, TTS audio bytes, ASR transcription text,
OpenAI-compatible auth and error paths, native SDK typed `AuthenticationError`
mapping, request ID propagation, unsupported webhook guards, API key scope, and
billing usage verification. OpenAI-compatible security checks also prove request tracing, HSTS, `nosniff`, path traversal blocking, invalid model 404, missing model 400, and auth failures before publish promotion can pass.
The live-target gate also requires checked RunPod endpoint inventory before
promotion. `selectedTargets.*.runpodEndpointVerified` must be true for every
strict modality.

Use registry trusted publishing first. Do not provide NPM or PyPI publish tokens.
Registry tokens are not used; publish through GitHub trusted publishing only. If
trusted publishing is unavailable, do not publish until the registry identity is fixed.
The publish-readiness report ties the local release verification,
goal-readiness report, live-target discovery report, and strict live canary
report, plus both focused smoke reports, to the same source digest.
The TypeScript package also runs the same publish-readiness gate from
`prepublishOnly`, so a direct `npm publish` is blocked until that report passes.
Use `pnpm prepare:sdk-publish` to build the npm package, Python wheel, and
Python sdist only after publish readiness passes; the command writes a
source-digest-tied manifest with artifact SHA-256 hashes, byte counts, and
checksummed release / goal / live-target / live-canary proof reports at
`artifacts/sdk/publish/publish-artifacts.json`.
Use `pnpm publish:sdk -- --dry-run` to validate that manifest and print the npm
trusted-publishing and PyPI action handoff without sending packages. The guarded publish wrapper
refuses `--execute` outside CI, validates artifact checksums again, and supports
npm trusted publishing through GitHub OIDC on the Node 22.14.0 publish workflow;
PyPI should be uploaded by `pypa/gh-action-pypi-publish` in the `SDK Publish`
workflow.
GitHub Actions has two SDK-only workflows for the same path. `SDK Release Gate`
runs `pnpm verify:sdk-release` and requires `RUNINFRA_SDK_CI_TOKEN` with
read-only access to the docs and Engine contract repositories. `SDK Publish` is
manual only, defaults to `publish: false`, runs `verify:sdk-release`, creates
the strict live SDK env from GitHub secrets, discovers `active_verified` targets,
prepares the modality env, runs strict live canaries, verifies goal and publish
readiness, prepares artifacts, runs `publish:sdk -- --dry-run`, then uploads the
proof reports and package artifacts. The verification job has no registry OIDC permission;
the npm and PyPI publish jobs download the checked artifacts and are the only
jobs with registry trusted publishing identity. The npm publish job uses GitHub environment `npm`;
the PyPI publish job revalidates the publish manifest before upload and uses GitHub environment `pypi`. The live proof secrets are
`RUNINFRA_SDK_LIVE_API_KEY`, `RUNINFRA_SDK_LIVE_DATABASE_URL`, `RUNPOD_API_KEY`, and
`RUNINFRA_SDK_LIVE_ASR_FILE_BASE64`; voice-less Base TTS canaries can also set
`RUNINFRA_SDK_LIVE_TTS_REF_AUDIO` and `RUNINFRA_SDK_LIVE_TTS_REF_TEXT`. Only
after those gates pass should a maintainer rerun it with `publish: true`; npm
and PyPI must use trusted publishers.
`pnpm verify:sdk-release` also runs SDK secret hygiene and fails if non-test
handoff docs or release files contain full-shaped RunInfra keys, service tokens,
or package publish tokens.

Co-located voice pipelines are available through the native `client.voice.pipeline.create()` helper on pipeline-scoped keys. The helper posts binary audio to the verified `/pipeline` route and returns the JSON transcript / response envelope. Public webhook create/list calls are intentionally unavailable until their gateway routes are verified, and the SDK throws `UnsupportedOperationError` locally for those webhook capabilities without making a request.

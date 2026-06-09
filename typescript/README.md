# RunInfra TypeScript SDK

Access optimized RunInfra deployments through the verified public gateway.

Requires Node.js 18 or newer.

## Install

```bash
npm install @runinfra/sdk
```

## Modality status (v0.1.4)

This SDK is in **beta**. The surfaces below have different verification levels:

| Modality | Surface | Status |
|---|---|---|
| LLM | `client.chat.completions.create`, `client.responses.create` | Beta, contract-tested. Current 0.1.4 promotion artifacts are not strict-live green; publish requires fresh production artifact canaries with zero skipped or failed rows |
| Embeddings | `client.embeddings.create` | Beta, contract-tested. Not strict live-canary verified in the current promotion artifacts |
| Images | `client.images.generate` | **Experimental**, not live-canary verified |
| Audio (TTS) | `client.audio.speech.create` | **Experimental**, not live-canary verified |
| Audio (ASR) | `client.audio.transcriptions.create` | **Experimental**, not live-canary verified |
| Webhooks | `client.webhooks.verifySignature`, `client.webhooks.constructEvent`, `verifyWebhookSignature`, `constructWebhookEvent` | Local verification helpers only; remote delivery not shipped |
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

The TypeScript SDK targets Node.js 18 or newer. RunInfra API keys are bearer
secrets. Do not put `RUNINFRA_API_KEY` in browser code and do not initialize
this SDK in public client bundles with a secret API key. The SDK fails closed
when it detects a browser runtime; keep calls on a Node.js server route,
backend proxy, API service, or backend job. Browser apps should call your own
server first, then your server calls RunInfra with the workspace or
pipeline-scoped key. Ephemeral browser tokens are not shipped in v0.1.4; do not
invent a direct browser token flow until it has a separate scoped-token design,
expiry, audit logging, and live canary coverage. If you are deliberately using
a controlled non-public browser-like runtime, pass `dangerouslyAllowBrowser:
true` and own that risk.

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

Breaking out of the `for await` loop cancels the underlying SSE reader and
releases the reader lock. If you manually advance the stream iterator, call
`return()` on that iterator when you stop early so local response resources are
released. Streaming transport-level backend cancellation is best effort, and
streaming calls are not automatically retried.

RunInfra `/v1/responses` is a chat-completions compatibility adapter. The gateway converts supported `input` and `instructions` values into chat messages, forwards the supported request through the chat-completions serving path, and rewraps the result into a Responses-style envelope. It does not claim full OpenAI Responses state, include, reasoning, tool, conversation-item, or background-job semantics.

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
The GA canary matrix has dedicated live-gated rows for the subset that must
pass before GA. These rows will be treated as verified only after the strict live canaries pass:
`openai.params.chat.completions`, `openai.params.chat.stream_options`,
`openai.params.responses`, and `openai.params.embeddings`, plus the live-gated
`openai.params.images` row for
exact output-format coverage while sending an explicit image size to the
backend, the live-gated `openai.params.audio.speech` row for TTS
`response_format` request coverage with binary audio output using `mp3`,
`opus`, `aac`, `flac`, `wav`, or `pcm`, and the live-gated
`openai.params.audio.transcriptions` row for ASR `language`, `prompt`, and
`response_format` request coverage.

Live-gated native SDK subset:

- Chat Completions: `model`, `messages`, `stream`, `temperature`, `top_p`,
  `max_tokens`, `stop`, `presence_penalty`, `frequency_penalty`, `user`, and
  `metadata`; streaming usage chunks are covered separately with
  `stream_options.include_usage`.
- Responses: `model`, `input`, `stream`, `instructions`, `temperature`,
  `top_p`, `tools`, `tool_choice`, `response_format`, and `max_output_tokens`.
- Embeddings: `model`, `input`, `encoding_format: "float"`, and `dimensions`
  when the deployed embedding backend advertises dimension control.
- Images: `model`, `prompt`, `n`, plus optional `size` and `response_format`
  when the deployed image backend advertises them.
- Image `quality`, `style`, and `user` are typed pass-through OpenAI-style
  options. They are not GA-verified until a strict image canary row asserts
  backend support for them.
- Audio speech: `model`, `input`, `voice` or `ref_audio` plus `ref_text`, and
  optional `task_type` and `response_format`.
- Audio transcriptions: `model`, `file`, `filename`, optional `language`,
  optional `prompt`, and JSON response formats only.

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

LLM pass-through options are typed for parity with the Python SDK and OpenAI-style
request shapes, but are not GA-verified until strict canary rows assert backend support for each behavior.
Embedding `user`, TTS `speed`, and ASR `temperature` are typed pass-through
options for SDK parity, but are not GA-verified until strict modality canaries
assert backend support.

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

`RunInfraAudioResponse.stream()` exposes the native `ReadableStream<Uint8Array>`
from `fetch` without buffering it. Use it for large TTS responses when the caller
owns `getReader()`, cancellation, and slow-consumer backpressure. The SDK does
not auto-retry or replay binary TTS streams; use `arrayBuffer()` or `blob()` when
you want SDK read-timeout wrapping for a finite body.

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

The SDK retries transient transport failures and `408`, `409`, `429`, `500`, `502`, `503`, and `504` responses for safe `GET` requests. Charge-bearing `POST` inference requests retry only when you provide `idempotencyKey`, and automatic POST retries are limited to non-streaming JSON calls whose gateway responses can be replayed safely. Only `responses.create()` and non-streaming `chat.completions.create()` are currently auto-retry replay-safe. Embeddings, images, streaming calls, binary TTS responses, and multipart ASR uploads are sent once even when you provide an idempotency key. Keep `maxRetries: 0` for any cost-sensitive operation whose gateway replay behavior has not been proven by the strict idempotency canary. Automatic retries honor reasonable `Retry-After` values up to 60 seconds when the header is a plain integer second value or HTTP-date, then fall back to bounded exponential backoff. The SDK does not retry authentication errors, insufficient credits, or unsupported operations.

For replay-safe operations, if the gateway successfully finishes a request but the response body is too large to replay from the idempotency cache, later calls with the same `idempotencyKey` return `idempotency_replay_unavailable` without running or charging the inference again.

`timeoutMs` must be positive, `maxRetries` must be a non-negative integer, and `retryBaseMs` must be non-negative. Unknown per-request option keys are rejected so typos do not silently disable idempotency, tracing, timeout, or retry behavior. Invalid values throw `RunInfraError` with `type: "invalid_request_options"` before any network request is sent.

## Request validation

Required request fields are validated before any network request is sent. The model must be a non-blank string, chat messages must be a non-empty array, each chat message must be an object with a non-empty role, Responses input must be a non-empty string or array, Responses input array items must be objects, JSON request bodies must be serializable and contain only finite numbers, embedding input must be a non-empty string or array of non-empty strings, TTS input and image prompts must be non-empty strings, and ASR file must be a non-empty Blob. ASR multipart filenames are validated before the FormData body is built. Invalid request values throw `RunInfraError` with `type: "invalid_request_options"` and do not reach the gateway or billing path.

Use per-request options when a call needs a shorter timeout, a trace ID, or a retry-safe idempotency key.
TypeScript request interfaces are closed around typed fields, and unknown direct request fields are rejected before any network request is sent. Use `extraBody` in request options for deliberate JSON body extensions, such as an unsupported-parameter canary. `extraBody` is only accepted on JSON body requests. `extraBody` cannot override typed request fields and is validated before the request is sent.
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

The SDK exposes `AuthenticationError`, `PermissionDeniedError`, `RateLimitError`, `InsufficientCreditsError`, `DeploymentError`, `ModelNotFoundError`, `RunInfraTimeoutError`, `RunInfraConnectionError`, and `RunInfraStreamParseError`. `UnsupportedOperationError` remains exported for compatibility with older v0.1.x code, but current public helpers do not raise it.
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

Successful JSON object responses include `_request_id` when the gateway returns `x-request-id`. Streaming responses expose the same value as `stream.requestId`, malformed stream frames raise `RunInfraStreamParseError` with that request id, and binary audio responses expose it as `response.requestId`. Gateway errors expose `requestId`, `type`, and, when returned by the API, OpenAI-style `code` and `param` metadata such as `unsupported_parameter` and `dimensions`. Log the request id with production errors and customer support reports.

## Webhook verification

Public webhook delivery routes are not shipped yet, so webhook delivery create/list methods are not part of the GA public SDK surface. The SDK includes local verification helpers for signed RunInfra webhook deliveries once you receive them in your own server. Always verify the exact raw body before parsing JSON. The `RunInfra-Signature` timestamp must be a non-negative integer Unix second.

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

The publish workflow builds the npm tarball, Python wheel, and Python sdist once
in `build-artifacts`, uploads them as
`runinfra-sdk-promoted-artifacts`, and reuses those files for
`promotion-gate`, `publish-npm`, and `publish-pypi`. A real publish runs the strict promotion gate before either registry job can start, then publishes the same downloaded artifacts. `dry_run=false` cannot bypass `promotion-gate`.
Dry runs build and scan artifacts but do not run live canaries or publish.

The artifact clean-install gate imports the npm tarball, the Python wheel, and
an sdist-built Python wheel in separate disposable consumer environments. The
sdist install uses the canonical PyPI index only for build-system requirements,
and successful pip output is suppressed so CI logs do not expose local paths.

CI canary fixtures should be scoped repository or environment secrets.
`RUNINFRA_ASR_FIXTURE_BASE64` and
`RUNINFRA_VOICE_PIPELINE_AUDIO_BASE64` are decoded on the GitHub runner into
local fixture paths before the strict gate runs. Reports record only redacted
presence/path status and artifact hashes, not the base64 fixture values.

For production promotion from this repo, run these local checks from the
repository root before opening a release PR:

```bash
node scripts/verify-workflow-policy.mjs
node scripts/verify-github-security-status.mjs --repo RightNow-AI/runinfra-sdk
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
node scripts/run-sdk-live-canaries.mjs --verify-surface-coverage
node scripts/run-sdk-live-canaries.mjs --preflight --strict --report artifacts/sdk/live-canary-readiness.json
node scripts/run-sdk-live-canaries.mjs --package-source artifact --strict --report artifacts/sdk/live-canary.json
node scripts/verify-promotion-reports.mjs --readiness artifacts/sdk/live-canary-readiness.json --live artifacts/sdk/live-canary.json --artifacts-root .
```

If canary inputs live in a local env file, load it through the runner:

```bash
node scripts/run-sdk-live-canaries.mjs --write-env-template .env.sdk-live.local
node scripts/run-sdk-live-canaries.mjs --runinfra-env-file <path-to-env-file> --preflight --strict --report artifacts/sdk/live-canary-readiness.json
```

`--write-env-template <path-to-env-file>` creates a static private template
with canonical `RUNINFRA_*` names, safe defaults, blank placeholders, and
commented GitHub fixture-secret names. It never copies current env values and
refuses to overwrite an existing file unless `--force-env-template` is passed.
After a blocked preflight, create a redacted missing strict live-canary env
patch:

```bash
node scripts/run-sdk-live-canaries.mjs --readiness-report artifacts/sdk/live-canary-readiness.json --write-missing-env-template .env.sdk-live.missing.local
```

The missing strict live-canary env patch contains only missing
placeholders/defaults. It never diffs an existing env file, never copies current
env values, and is not promotion evidence.

Do not use Node's `--env-file` option in promotion commands.
`--runinfra-env-file <path-to-env-file>` keeps env-file parsing, explicit
shell-env precedence, and report redaction inside the canary runner.

Then trigger a GitHub dry-run publish from `main`:

```bash
gh workflow run publish.yml --repo RightNow-AI/runinfra-sdk --ref main -f package=both -f dry_run=true -f confirm_version=<version>
```

Actual publishing must use the same workflow with `dry_run=false` after CI,
review, and environment approval. Do not use npm or PyPI tokens. OIDC trusted
publishing is the only supported publish path.

A real publish must also prove registry install/import of the exact released
version. The publish workflow runs per-package registry checks after each
successful publish. For PyPI, registry mode verifies both the default install
and a forced `runinfra` source/sdist install from the canonical PyPI index.
For manual post-publish verification:

```bash
node scripts/verify-clean-installs.mjs --package both --mode registry --version <version>
```

Run the surface-coverage check before preflight so source/docs-declared public
SDK methods cannot ship without canary rows. Then run the strict preflight; it
fails without required model IDs, fixtures, expected transcripts, and
idempotency opt-in while keeping values redacted.
Then run the strict live canary matrix against the exact production gateway,
workspace key, pipeline key, and deployed models that will serve customers. See
the root `LIVE-CANARIES.md` for required env vars, strict TS/Python row parity,
full-stream terminal-event checks, idempotency replay-evidence requirements,
redacted report rules, and promotion report consistency checks. GA still
requires live coverage for LLM, embeddings, image, TTS, ASR, and voice pipeline
surfaces, plus explicit evidence that the smoke keys and temporary canary
resources were removed.

Co-located voice pipelines are available through the native `client.voice.pipeline.create()` helper on pipeline-scoped keys. The helper posts binary audio to the pipeline-scoped `/pipeline` route and returns the JSON transcript / response envelope. Public webhook delivery create/list calls are intentionally unavailable until their gateway routes are verified, and they are not exposed on the SDK webhook namespace.

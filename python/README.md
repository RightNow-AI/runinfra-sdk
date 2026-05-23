# RunInfra Python SDK

Access optimized RunInfra deployments through the verified public gateway.

Requires Python 3.9 or newer.

## Install

```bash
pip install runinfra
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

```python
import os
from runinfra import RunInfra

api_key = os.environ.get("RUNINFRA_API_KEY")
if not api_key:
    raise RuntimeError("Set RUNINFRA_API_KEY before running this snippet.")

client = RunInfra(api_key=api_key)
```

Use `pipeline_id` when the key or integration should be locked to one optimized pipeline.

```python
api_key = os.environ.get("RUNINFRA_API_KEY")
if not api_key:
    raise RuntimeError("Set RUNINFRA_API_KEY before running this snippet.")

client = RunInfra(
    api_key=api_key,
    pipeline_id="pipe_123",
)
```

The default base URL is `https://api.runinfra.ai/v1`.
`pipeline_id` is stripped and URL-encoded before it is added to the base URL. Use either `pipeline_id` with the default base URL, or a pipeline-scoped `base_url` such as `https://api.runinfra.ai/v1/pipe_123`. If both point to the same pipeline, the SDK keeps the URL scoped once.
RunPipe generated native SDK snippets prefer `pipeline_id` with the root `https://api.runinfra.ai/v1` base URL. OpenAI-compatible snippets use the pipeline-scoped base URL because the OpenAI SDK has no RunInfra pipeline option.
Custom base URLs must use `http` or `https`. Other schemes and malformed URLs are rejected before a bearer API key can be sent.
Remote custom base URLs must use `https`. Plain `http` is accepted only for local development hosts: `localhost`, `127.0.0.1`, `0.0.0.0`, and `[::1]`.
Custom base URLs must not include usernames or passwords.
Custom base URLs must not include query strings or fragments.

## Responses and streaming

```python
stream = client.responses.create(
    model="llama-3.1-8b",
    input="Hello",
    max_output_tokens=512,
    stream=True,
)

for event in stream:
    if event.get("type") == "response.output_text.delta":
        print(event.get("delta", ""), end="")

print(stream.request_id)
```

## Async Python runtimes

`RunInfra` is intentionally sync-only in v0.1.3 and uses Python's standard
library HTTP stack. FastAPI, Starlette, Django ASGI, and other asyncio apps
should run SDK calls in a worker thread, task queue, or background job so an
inference request does not block the event loop. Do not instantiate an
`AsyncRunInfra` client yet; that public surface is not shipped until it has the
same unit, streaming, live-canary, and package-install coverage as the sync
client.

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
`openai.params.chat.completions`, `openai.params.responses`, and
`openai.params.embeddings`, plus the live-gated `openai.params.images` row for
exact output-format coverage while sending an explicit image size to the
backend, and the live-gated `openai.params.audio.transcriptions` row for ASR
`language`, `prompt`, and `response_format` request coverage.

Live-gated native SDK subset:

- Chat Completions: `model`, `messages`, `stream`, `temperature`, `top_p`,
  `max_tokens`, `stop`, `presence_penalty`, `frequency_penalty`, `user`, and
  `metadata`.
- Responses: `model`, `input`, `stream`, `instructions`, `temperature`,
  `max_output_tokens`, and `metadata`.
- Embeddings: `model`, `input`, `encoding_format="float"`, and `dimensions`
  when the deployed embedding backend advertises dimension control.
- Images: `model`, `prompt`, `n`, plus optional `size` and `response_format`
  when the deployed image backend advertises them.
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

## Text to speech

TTS deployments can expose named voices or Base/reference-audio voice cloning.
Use `RUNINFRA_TTS_VOICE` when the deployment lists a voice or speaker. Use
`RUNINFRA_TTS_REF_AUDIO` and `RUNINFRA_TTS_REF_TEXT` when the deployment expects
reference-audio input.

```python
voice = os.environ.get("RUNINFRA_TTS_VOICE", "").strip()
ref_audio = os.environ.get("RUNINFRA_TTS_REF_AUDIO", "").strip()
ref_text = os.environ.get("RUNINFRA_TTS_REF_TEXT", "").strip()

if voice:
    speech_voice = {"voice": voice}
elif ref_audio and ref_text:
    speech_voice = {
        "ref_audio": ref_audio,
        "ref_text": ref_text,
        "task_type": os.environ.get("RUNINFRA_TTS_TASK_TYPE", "Base").strip() or "Base",
    }
else:
    raise RuntimeError("Set RUNINFRA_TTS_VOICE, or RUNINFRA_TTS_REF_AUDIO and RUNINFRA_TTS_REF_TEXT.")

audio = client.audio.speech.create(
    model="your-tts-model-id",
    input="Hello from your optimized RunInfra endpoint.",
    **speech_voice,
)
```

## Timeouts and retries

```python
import os

api_key = os.environ.get("RUNINFRA_API_KEY")
if not api_key:
    raise RuntimeError("Set RUNINFRA_API_KEY before running this snippet.")

client = RunInfra(
    api_key=api_key,
    timeout_seconds=60,
    max_retries=2,
    retry_base_seconds=0.25,
)
```

The SDK retries transient transport failures and `408`, `409`, `429`, `500`, `502`, `503`, and `504` responses for safe `GET` requests. Charge-bearing `POST` inference requests retry only when you provide `idempotency_key`, and automatic POST retries are limited to non-streaming JSON calls whose gateway responses can be replayed safely. That covers `responses.create()`, non-streaming `chat.completions.create()`, `embeddings.create()`, and `images.generate()`. Streaming calls, binary TTS responses, and multipart ASR uploads are sent once even when you provide an idempotency key. The gateway still binds idempotency keys for TTS and ASR, so a manual retry with the same key will not run or charge a second inference after the first request settles. Automatic retries honor reasonable `Retry-After` values up to 60 seconds when the header is a plain integer second value or HTTP-date, then fall back to bounded exponential backoff. The SDK does not retry authentication errors, insufficient credits, or unsupported operations.

If the gateway successfully finishes a request but the response body is too large to replay from the idempotency cache, later calls with the same `idempotency_key` return `idempotency_replay_unavailable` without running or charging the inference again.

`timeout_seconds` must be positive, `max_retries` must be a non-negative integer, and `retry_base_seconds` must be non-negative. Unknown per-request option keys are rejected so typos do not silently disable idempotency, tracing, timeout, or retry behavior. Python request option aliases cannot be mixed; choose either snake_case or camelCase for a given option. Invalid values raise `RunInfraError` with `type == "invalid_request_options"` before any network request is sent.

## Request validation

Required request fields are validated before any network request is sent. The model must be a non-blank string, chat messages must be a non-empty array, each chat message must be an object with a non-empty role, Responses input must be a non-empty string or array, Responses input array items must be objects, JSON request bodies must be serializable and contain only finite numbers, embedding input must be a non-empty string or array of non-empty strings, TTS input and image prompts must be non-empty strings, and ASR file must be bytes or bytearray. ASR multipart filenames, content types, and extra form field names and values are validated before the multipart body is built. Invalid request values raise `RunInfraError` with `type == "invalid_request_options"` and do not reach the gateway or billing path.

Use per-request options when a call needs a shorter timeout, a trace ID, or a retry-safe idempotency key.
Custom headers are for app metadata only. They cannot override SDK-controlled headers such as `Authorization`, `Content-Type`, `X-Client-Request-Id`, `Idempotency-Key`, `X-RunInfra-SDK`, or `X-RunInfra-SDK-Version`, and they cannot set transport or credential headers such as `Host`, `Cookie`, `Content-Length`, `Transfer-Encoding`, `Connection`, `Proxy-Authorization`, `Api-Key`, `X-API-Key`, `X-Auth-Token`, or `X-Access-Token`.

```python
import uuid

client.responses.create(
    model="llama-3.1-8b",
    input="Summarize this incident.",
    request_options={
        "client_request_id": str(uuid.uuid4()),
        "idempotency_key": str(uuid.uuid4()),
        "timeout_seconds": 20,
        "max_retries": 0,
    },
)
```

## Typed errors

The SDK exposes `AuthenticationError`, `PermissionDeniedError`, `RateLimitError`, `InsufficientCreditsError`, `DeploymentError`, `ModelNotFoundError`, `RunInfraTimeoutError`, `RunInfraConnectionError`, `RunInfraStreamParseError`, and `UnsupportedOperationError`.
`RateLimitError` includes `retry_after_seconds` when the gateway returns `Retry-After`.
`RunInfraStreamParseError` includes `request_id` when a malformed SSE frame came from a traced gateway response.
`RunInfraTimeoutError` also covers stalled streaming reads and default non-streaming body reads after headers arrive, and includes `request_id` when the response was traced.
`RunInfraConnectionError` also covers streaming body transport failures and default non-streaming body transport failures after headers arrive, and includes `request_id` when the response was traced.

## Traceability and typing

Every request includes `X-RunInfra-SDK: python`, `X-RunInfra-SDK-Version`, and `X-Client-Request-Id`. These headers help support trace requests without changing billing or routing.

When `idempotency_key` is provided, the SDK sends it as `Idempotency-Key`. Use a unique value for each logical retry-safe operation. Idempotency keys must be non-blank, ASCII, 255 characters or less, and must not contain secrets or personal data.

Successful JSON object responses include `_request_id` when the gateway returns `x-request-id`. Streaming responses expose the same value as `stream.request_id`, malformed stream frames raise `RunInfraStreamParseError` with that request id, and binary audio responses expose it as `audio.request_id`. Log that value with production errors and customer support reports.

The wheel ships `py.typed` so type checkers can inspect the package. Fixed-shape helpers expose `TypedDict` response contracts: `ModelListResponse`, `ModelObject`, `ResponsesCreateResponse`, `ChatCompletionResponse`, `EmbeddingResponse`, `TranscriptionResponse`, and `ImageGenerationResponse`. Stream-capable helpers are typed as either the JSON response contract or `RunInfraStream` when `stream=True`.

## Webhook verification

Public webhook delivery routes are not shipped yet, but the SDK includes local verification helpers for signed RunInfra webhook deliveries once you receive them in your own server. Always verify the exact raw body before parsing JSON. The `RunInfra-Signature` timestamp must be a non-negative integer Unix second.

```python
import os

from runinfra import (
    WebhookVerificationError,
    construct_webhook_event,
    verify_webhook_signature,
)

webhook_secret = os.environ.get("RUNINFRA_WEBHOOK_SECRET")
if not webhook_secret or not webhook_secret.strip():
    raise RuntimeError("Set RUNINFRA_WEBHOOK_SECRET before verifying webhook events.")

event = construct_webhook_event(
    payload=raw_body,
    signature_header=signature_header,
    secret=webhook_secret,
)
```

`construct_webhook_event` verifies the signature, checks timestamp tolerance, and parses JSON. Use `verify_webhook_signature` when your framework parses JSON separately and you only need to validate the raw delivery. Invalid signatures, stale timestamps, and invalid webhook JSON raise `WebhookVerificationError`.

## OpenAI-compatible clients

OpenAI-compatible clients can use the same verified base URL:

```python
import os
from openai import OpenAI

api_key = os.environ.get("RUNINFRA_API_KEY")
if not api_key:
    raise RuntimeError("Set RUNINFRA_API_KEY before running this snippet.")

client = OpenAI(
    api_key=api_key,
    base_url="https://api.runinfra.ai/v1/pipe_123",
)
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
node scripts/run-sdk-live-canaries.mjs --preflight --strict --report artifacts/sdk/live-canary-readiness.json
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

Run the strict preflight first; it fails without required model IDs, fixtures,
expected transcripts, and idempotency opt-in while keeping values redacted.
Then run the strict live canary matrix against the exact production gateway,
workspace key, pipeline key, and deployed models that will serve customers. See
the root `LIVE-CANARIES.md` for required env vars, strict TS/Python row parity,
full-stream terminal-event checks, idempotency replay-evidence requirements,
and redacted report rules. GA still requires live coverage for LLM, embeddings,
image, TTS, ASR, and voice pipeline surfaces, plus explicit evidence that the
smoke keys and temporary canary resources were removed.

Co-located voice pipelines are available through the native `client.voice.pipeline.create()` helper on pipeline-scoped keys. The helper posts binary audio to the pipeline-scoped `/pipeline` route and returns the JSON transcript / response envelope. Public webhook create/list calls are intentionally unavailable until their gateway routes are verified, and the SDK raises `UnsupportedOperationError` locally for those webhook capabilities without making a request.

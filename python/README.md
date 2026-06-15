# RunInfra Python SDK

Access optimized RunInfra deployments through the verified public gateway.

Requires Python 3.9 or newer.

## Install

```bash
pip install runinfra
```

## Modality status (v0.2.0)

This SDK is in **beta**. The surfaces below have different verification levels:

| Modality | Surface | Status |
|---|---|---|
| LLM | `client.chat.completions.create`, `client.responses.create` | Beta. Typed helpers for verified LLM and vision-language deployments. |
| Embeddings | `client.embeddings.create` | Beta. Typed helper for verified embedding deployments. |
| Images | `client.images.generate` | Preview. Available when the deployment exposes image generation. |
| Audio (TTS) | `client.audio.speech.create` | Preview. Available when the deployment exposes speech generation. |
| Audio (ASR) | `client.audio.transcriptions.create` | Preview. Available when the deployment exposes transcription. |
| Webhooks | `client.webhooks.verify_signature`, `client.webhooks.construct_event`, `verify_webhook_signature`, `construct_webhook_event` | Local verification helpers only; delivery management is outside the public SDK surface |
| Voice pipeline | `client.voice.pipeline.create` | Preview. Pipeline-scoped helper for co-located audio-to-response deployments. |

The dashboard only shows snippets for operations the selected deployment
supports. If a route is unsupported for a deployment, the SDK returns a typed
error instead of silently falling back to another operation.

## Create a client

Use a workspace-scoped key to reach verified active deployments through the `model` field.
In the RunInfra dashboard, open Settings, API Keys, Create key, and keep Scope set to Workspace.

The Deploy tab can create a pipeline-scoped key for one optimized pipeline.
The one-time secret is shown once after creation. Store it as `RUNINFRA_API_KEY`
for app snippets before leaving the page.

After an optimization run finishes, open the Deploy view from the dashboard.
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
RunInfra generated native SDK snippets prefer `pipeline_id` with the root `https://api.runinfra.ai/v1` base URL. OpenAI-compatible snippets use the pipeline-scoped base URL because the OpenAI SDK has no RunInfra pipeline option.
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

Close the active iterator when you stop consuming a stream early so local
response resources are released:

```python
iterator = iter(stream)
try:
    first = next(iterator)
finally:
    iterator.close()
```

Streaming transport-level backend cancellation is best effort, and streaming
calls are not automatically retried. The Python type surface overloads
`stream=True` calls for `client.chat.completions.create()` and
`client.responses.create()` to return `RunInfraStream`; non-stream calls keep
their typed response envelopes.

RunInfra `/v1/responses` is a chat-completions compatibility adapter. The gateway converts supported `input` and `instructions` values into chat messages, forwards the supported request through the chat-completions serving path, and rewraps the result into a Responses-style envelope. It does not claim full OpenAI Responses state, include, reasoning, tool, conversation-item, or background-job semantics.

## Async Python runtimes

`RunInfra` is intentionally sync-only in v0.2.0 and uses Python's standard
library HTTP stack. FastAPI, Starlette, Django ASGI, and other asyncio apps
should run SDK calls in a worker thread, task queue, or background job so an
inference request does not block the event loop. Do not instantiate an
`AsyncRunInfra` client; async client APIs are outside the current public SDK
surface.

For one-off calls inside an asyncio handler, move the blocking SDK call to the
default worker thread pool:

```python
import asyncio

result = await asyncio.to_thread(
    client.responses.create,
    model="llama-3.1-8b",
    input="Summarize this incident.",
)
```

For request paths that should return immediately, hand work to your framework's
background execution path or an external queue:

```python
from fastapi import BackgroundTasks, FastAPI

app = FastAPI()

def run_inference(prompt: str) -> None:
    client.responses.create(
        model="llama-3.1-8b",
        input=prompt,
        request_options={"timeout_seconds": 60, "max_retries": 0},
    )

@app.post("/jobs")
async def create_job(prompt: str, background_tasks: BackgroundTasks) -> dict[str, str]:
    background_tasks.add_task(run_inference, prompt)
    return {"status": "queued"}
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
The typed native SDK subset is:

- Chat Completions: `model`, `messages`, `stream`, `temperature`, `top_p`,
  `max_tokens`, `stop`, `presence_penalty`, `frequency_penalty`, `user`, and
  `metadata`; streaming usage chunks are covered separately with
  `stream_options.include_usage`.
- Responses: `model`, `input`, `stream`, `instructions`, `temperature`,
  `top_p`, `tools`, `tool_choice`, `response_format`, and `max_output_tokens`.
- Embeddings: `model`, `input`, `encoding_format="float"`, and `dimensions`
  when the deployed embedding backend advertises dimension control.
- Images: `model`, `prompt`, `n`, plus optional `size` and `response_format`
  when the deployed image backend advertises them.
- Image `quality`, `style`, and `user` are typed pass-through OpenAI-style
  options when the deployed image backend supports them.
- Audio speech: `model`, `input`, `voice` or `ref_audio` plus `ref_text`, and
  optional `task_type` and `response_format`.
- Audio transcriptions: `model`, `file`, `filename`, optional `language`,
  optional `prompt`, and JSON response formats only.

The native typed helpers do not claim GA support for tool calls, structured
JSON schema outputs, logprobs, seeds, service tiers, parallel tool calls,
Responses state/include/reasoning controls, embedding base64 output, image
streaming or partial images, audio streaming, audio translations, or direct
browser API-key use. Embedding
`encoding_format` values other than `"float"` and transcription
`response_format` values other than `"json"` or `"verbose_json"` are rejected
locally because they would not match the typed native SDK response objects.
Unsupported OpenAI-style body parameters must fail with a clear traced 4xx
gateway error.

LLM pass-through options are typed for parity with the TypeScript SDK and
OpenAI-style request shapes, but actual support depends on the deployed backend.
Embedding `user`, TTS `speed`, and ASR `temperature` are typed pass-through
options for SDK parity, but actual support depends on the deployed backend.

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

The SDK retries transient transport failures and `408`, `409`, `429`, `500`, `502`, `503`, and `504` responses for safe `GET` requests. Charge-bearing `POST` inference requests retry only when you provide `idempotency_key`, and automatic POST retries are limited to non-streaming JSON calls whose gateway responses can be replayed safely. Only `responses.create()` and non-streaming `chat.completions.create()` are currently auto-retry replay-safe. Embeddings, images, streaming calls, binary TTS responses, and multipart ASR uploads are sent once even when you provide an idempotency key. Keep `max_retries=0` for any cost-sensitive operation whose replay behavior is not documented as safe. Automatic retries honor reasonable `Retry-After` values up to 60 seconds when the header is a plain integer second value or HTTP-date, then fall back to bounded exponential backoff. The SDK does not retry authentication errors, insufficient credits, or unsupported operations.

For replay-safe operations, if the gateway successfully finishes a request but the response body is too large to replay from the idempotency cache, later calls with the same `idempotency_key` return `idempotency_replay_unavailable` without running or charging the inference again.

`timeout_seconds` must be positive, `max_retries` must be a non-negative integer, and `retry_base_seconds` must be non-negative. Unknown per-request option keys are rejected so typos do not silently disable idempotency, tracing, timeout, or retry behavior. Python request option aliases cannot be mixed; choose either snake_case or camelCase for a given option. Invalid values raise `RunInfraError` with `type == "invalid_request_options"` before any network request is sent.

Python request helpers expose explicit OpenAI-style keyword parameters instead of arbitrary `**kwargs`, so unknown direct request fields fail before any network request is sent. For deliberate gateway compatibility probes or newly rolled out gateway fields, pass an `extra_body` mapping on JSON body helpers. `extra_body` is only accepted on JSON body helpers. `extra_body` cannot override typed request fields such as `model`, `input`, or `messages`.

## Request validation

Required request fields are validated before any network request is sent. The model must be a non-blank string, chat messages must be a non-empty array, each chat message must be an object with a non-empty role, Responses input must be a non-empty string or array, Responses input array items must be objects, JSON request bodies must be serializable and contain only finite numbers, embedding input must be a non-empty string or array of non-empty strings, TTS input and image prompts must be non-empty strings, and ASR file must be non-empty bytes or bytearray. ASR multipart filenames and content types are validated before the multipart body is built. Invalid request values raise `RunInfraError` with `type == "invalid_request_options"` and do not reach the gateway or billing path.

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

The SDK exposes `AuthenticationError`, `PermissionDeniedError`, `RateLimitError`, `InsufficientCreditsError`, `DeploymentError`, `ModelNotFoundError`, `RunInfraTimeoutError`, `RunInfraConnectionError`, and `RunInfraStreamParseError`. `UnsupportedOperationError` remains exported for compatibility with older v0.1.x code, but current public helpers do not raise it.
`RateLimitError` includes `retry_after_seconds` when the gateway returns `Retry-After`.
`PermissionDeniedError.type` preserves a specific gateway discriminator on `403` responses when one is present (for example `byoc_plan_required` when a workspace below the deploy tier calls a BYOC-deployed endpoint); it falls back to `permission_denied`. Branch on `err.type` instead of matching the message string.
`InsufficientCreditsError` includes `current_balance_cents`, `required_cents`, and `topup_url` when the gateway returns them on a `402` response, so you can render an exact top-up prompt without parsing the message.
`RunInfraStreamParseError` includes `request_id` when a malformed SSE frame came from a traced gateway response.
`RunInfraTimeoutError` also covers stalled streaming reads and default non-streaming body reads after headers arrive, and includes `request_id` when the response was traced.
`RunInfraConnectionError` also covers streaming body transport failures and default non-streaming body transport failures after headers arrive, and includes `request_id` when the response was traced.

## Traceability and typing

Every request includes `X-RunInfra-SDK: python`, `X-RunInfra-SDK-Version`, and `X-Client-Request-Id`. These headers help support trace requests without changing billing or routing.

When `idempotency_key` is provided, the SDK sends it as `Idempotency-Key`. Use a unique value for each logical retry-safe operation. Idempotency keys must be non-blank, ASCII, 255 characters or less, and must not contain secrets or personal data.

Successful JSON object responses include `_request_id` when the gateway returns `x-request-id`. Streaming responses expose the same value as `stream.request_id`, malformed stream frames raise `RunInfraStreamParseError` with that request id, and binary audio responses expose it as `audio.request_id`. Gateway errors expose `request_id`, `type`, and, when returned by the API, OpenAI-style `code` and `param` metadata such as `unsupported_parameter` and `dimensions`. Log the request id with production errors and customer support reports.

The wheel ships `py.typed` so type checkers can inspect the package. Fixed-shape helpers expose `TypedDict` response contracts: `ModelListResponse`, `ModelObject`, `ResponsesCreateResponse`, `ChatCompletionResponse`, `EmbeddingResponse`, `TranscriptionResponse`, and `ImageGenerationResponse`. Stream-capable helpers are typed as either the JSON response contract or `RunInfraStream` when `stream=True`.

## Webhook verification

Webhook delivery management is outside the public SDK surface. The SDK includes local verification helpers for signed RunInfra webhook deliveries once you receive them in your own server. Always verify the exact raw body before parsing JSON. The `RunInfra-Signature` timestamp must be a non-negative integer Unix second.

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

## Voice pipelines and webhooks

Co-located voice pipelines are available through the native
`client.voice.pipeline.create()` helper on pipeline-scoped keys. The helper
posts binary audio to the pipeline-scoped `/pipeline` route and returns the JSON
transcript / response envelope.

Webhook delivery management is handled outside the public SDK surface. Local
signature verification helpers are available now.

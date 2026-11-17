# RunInfra Python SDK

Access optimized RunInfra deployments through the verified public gateway.

Requires Python 3.9 or newer.

## Install

```bash
pip install runinfra
```

## Modality status (v0.3.0)

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
| Batch | `client.batches.create`, `client.batches.list`, `client.batches.retrieve`, `client.batches.cancel`, `verify_batch_delivery` | Preview, from 0.3.0. Batch jobs for models that offer batch, with signed webhook deliveries. |

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

### When a stream fails or is cut

A stream is complete only when it carried its end marker: `[DONE]` on a chat
stream, `response.completed` on a Responses stream. The loop ends quietly in
that case alone. Otherwise the iteration raises, after it has yielded every
event that came first:

- `RunInfraStreamError` when the API reports a failure on the open stream: a
  frame that holds an `error` object, or a `response.failed` event on a
  Responses stream. It keeps the API's `type` and `code`, the request id as
  `request_id`, and `retryable` when the API marked the failure. Its `status`
  is `0`, because the failure arrived after the HTTP status.
- `RunInfraStreamIncompleteError` when the body ends without the end marker:
  the connection was cut or the stream was closed early.

Either way the answer is not whole, even though the HTTP status was 200. Keep
what was yielded only if a partial answer is useful to you. Closing the
iterator early raises nothing. Before 0.3.1 both cases ended the loop silently,
as if the answer were complete.

```python
from runinfra import RunInfraStreamError, RunInfraStreamIncompleteError

chat_stream = client.chat.completions.create(
    model="your-deployed-model-id",
    messages=[{"role": "user", "content": "Count from one to three."}],
    stream=True,
)

answer = ""
try:
    for chunk in chat_stream:
        if chunk["choices"]:
            answer += chunk["choices"][0]["delta"].get("content") or ""
except RunInfraStreamError as error:
    print("The stream failed.", error.code, error.request_id, error.retryable)
except RunInfraStreamIncompleteError as error:
    print("The stream was cut short.", error.request_id)
```

RunInfra `/v1/responses` is a chat-completions compatibility adapter. The gateway converts supported `input` and `instructions` values into chat messages, forwards the supported request through the chat-completions serving path, and rewraps the result into a Responses-style envelope. It does not claim full OpenAI Responses state, include, reasoning, tool, conversation-item, or background-job semantics.

## Async Python runtimes

`RunInfra` is intentionally sync-only in v0.3.0 and uses Python's standard
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
- `batches.create()`
- `batches.list()`
- `batches.retrieve(batch_id)`
- `batches.cancel(batch_id)`

## OpenAI-compatible parameter scope

The native SDK validates the minimum request fields locally, then forwards
OpenAI-style JSON or multipart fields that preserve the typed response shape.
The typed native SDK subset is:

- Chat Completions: `model`, `messages`, `stream`, `temperature`, `top_p`,
  `max_tokens`, `stop`, `presence_penalty`, `frequency_penalty`, `user`, and
  `metadata`; streaming usage chunks are covered separately with
  `stream_options.include_usage`.
- Chat Completions also takes, from 0.3.1, a keyword for each of the other
  request fields the API documents: `top_k`, `min_p`, `repetition_penalty`,
  `n`, `best_of`, `logit_bias`, `parallel_tool_calls`, `reasoning_effort`,
  `reasoning`, `include_reasoning`, `prompt_cache_key`, `service_tier`,
  `store`, `safety_identifier`, `modalities`, `audio`, `prediction`,
  `verbosity`, `web_search_options`, `moderation`, `functions`, and
  `function_call`. They are sent as given; whether a model accepts one depends
  on the model. Each of them is still accepted in `extra_body` too, where it
  had to go before, as long as the keyword is left out.
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

## Tool calls

`ChatMessage` types the whole tool-calling turn. An assistant message carries
the model's calls in `tool_calls`, and its `content` is `None` or left out when
it carries nothing else. Answer each call with a `tool` message
(`ChatToolMessage`) that repeats the call's `id` as `tool_call_id`. On a
stream, `delta["tool_calls"]` carries the pieces of each call
(`ChatCompletionStreamToolCallDelta`) and `delta["reasoning"]` the model's
thinking.

```python
import json
from typing import List

from runinfra import ChatMessage, ChatToolMessage

tools = [{
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get the current weather for a city",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
    },
}]
messages: List[ChatMessage] = [{"role": "user", "content": "What is the weather in Paris?"}]

first = client.chat.completions.create(model="your-deployed-model-id", messages=messages, tools=tools)
asked = first["choices"][0]["message"]
if asked.get("tool_calls"):
    # Send the whole assistant message back, then one tool message per call.
    messages.append(asked)
    for call in asked["tool_calls"]:
        arguments = json.loads(call["function"]["arguments"])
        result: ChatToolMessage = {
            "role": "tool",
            "tool_call_id": call["id"],
            "content": json.dumps({"city": arguments.get("city"), "temp_c": 21}),
        }
        messages.append(result)
    second = client.chat.completions.create(model="your-deployed-model-id", messages=messages, tools=tools)
    print(second["choices"][0]["message"].get("content"))
```

The arguments of a call arrive as a JSON string the model wrote: parse and
check them before you run anything. Tool calling depends on the model.

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

## Batch jobs

Preview, from 0.3.0. A batch job takes a JSONL file of chat completion requests and posts each answer to your webhook address. A job has a window of 24 hours. Lines run when the model has spare capacity. A line the job has not run when its window ends is counted `expired` and is not charged. Batch needs a workspace-scoped key and a model that offers batch.

```python
created = client.batches.create(
    model="deepseek-v4-1-flash-1017",
    input_url="https://example.org/batch/input.jsonl",
    destination={"type": "webhook", "url": "https://example.org/batch/answers"},
    max_cost_cents=100,
    window_hours=24,
    name="nightly-evals",
    request_options={"idempotency_key": "nightly-evals-2026-11-16"},
)

job = client.batches.retrieve(created["batch"]["id"])
print(job["batch"]["batch_state"], job["batch"]["errors"], job["batch"]["cost_microcents"])
```

Sending the same create again with the same `idempotency_key` and the same body answers the earlier job as a normal success: no error and no second job. The same key with a different body is refused with `409`.

- `model`, `input_url`, `destination`, and `max_cost_cents` are required. `max_cost_cents` is the most the job may cost, a whole number from 1 to 100,000,000. `window_hours` is 24, the only value and the default. `name` is a label of at most 64 characters.
- `input_url` is a public HTTPS link on port 443, at most 8,192 bytes, to a JSONL file of at most 50 MiB whose host serves byte ranges (signed links from the common storage services do). A signed link must stay valid until the job's window ends. `destination.url` is a public HTTPS address on port 443.
- Each line of the file is `{"custom_id": "...", "method": "POST", "url": "/v1/chat/completions", "body": {...}}`, at most 4 MiB. `custom_id` is unique in the file (1 to 512 characters) and `body` is a text-only, non-streaming chat completion body whose `model` is the job's model.
- The job starts by itself. It is answered in `batch_state` `validating` and moves through `checked` and `queued` to `running`; `completed`, `expired`, `cancelled`, and `failed` are final, and `end_reason` says why. `batches.retrieve()` adds `errors` (the lines the file check refused, by code, with their first line numbers) and `quote`.
- `failed` never includes an undelivered line, and once a job has ended the counts `succeeded`, `failed`, `expired`, `cancelled`, `undelivered`, and `lines_invalid` add up to `lines_total`.
- `batches.list(limit=..., cursor=..., state=..., model=...)` answers `{"batches": [...], "next_cursor": ...}`, newest first; pass `next_cursor` as `cursor` for the next page. `batches.cancel(batch_id)` answers `{"batch_id": ..., "batch_state": ...}` with `cancelled` or `cancelling`.

Before it answers, `batches.create()` posts a signed test delivery `{"id": "bdt_...", "test": true, "value": "..."}` to the destination address. The address passes only when it replies 2xx with a body that contains the posted `value`, within 20 seconds; otherwise the create is refused with `destination_unreachable`. Because of that test the call's default timeout is never below 30 seconds, whatever the client's `timeout_seconds`; a per-request `timeout_seconds` is used as given.

`batches.create()` is sent once unless you pass `idempotency_key`. With a key, transient failures are retried with the same key and body. `batches.cancel()` is always sent once. A `409` from a batch route is a final refusal and is never retried. A `503` that asks for a wait above 5 seconds in `Retry-After` is raised at once with `retry_after_seconds` set, so a call never blocks on a long wait; a `503` that asks for 5 seconds or less is asked again by the retry rule.

Every refusal of a batch route is a typed error that keeps the gateway's `code`, the `param` it names, `reason`, `retry_after_seconds` when the gateway sent `Retry-After`, and `request_id`:

```python
from runinfra import RunInfraError

try:
    client.batches.cancel(created["batch"]["id"])
except RunInfraError as error:
    if error.code == "batch_ended":
        pass  # The job had already ended.
    elif error.code == "flex_not_available":
        print(error.reason)  # "model", "partner", or "price"
    else:
        raise
```

The refusal codes are `batch_not_open` (`503`: ask again after the wait the error carries), `invalid_request`, `not_found`, `model_not_sold`, `flex_not_available`, `url_not_public`, `link_expires_too_soon`, `destination_unreachable`, `needs_funds`, `key_spend_limit_reached`, `batch_ended`, and `batches_scope_violation`. `model_not_sold` is a `ModelNotFoundError`; an unknown batch id is a plain `RunInfraError` with status `404` and code `not_found`. A `402` on a batch route is an `InsufficientCreditsError`; read `code` to tell `needs_funds` (the account has never added funds) from `key_spend_limit_reached` (this API key reached its own monthly limit; raise the key's limit or use another key). A file that is refused when it is read, after the create answered, ends the job `failed` with `check_error` `url_not_public`, `link_expires_too_soon`, `file_too_large`, `link_changed`, or `link_not_supported`.

### Verify batch deliveries

Each answered line arrives at your address as one signed `POST`. Copy the workspace's batch signing secret from the dashboard and verify the exact raw body before you use it.

```python
import os

from runinfra import verify_batch_delivery

signing_secret = os.environ.get("RUNINFRA_BATCH_SIGNING_SECRET")
if not signing_secret or not signing_secret.strip():
    raise RuntimeError("Set RUNINFRA_BATCH_SIGNING_SECRET before verifying batch deliveries.")

delivery = verify_batch_delivery(
    payload=raw_body,
    headers=request_headers,
    secret=signing_secret,
)

if delivery["test"]:
    # The create's test delivery: reply 2xx with a body that contains delivery["value"].
    reply_status, reply_body = 200, delivery["value"]
elif "error" in delivery:
    print(delivery["custom_id"] or f"line {delivery['line']}", delivery["error"]["code"])
    reply_status, reply_body = 204, ""
else:
    print(delivery["custom_id"], delivery["response"], delivery["cost"])
    reply_status, reply_body = 204, ""
```

`verify_batch_delivery` takes the raw request body (`bytes` or `str`, never an object you parsed and serialized again) and the request's headers in any case. It checks `webhook-signature`, which is `v1,` followed by the base64 HMAC-SHA-256 of `<webhook-id>.<webhook-timestamp>.<raw body>`, in constant time. The secret is `whsec_` followed by base64, and the HMAC key is the decoded bytes, so any Standard Webhooks library verifies the same deliveries. By default the delivery's `webhook-timestamp` must be within 300 seconds of your clock, so a captured delivery cannot be replayed later. Pass a number as `tolerance_seconds` for another tolerance, or `tolerance_seconds=None` to turn the check off; `now` sets the clock in Unix seconds. A failed check raises `WebhookVerificationError`.

The helper returns one of three typed shapes: `BatchTestDelivery` (`test` true), `BatchAnswerDelivery` with `custom_id`, `line`, `attempt`, the chat completion in `response`, `usage`, and `cost`, or `BatchErrorDelivery` with `error` for a line that failed after the job started. `id` is the same for the same line and attempt. Key your own writes on it. Any 2xx acknowledges a line. Each answered line is sent to the address once: if the address does not answer 2xx in time, the line is counted `undelivered`, it is not charged, and it is not sent again. So answer 2xx first and do slow work afterwards.

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

### Timeouts

When you set no `timeout_seconds`, a non-streamed call is given 750 seconds, and a streamed call is given 190 seconds to its response headers and to each later read. The API allows a whole response up to 740 seconds and a stream up to 180 seconds to its first token, so the defaults sit just above both. Your own setting wins: `timeout_seconds` on the client applies to every call, and `timeout_seconds` in a call's `request_options` wins over the client's. Before 0.3.1 the default was 120 seconds for every call, so a long answer the API was still writing was cut off by the SDK.

The timeout bounds the wait for the response headers and each later read. A custom `transport` receives a call's own `timeout_seconds` on the request, and `None` when the call named none, exactly as before: the defaults above are the standard-library transport's.

A call is never sent again after a timeout, even when it carries an `idempotency_key` and retries are left: the API may still be working on the first send. The call raises `RunInfraTimeoutError`. Its `client_request_id` is the `X-Client-Request-Id` the SDK sent, so the call can be found; `request_id` is set only when a response had begun. Before 0.3.1 a `GET` and a keyed call were sent again after a timeout.

### Retries

The SDK retries transient transport failures and `408`, `409`, `429`, `500`, `502`, `503`, and `504` responses for safe `GET` requests. Charge-bearing `POST` inference requests retry only when you provide `idempotency_key`, and automatic POST retries are limited to non-streaming JSON calls whose gateway responses can be replayed safely. Only `responses.create()` and non-streaming `chat.completions.create()` are currently auto-retry replay-safe. Embeddings, images, streaming calls, binary TTS responses, and multipart ASR uploads are sent once even when you provide an idempotency key. Keep `max_retries=0` for any cost-sensitive operation whose replay behavior is not documented as safe. The SDK does not retry authentication errors, insufficient credits, or unsupported operations.

For a call that is safe to send again, what the API says comes first:

- `x-should-retry` on the response and `error.retryable` in the error body are obeyed when present. `false` from either means the call is not sent again, whatever its status. `true` allows another send, whatever its status. When the API says nothing, the status decides, as listed above.
- The wait is read from `Retry-After-Ms` first, then from `Retry-After` (whole seconds or an HTTP date), and the SDK sleeps that long.
- A wait above 60 seconds is not slept. The error is raised at once with the wait as `retry_after_seconds`, so the call never blocks for minutes and you can plan the next attempt yourself. Before 0.3.1 such a wait was replaced by a short backoff, and the call was sent again sooner than the API asked.
- When the API names no wait, the SDK backs off exponentially from `retry_base_seconds`, with jitter, for at most 30 seconds. Before 0.3.1 the Python backoff had no jitter.
- The error body of a failed response is read before the SDK decides, because the API can mark the failure inside it.

Every typed error whose response named a wait carries it as `retry_after_seconds`, whatever its status, and `retryable` holds what the API said about asking again.

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

The SDK exposes `AuthenticationError`, `PermissionDeniedError`, `RateLimitError`, `InsufficientCreditsError`, `DeploymentError`, `ModelNotFoundError`, `RunInfraTimeoutError`, `RunInfraConnectionError`, `RunInfraStreamParseError`, `RunInfraStreamError`, and `RunInfraStreamIncompleteError`. `UnsupportedOperationError` remains exported for compatibility with older v0.1.x code, but current public helpers do not raise it.
Every typed error includes `retry_after_seconds` when its response named a wait (`Retry-After-Ms`, else `Retry-After`), and `retryable` when the API said whether asking again helps. Before 0.3.1 only `RateLimitError` and the batch routes' refusals carried the wait.
`RunInfraStreamError` and `RunInfraStreamIncompleteError` are raised while a stream is read; see "When a stream fails or is cut".
`RunInfraTimeoutError` includes `client_request_id`, the `X-Client-Request-Id` the SDK sent with the call that timed out.
`PermissionDeniedError.type` preserves a specific gateway discriminator on `403` responses when one is present (for example `byoc_plan_required` when a workspace below the deploy tier calls a BYOC-deployed endpoint); it falls back to `permission_denied`. Branch on `err.type` instead of matching the message string.
`InsufficientCreditsError` includes `current_balance_cents`, `required_cents`, and `topup_url` when the gateway returns them on a `402` response, so you can render an exact top-up prompt without parsing the message.
`RunInfraStreamParseError` includes `request_id` when a malformed SSE frame came from a traced gateway response.
`RunInfraTimeoutError` also covers stalled streaming reads and default non-streaming body reads after headers arrive, and includes `request_id` when the response was traced.
`RunInfraConnectionError` also covers streaming body transport failures and default non-streaming body transport failures after headers arrive, and includes `request_id` when the response was traced.

## Traceability and typing

Every request includes `X-RunInfra-SDK: python`, `X-RunInfra-SDK-Version`, and `X-Client-Request-Id`. These headers help support trace requests without changing billing or routing.

When `idempotency_key` is provided, the SDK sends it as `Idempotency-Key`. Use a unique value for each logical retry-safe operation. Idempotency keys must be non-blank, ASCII, 255 characters or less, and must not contain secrets or personal data.

Successful JSON object responses include `_request_id` when the gateway returns `x-request-id`. Streaming responses expose the same value as `stream.request_id`, malformed stream frames raise `RunInfraStreamParseError` with that request id, and binary audio responses expose it as `audio.request_id`. Gateway errors expose `request_id`, `type`, and, when returned by the API, OpenAI-style `code` and `param` metadata such as `unsupported_parameter` and `dimensions`. Log the request id with production errors and customer support reports.

The wheel ships `py.typed` so type checkers can inspect the package. Fixed-shape helpers expose `TypedDict` response contracts: `ModelListResponse`, `ModelObject`, `ResponsesCreateResponse`, `ChatCompletionResponse`, `EmbeddingResponse`, `TranscriptionResponse`, and `ImageGenerationResponse`. Batch helpers return `BatchCreateResponse`, `BatchRetrieveResponse`, `BatchListResponse`, and `BatchCancelResponse` around the typed `BatchJob`. Stream-capable helpers are typed as either the JSON response contract or `RunInfraStream` when `stream=True`.

From 0.3.1 a chat answer's `choices` are typed as `ChatCompletionChoice`, whose `message` is a `ChatMessage` with `tool_calls` (`ChatCompletionMessageToolCall`), a `content` that may be `None`, and `reasoning`. `ChatToolMessage` types the message that answers a call. `ChatCompletionStreamEvent`, `ChatCompletionStreamChoice`, `ChatCompletionStreamDelta`, and `ChatCompletionStreamToolCallDelta` type the events of a chat stream; a `RunInfraStream` yields plain dictionaries, so annotate an event with `ChatCompletionStreamEvent` to have it checked.

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

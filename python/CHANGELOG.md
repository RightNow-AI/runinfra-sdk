# Changelog

All notable changes to the `runinfra` Python SDK are documented here. This
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1] - 2026-11-17

Read "Changed" before you upgrade. A stream now raises where it used to end
silently, the default timeouts are longer, and a call is no longer sent again
after a timeout.

### Changed
- **A stream raises where it used to end silently.** Iterating a
  `RunInfraStream` raises `RunInfraStreamError` when the API reports a failure
  on the open stream (a frame that holds an `error` object, or a
  `response.failed` event on a Responses stream), and
  `RunInfraStreamIncompleteError` when the body ends without its end marker
  (`[DONE]` on a chat stream, `response.completed` on a Responses stream; an
  empty body counts, and so does a body that ends in the middle of an event).
  Every event that came first is still yielded before the raise, and closing
  the iterator early raises nothing. Before, both cases ended the loop as if
  the answer were complete. Wrap the loop in `try`/`except`, and keep a
  partial answer only if it is useful to you.
- **A streamed call answered with JSON yields that answer once.** A streamed
  call that repeats an `Idempotency-Key` the API has already answered gets one
  JSON object back instead of an event stream (`Content-Type:
  application/json`, `X-RunInfra-Idempotent-Replay: true`). The stream yields
  that object once, marked `_idempotent_replay` true, and ends quietly; it is
  not reported as a cut stream. Any other successful answer that is JSON
  instead of an event stream is yielded once in the same way, without the
  mark. Before, such an answer ended the loop with no event. Check
  `_idempotent_replay` on an event before you read deltas from it.
- **New default timeouts.** With no `timeout_seconds`, a non-streamed call is
  given 750 seconds (was 120), and a streamed call 190 seconds to its response
  headers and to each later read (was 120). The API allows a whole response up
  to 740 seconds and a stream up to 180 seconds to its first token, and the old
  default cut such calls off. A `timeout_seconds` you set, on the client or in
  a call's `request_options`, is used as before. A call that hangs now takes
  longer to fail unless you set your own timeout. The default of the client's
  `timeout_seconds` parameter is now `None`, which means "use the defaults
  above". A custom `transport` is handed the same `timeout_seconds` as before.
- **No re-send after a timeout.** A call that runs out of time raises
  `RunInfraTimeoutError` and is never sent again, whatever `max_retries` says
  and whether or not it carries an `idempotency_key`. Before, a `GET` and a
  keyed non-streamed call were sent again after a timeout, while the API could
  still be working on the first send. The error carries `client_request_id`,
  the `X-Client-Request-Id` the SDK sent.
- **The retry rule follows what the API says.** Which calls may be sent again
  has not changed: a `GET`, or a non-streamed chat, Responses or batch create
  call that carries an `idempotency_key`. For those calls:
  - `x-should-retry` on the response and `error.retryable` in the error body
    are obeyed. `false` stops the retry of a status that used to be retried.
    `true` allows the retry of a status that used not to be.
  - The wait is read from `Retry-After-Ms` first, then from `Retry-After`.
    Before, `Retry-After-Ms` was not read.
  - A wait above 60 seconds is raised at once, with the wait on the error.
    Before, the SDK slept a short backoff instead and sent the call again
    sooner than the API asked. On a batch route the line stays 5 seconds for a
    `503`, and a `409` stays final.
  - The SDK's own backoff, used when the API names no wait, now has jitter: up
    to one `retry_base_seconds` is added to each wait. Before, the Python
    backoff was the same for every client.
  - The error body of a failed response is read before the SDK decides, where
    it used to be closed unread.
- **`retry_after_seconds` is on every typed error whose response named a
  wait**, whatever its status. Before, only `RateLimitError` and the batch
  routes' refusals carried it. Code that reads `retry_after_seconds is None`
  to tell a rate limit from another error must test the class or the status
  instead.
- **A chat answer's `choices` are typed.** `ChatCompletionResponse["choices"]`
  is now a list of `ChatCompletionChoice` instead of plain dictionaries, and
  its message's `content` may be `None`. A type checker now reports a `content`
  used where a `str` is required, and a key of a choice the type does not name.
  Nothing changes at run time.
- The package's Documentation link points at the public Python guide.

### Added
- `RunInfraStreamError` and `RunInfraStreamIncompleteError`, described above.
- `RunInfraError.retryable`: what the API said about asking again, when it
  said it. `RunInfraError.client_request_id`: set on a timeout.
- Keywords on `client.chat.completions.create` for the chat request fields the
  API documents and the helper did not name: `top_k`, `min_p`,
  `repetition_penalty`, `n`, `best_of`, `logit_bias`, `parallel_tool_calls`,
  `reasoning_effort`, `reasoning`, `include_reasoning`, `prompt_cache_key`,
  `service_tier`, `store`, `safety_identifier`, `modalities`, `audio`,
  `prediction`, `verbosity`, `web_search_options`, `moderation`, `functions`,
  and `function_call`. Each of them is still accepted in `extra_body`, where it
  had to go before; naming one in both places is refused.
- Tool calls have a shape: `ChatMessage` with `tool_calls`
  (`ChatCompletionMessageToolCall`), a `content` that may be `None`, and
  `reasoning`; `ChatToolMessage` for the message that answers a call by its
  `tool_call_id`; and `ChatCompletionStreamEvent`,
  `ChatCompletionStreamChoice`, `ChatCompletionStreamDelta`, and
  `ChatCompletionStreamToolCallDelta` for a chat stream, whose delta types
  `tool_calls` and `reasoning`.

## [0.3.0] - 2026-11-16

### Added
- `client.batches.create`, `client.batches.list`, `client.batches.retrieve`,
  and `client.batches.cancel` for batch jobs, with the typed `BatchJob`,
  `BatchJobDetail`, `BatchQuote`, and response envelopes. `create` sends
  `idempotency_key` as `Idempotency-Key`, is retried only when a key is given,
  and never uses a default timeout below 30 seconds because the gateway tests
  the destination before it answers.
- `verify_batch_delivery` verifies a batch delivery posted to your own address
  (Standard Webhooks signature over the raw body, compared in constant time)
  and returns it as `BatchTestDelivery`, `BatchAnswerDelivery`, or
  `BatchErrorDelivery`. The delivery's timestamp must be within 300 seconds of
  the clock by default, so a captured delivery cannot be replayed later;
  `tolerance_seconds` sets another tolerance and `tolerance_seconds=None` turns
  the check off.
- Refusals of the batch routes are typed errors that keep the gateway's
  `code`, `param`, and request id, plus `RunInfraError.reason` (the cause word
  of `flex_not_available`) and `retry_after_seconds` on every status that
  sends `Retry-After`. A `409` from a batch route is a final refusal that is
  never retried, and a `503` that asks for a wait above 5 seconds is raised at
  once with that wait instead of being waited for. Errors and retries of every
  other route are unchanged.

## [0.2.0] - 2026-06-15

### Added
- `InsufficientCreditsError` now exposes `current_balance_cents`,
  `required_cents`, and `topup_url` when the gateway includes them on a `402`
  response, so callers can render a precise top-up prompt without parsing the
  message string.

### Changed
- `PermissionDeniedError.type` now preserves a specific gateway discriminator on
  `403` responses (for example `byoc_plan_required` when a workspace below the
  deploy tier calls a BYOC-deployed endpoint) instead of always reporting
  `permission_denied`. Branch on `err.type` rather than scraping `str(err)`.

## [0.1.5] - 2026-05-30

### Added
- Added examples for chat, Responses streaming, embeddings, model discovery,
  and webhook verification.
- Clarified deployment requirements for image, audio, and co-located voice
  pipeline helpers.

### Changed
- Clarified webhook helpers as local signature verification APIs. Webhook
  delivery management remains outside the public SDK surface.

## [0.1.4] - 2026-05-23

### Added
- Added typed helpers for chat completions, Responses, embeddings, image
  generation, text to speech, speech to text, model discovery, local webhook
  signature verification, and co-located voice pipelines.
- Added explicit OpenAI-style keyword parameters for chat, Responses,
  embeddings, image generation, TTS, and ASR helpers, including `extra_body`
  for deliberate JSON gateway extensions.
- Added Python overloads so `stream=True` calls on chat completions and
  Responses narrow to `RunInfraStream` while non-stream calls keep their typed
  response envelopes.
- Added concrete asyncio and FastAPI background-task examples for using the
  sync client safely in async Python runtimes.
- Added typed gateway errors for authentication, permissions, rate limits,
  insufficient credits, deployment failures, missing models, timeouts,
  connection failures, and malformed streams.

### Changed
- Kept the public `client.webhooks` namespace focused on local signature
  verification. Verification remains available through `verify_signature`,
  `construct_event`, `verify_webhook_signature`, and `construct_webhook_event`.
- Replaced arbitrary `**kwargs` on public request helpers with explicit keyword
  parameters plus `extra_body` for deliberate JSON body extensions.
- Closed ASR multipart requests around explicit file, filename, language,
  prompt, temperature, and response-format fields.
- Documented the Responses helper as a chat-completions compatibility adapter
  instead of full OpenAI Responses state.
- Kept charge-bearing retries conservative. Embeddings, images, streaming,
  binary TTS, multipart ASR, and voice-pipeline requests are sent once even
  when an idempotency key is provided.

### Security
- Hardened API-key redaction in transport errors, response body errors, stream
  read errors, traceback output, and exception chains.
- Limited the published package contents to the runtime SDK, type metadata,
  README, changelog, license, and package metadata.

### Compatibility
- `UnsupportedOperationError` remains exported for older v0.1.x consumers, but
  current public helpers do not raise it.

## [0.1.3] - 2026-05-23

### Security
- Improved package content validation for installed SDK files.

### Changed
- Improved install consistency across the TypeScript and Python packages.

## [0.1.2] - 2026-05-23

### Changed
- Aligned TypeScript and Python package metadata for the same release.
- Clarified that the voice pipeline helper is a pipeline-scoped preview
  surface.
- Switched Python license metadata to the non-deprecated `license` and
  `license-files` form.

## [0.1.1] - 2026-05-23

### Changed
- Updated repository and issue URLs to point at the public SDK repo.
- Clarified package status as beta while image and audio helpers remain
  deployment-dependent preview surfaces.

### Added
- Added the modality status section to the README.
- Added preview docstrings for deployment-dependent helpers.

## [0.1.0] - 2026-05-22

Initial public release. See README for the API surface.

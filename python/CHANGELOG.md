# Changelog

All notable changes to the `runinfra` Python SDK are documented here. This
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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

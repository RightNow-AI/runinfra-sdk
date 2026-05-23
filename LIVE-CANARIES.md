# SDK Live Canary Matrix

The SDK is not GA until this matrix passes in strict mode for both TypeScript
and Python against the production gateway and the exact deployed models that
will serve customers.

Run from the repository root after building the TypeScript SDK:

```bash
pnpm --dir typescript build
pnpm --dir typescript pack
python -m build python
node scripts/run-sdk-live-canaries.mjs --preflight --strict --report artifacts/sdk/live-canary-readiness.json
node scripts/run-sdk-live-canaries.mjs --package-source artifact --strict --report artifacts/sdk/live-canary.json
```

`--preflight` is a no-network readiness check. It writes the same redacted
environment status plus row-by-row missing inputs, then fails in strict mode
when required model IDs, fixture paths, expected transcripts, or idempotency
opt-in are absent. Use it before provisioning live canary resources so missing
GA inputs are explicit without exposing values.

Without `--strict`, missing model credentials are reported as skipped rows.
With `--strict`, any skipped or failed row exits non-zero. Use strict mode for
release promotion. The default `--package-source artifact` mode installs the
packed npm tarball and Python wheel into disposable consumer environments
before it starts live canaries, so strict reports prove the shipped artifacts,
not only the source checkout. Use `--package-source source` only for local SDK
development diagnostics.

## Required Environment

| Variable | Purpose |
|---|---|
| `RUNINFRA_API_KEY` | Workspace-scoped canary key for flat `/v1/*` routes |
| `RUNINFRA_BASE_URL` | Optional, defaults to `https://api.runinfra.ai/v1` |
| `RUNINFRA_CANARY_TIMEOUT_SECONDS` | Optional per-request canary timeout for both SDKs, defaults to 120 |
| `RUNINFRA_LLM_MODEL` | Model for chat, responses, streaming, and idempotency rows |
| `RUNINFRA_EMBEDDING_MODEL` | Model for embeddings row |
| `RUNINFRA_EMBEDDING_DIMENSIONS` | Positive integer embedding dimension count for the OpenAI parameter row |
| `RUNINFRA_IMAGE_MODEL` | Model for image generation row |
| `RUNINFRA_IMAGE_SIZE` | Image size for the OpenAI image parameter row |
| `RUNINFRA_IMAGE_RESPONSE_FORMAT` | `url` or `b64_json` for the OpenAI image parameter row |
| `RUNINFRA_TTS_MODEL` | Model for TTS row |
| `RUNINFRA_TTS_VOICE` | Named TTS voice, if the deployment uses voices |
| `RUNINFRA_TTS_REF_AUDIO` | Reference-audio URL/string, if the deployment uses voice cloning |
| `RUNINFRA_TTS_REF_TEXT` | Reference transcript for `RUNINFRA_TTS_REF_AUDIO` |
| `RUNINFRA_TTS_TASK_TYPE` | Optional TTS task type, defaults to `Base` |
| `RUNINFRA_TTS_RESPONSE_FORMAT` | Optional for base TTS rows; required for the OpenAI TTS parameter row. Must be `mp3`, `opus`, `aac`, `flac`, `wav`, or `pcm` |
| `RUNINFRA_ASR_MODEL` | Model for ASR row |
| `RUNINFRA_ASR_LANGUAGE` | Optional for the base ASR row; required for the OpenAI ASR parameter row |
| `RUNINFRA_ASR_RESPONSE_FORMAT` | `json` or `verbose_json` for the OpenAI ASR parameter row |
| `RUNINFRA_ASR_FIXTURE_PATH` | Local deterministic speech-audio fixture path for ASR row |
| `RUNINFRA_ASR_FIXTURE_CONTENT_TYPE` | Optional ASR fixture content type, defaults to `audio/wav` |
| `RUNINFRA_ASR_EXPECTED_TEXT` | Normalized text that must appear in the ASR transcript |
| `RUNINFRA_VOICE_PIPELINE_ID` or `TEST_PIPELINE_ID` | Pipeline id for voice pipeline row |
| `RUNINFRA_VOICE_PIPELINE_API_KEY` or `RUNINFRA_PIPELINE_API_KEY` | Pipeline-scoped key for voice pipeline row |
| `RUNINFRA_VOICE_PIPELINE_AUDIO_PATH` | Deterministic speech-audio fixture for voice pipeline row. Falls back to `RUNINFRA_ASR_FIXTURE_PATH` |
| `RUNINFRA_VOICE_PIPELINE_AUDIO_CONTENT_TYPE` | Optional voice pipeline fixture content type. Falls back to `RUNINFRA_ASR_FIXTURE_CONTENT_TYPE` or `audio/wav` |
| `RUNINFRA_VOICE_PIPELINE_EXPECTED_TEXT` | Normalized text that must appear in the voice pipeline response. Falls back to `RUNINFRA_ASR_EXPECTED_TEXT` |
| `RUNINFRA_CANARY_ENABLE_IDEMPOTENCY=1` | Explicit opt-in for repeated idempotency replay test |
| `RUNINFRA_CANARY_IDEMPOTENCY_EVIDENCE_FIELD` | Optional comma-separated response field paths that prove the second idempotent response was replayed |

The native SDK live rows intentionally verify only the OpenAI-compatible
parameter subset that keeps response shapes stable for the SDK typed helpers.
Advanced OpenAI parameters that change response envelopes or require
model-specific backend support stay out of GA until a strict canary row proves
them against the deployed model.

The report stores only `set_redacted` or `missing` for environment variables.
Custom `RUNINFRA_BASE_URL` values are recorded only as `custom_set_redacted`.
Reports must not contain API keys, registry tokens, local absolute paths,
request payload secrets, source maps, or private repo metadata.

## Matrix Rows

The runner exercises SDK methods, not raw HTTP helpers:

- `models.list`
- `models.retrieve.llm`
- `chat.completions.create`
- `openai.params.chat.completions`
- `chat.completions.stream.final`
- `chat.completions.stream.cancel`
- `responses.create`
- `openai.params.responses`
- `responses.stream.final`
- `responses.stream.cancel`
- `embeddings.create`
- `openai.params.embeddings`
- `images.generate`
- `openai.params.images`
- `audio.speech.create`
- `openai.params.audio.speech`
- `audio.speech.binary_interfaces`
- `audio.transcriptions.create`
- `openai.params.audio.transcriptions`
- `voice.pipeline.create`
- `error.auth.invalid_key`
- `error.model.not_found`
- `error.request.invalid_options`
- `error.body.unsupported_parameter`
- `webhooks.create.unsupported`
- `webhooks.list.unsupported`
- `webhooks.verify_signature.local`
- `webhooks.construct_event.local`
- `webhooks.verify_signature.export`
- `webhooks.construct_event.export`
- `idempotency.replay.responses`

Network success rows assert `x-request-id` exposure and the relevant
OpenAI-compatible envelope fields: models list object plus data array, chat
ids/models/choices/messages, Responses ids/status/output or semantic stream
event type/status, finite embedding vectors, image URL/base64 outputs, binary
non-JSON TTS responses, and string ASR transcripts. The TTS binary-interface
row validates TypeScript `blob()` and `stream()` handling plus the Python raw
byte response surface. Final streaming rows drain real SSE streams and require
terminal events. Cancellation streaming rows consume a prefix and then close
early to cover consumer cancellation. The
OpenAI parameter rows prove chat
sampling and metadata pass-through, Responses instructions, metadata,
temperature, output-token controls, embeddings `encoding_format: "float"` plus
`dimensions`, exact image `response_format` output matching while sending an
explicit image `size` to the backend, TTS `response_format` request handling
with a non-JSON binary audio response, and ASR `language`, fixed `prompt`, plus
`response_format` request handling. The TTS parameter row does not claim exact
codec or content-type matching because deployments expose model-specific output
formats. The ASR parameter row does not claim the language hint changed model
behavior; it requires the transcript match and, for `verbose_json`, at least one
verbose response field.
The model-not-found row performs a live `models.retrieve()` lookup for the
deterministic missing model id `runinfra-sdk-canary-missing-model` and requires
a traced `model_not_found` 404 error. Unsupported SDK request options and
webhook delivery rows must fail closed without sending a network request.
Webhook verification rows exercise both client-attached helpers and top-level
package exports. The unsupported body-parameter row sends a real OpenAI-style
request with a RunInfra probe parameter and requires a clear traced 400/422
invalid-parameter style error instead of success, silent ignore, unrelated
auth/credits/rate-limit/model errors, 5xx, or transport failure. ASR uploads a
deterministic speech fixture and requires the normalized transcript to include
`RUNINFRA_ASR_EXPECTED_TEXT`; silence fixtures are not valid GA proof.
Voice pipeline rows also require deterministic speech audio and expected text;
generated silence is not accepted as GA proof.
Webhook signature rows use installed package artifacts and deterministic local
payloads because they are verification helpers, not live delivery endpoints.

The idempotency row is intentionally strict. It does not pass merely because
two calls returned successfully. The second response must expose replay
evidence in one of these default fields: `idempotency_replayed`,
`_idempotency_replayed`, `idempotency.replayed`, or `replay.replayed`. Override
the field list with `RUNINFRA_CANARY_IDEMPOTENCY_EVIDENCE_FIELD` only when the
gateway exposes equivalent replay evidence under a different response path.

## Promotion Rule

Do not remove the experimental label from images, TTS, ASR, or voice pipeline
until both language reports pass strict mode with the deployed models listed in
the release notes or handoff. Unit tests and package scans remain required, but
they do not replace this live matrix.

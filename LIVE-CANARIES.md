# SDK Live Canary Matrix

The SDK is not GA until this matrix passes in strict mode for both TypeScript
and Python against the production gateway and the exact deployed models that
will serve customers.

Run from the repository root after building the TypeScript SDK:

```bash
pnpm --dir typescript build
pnpm --dir typescript pack
python -m build python
node scripts/run-sdk-live-canaries.mjs --package-source artifact --strict --report artifacts/sdk/live-canary.json
```

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
| `RUNINFRA_IMAGE_MODEL` | Model for image generation row |
| `RUNINFRA_TTS_MODEL` | Model for TTS row |
| `RUNINFRA_TTS_VOICE` | Named TTS voice, if the deployment uses voices |
| `RUNINFRA_TTS_REF_AUDIO` | Reference-audio URL/string, if the deployment uses voice cloning |
| `RUNINFRA_TTS_REF_TEXT` | Reference transcript for `RUNINFRA_TTS_REF_AUDIO` |
| `RUNINFRA_TTS_TASK_TYPE` | Optional TTS task type, defaults to `Base` |
| `RUNINFRA_TTS_RESPONSE_FORMAT` | Optional TTS output format |
| `RUNINFRA_ASR_MODEL` | Model for ASR row |
| `RUNINFRA_ASR_LANGUAGE` | Optional ASR language hint |
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

The report stores only `set_redacted` or `missing` for environment variables.
Custom `RUNINFRA_BASE_URL` values are recorded only as `custom_set_redacted`.
Reports must not contain API keys, registry tokens, local absolute paths,
request payload secrets, source maps, or private repo metadata.

## Matrix Rows

The runner exercises SDK methods, not raw HTTP helpers:

- `models.list`
- `models.retrieve.llm`
- `chat.completions.create`
- `chat.completions.stream.final`
- `chat.completions.stream.cancel`
- `responses.create`
- `responses.stream.final`
- `responses.stream.cancel`
- `embeddings.create`
- `images.generate`
- `audio.speech.create`
- `audio.transcriptions.create`
- `voice.pipeline.create`
- `error.auth.invalid_key`
- `error.request.invalid_options`
- `webhooks.create.unsupported`
- `webhooks.list.unsupported`
- `webhooks.verify_signature.local`
- `webhooks.construct_event.local`
- `idempotency.replay.responses`

Each success row asserts `x-request-id` exposure and the relevant
OpenAI-compatible envelope fields: chat ids/models/choices/messages, Responses
ids/status/output or semantic stream event type/status, finite embedding
vectors, image URL/base64 outputs, binary non-JSON TTS responses, and string
ASR transcripts. Final streaming rows drain real SSE streams and require
terminal events. Cancellation streaming rows consume a prefix and then close
early to cover consumer cancellation. Unsupported request option and webhook
delivery rows must fail closed without sending a network request. ASR uploads a
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

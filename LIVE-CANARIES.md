# SDK Live Canary Matrix

The SDK is not GA until this matrix passes in strict mode for both TypeScript
and Python against the production gateway and the exact deployed models that
will serve customers.

Run from the repository root after building the TypeScript SDK:

```bash
pnpm --dir typescript build
pnpm --dir typescript pack
python -m build python
node scripts/run-sdk-live-canaries.mjs --verify-surface-coverage
node scripts/run-sdk-live-canaries.mjs --preflight --strict --report artifacts/sdk/live-canary-readiness.json
node scripts/run-sdk-live-canaries.mjs --package-source artifact --strict --report artifacts/sdk/live-canary.json
node scripts/verify-promotion-reports.mjs --readiness artifacts/sdk/live-canary-readiness.json --live artifacts/sdk/live-canary.json --artifacts-root .
```

`--verify-surface-coverage` is a no-network check that maps every public SDK
surface to the canary rows that prove it. It derives declared client/helper
surfaces from the TypeScript source, Python source, and package READMEs, then
fails if a declared surface has no mapped rows or if a mapped surface references
a row outside the strict matrix. It also fails if a canonical strict matrix row
is not attached to any public surface coverage entry.
`verify-promotion-reports.mjs` also requires the report's listed coverage
surfaces and counts to match the canonical public surface coverage manifest, so
a shortened or stale surface manifest cannot satisfy the release gate. It also
requires `candidate.sourceFileCount` to match the canonical live-canary source
file manifest, so a self-consistent stale report pair cannot reuse old source
identity metadata after the canary source set changes.

`--preflight` is a no-network readiness check. It writes the same redacted
environment status plus row-by-row missing inputs, then fails in strict mode
when required model IDs, fixture paths, expected transcripts, or idempotency
opt-in are absent. Use it before provisioning live canary resources so missing
GA inputs are explicit without exposing values. It also fails closed if the
readiness requirement rows drift from the canonical strict matrix, so a new
live row cannot be added without a matching preflight requirement.

To create a private local env file without copying secrets into docs or
reports, generate the static template and fill it outside git:

```bash
node scripts/run-sdk-live-canaries.mjs --write-env-template .env.sdk-live.local
```

The template writer never reads current env values and refuses to overwrite an
existing file unless `--force-env-template` is supplied. The generated file
includes local fixture path fields plus commented GitHub Actions base64 fixture
secret names, but only the strict preflight and live reports are promotion
evidence.

After a blocked preflight writes `artifacts/sdk/live-canary-readiness.json`, you
can generate a redacted missing strict live-canary env patch:

```bash
node scripts/run-sdk-live-canaries.mjs --readiness-report artifacts/sdk/live-canary-readiness.json --write-missing-env-template .env.sdk-live.missing.local
```

The missing patch writer reads only the redacted readiness report, emits only
whitelisted `RUNINFRA_*` placeholders or safe defaults for missing inputs, and
refuses to overwrite an existing file unless `--force-env-template` is supplied.
It never diffs an existing env file, never copies current env values, and is not
promotion evidence.

If canary inputs live in a local env file, load it through
`--runinfra-env-file <path-to-env-file>`:

```bash
node scripts/run-sdk-live-canaries.mjs --runinfra-env-file <path-to-env-file> --preflight --strict --report artifacts/sdk/live-canary-readiness.json
```

To inspect the live catalog before filling model env vars, run:

```bash
node scripts/run-sdk-live-canaries.mjs --discover-models --runinfra-env-file <path-to-env-file> --report artifacts/sdk/live-model-discovery.json
```

Model discovery is informational. It calls only `GET /models`, groups catalog
candidate IDs by `RUNINFRA_*_MODEL` env name using catalog metadata hints, and
does not call inference routes. It does not make strict preflight ready, does
not prove model callability, and must not replace `models.retrieve.*` plus the
strict multimodal canary rows. Discovery reports keep API keys and custom base
URLs redacted, do not serialize raw catalog objects, and still pass the shared
report leak scanner before writing.

Do not use Node's `--env-file` option in promotion commands.
`--runinfra-env-file <path-to-env-file>` keeps env-file parsing, explicit
shell-env precedence, and report redaction inside the canary runner.

Without `--strict`, missing model credentials are reported as skipped rows.
With `--strict`, any skipped or failed row exits non-zero. Use strict mode for
release promotion. The default `--package-source artifact` mode installs the
packed npm tarball and Python wheel into disposable consumer environments and
records the Python sdist digest before it starts live canaries, so strict
reports prove every shipped artifact, not only the source checkout. The separate
artifact clean-install gate imports both the prebuilt Python wheel and an
sdist-built wheel; successful pip output is suppressed so promotion logs do not
expose local paths. Use `--package-source source` only for local SDK development
diagnostics.

Failed child rows keep raw exception messages redacted, but include a safe
`error.diagnostic` enum when the failure class is known. Current diagnostics
include `unexpected_success`, `invalid_error_shape`, `missing_request_id`,
`missing_terminal_event`, `timeout`, and `invalid_response_shape`. These
diagnostics are for triage only; a failed row is still a failed row and cannot
satisfy strict promotion.

In the trusted-publish workflow, `build-artifacts` creates the npm tarball,
Python wheel, and Python sdist once and uploads them as
`runinfra-sdk-promoted-artifacts`. `promotion-gate`, `publish-npm`, and
`publish-pypi` download that same artifact bundle. A real publish cannot start
the registry jobs until strict readiness/live reports pass for the downloaded
artifacts and `verify-promotion-reports.mjs` confirms the same source digest
and all-passed rows.

## Required Environment

| Variable | Purpose |
|---|---|
| `RUNINFRA_API_KEY` | Workspace-scoped canary key for flat `/v1/*` routes |
| `RUNINFRA_BASE_URL` | Optional, defaults to `https://api.runinfra.ai/v1` |
| `RUNINFRA_CANARY_TIMEOUT_SECONDS` | Optional positive per-request canary timeout for both SDKs, defaults to 120 and must be <= 600 |
| `RUNINFRA_CANARY_STREAM_SLOW_CONSUMER_DELAY_MS` | Optional non-negative integer delay from 0 to 5000 after each consumed SSE event in slow-consumer rows, defaults to 25 |
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
| `RUNINFRA_ASR_FIXTURE_BASE64` | GitHub Actions secret form of the deterministic ASR fixture. The publish workflow decodes it to `RUNINFRA_ASR_FIXTURE_PATH` on the runner |
| `RUNINFRA_ASR_FIXTURE_CONTENT_TYPE` | Optional ASR fixture content type, defaults to `audio/wav` |
| `RUNINFRA_ASR_EXPECTED_TEXT` | Normalized text that must appear in the ASR transcript |
| `RUNINFRA_VOICE_PIPELINE_ID` or `TEST_PIPELINE_ID` | Pipeline id for voice pipeline row |
| `RUNINFRA_VOICE_PIPELINE_API_KEY` or `RUNINFRA_PIPELINE_API_KEY` | Pipeline-scoped key for voice pipeline row |
| `RUNINFRA_VOICE_PIPELINE_AUDIO_PATH` | Deterministic speech-audio fixture for voice pipeline row. Falls back to `RUNINFRA_ASR_FIXTURE_PATH` |
| `RUNINFRA_VOICE_PIPELINE_AUDIO_BASE64` | GitHub Actions secret form of the deterministic voice-pipeline fixture. The publish workflow decodes it to `RUNINFRA_VOICE_PIPELINE_AUDIO_PATH` on the runner |
| `RUNINFRA_VOICE_PIPELINE_AUDIO_CONTENT_TYPE` | Optional voice pipeline fixture content type. Falls back to `RUNINFRA_ASR_FIXTURE_CONTENT_TYPE` or `audio/wav` |
| `RUNINFRA_VOICE_PIPELINE_EXPECTED_TEXT` | Normalized text that must appear in the voice pipeline response. Falls back to `RUNINFRA_ASR_EXPECTED_TEXT` |
| `RUNINFRA_CANARY_ENABLE_IDEMPOTENCY=1` | Explicit opt-in for repeated idempotency replay test |
| `RUNINFRA_CANARY_IDEMPOTENCY_EVIDENCE_FIELD` | Optional comma-separated response field paths that prove the second idempotent response was replayed |

The parent runner also accepts legacy RunPipe canary env aliases and forwards
them to child canaries as canonical `RUNINFRA_*` names without writing their
values to reports. Supported aliases are `TEST_MODEL`,
`TEST_EMBEDDING_MODEL`, `TEST_IMAGE_MODEL`, `TEST_TTS_MODEL`,
`TEST_TTS_VOICE`, `TEST_TTS_REF_AUDIO`, `TEST_TTS_REF_TEXT`,
`TEST_TTS_TASK_TYPE`, `TEST_ASR_MODEL`, `TEST_ASR_FILE`, and
`TEST_PIPELINE_ID`. Reports list only which alias names were used.

The native SDK live rows intentionally verify only the OpenAI-compatible
parameter subset that keeps response shapes stable for the SDK typed helpers.
Advanced OpenAI parameters that change response envelopes or require
model-specific backend support stay out of GA until a strict canary row proves
them against the deployed model.

The report stores only `set_redacted` or `missing` for environment variables.
A `RUNINFRA_BASE_URL` equal to `https://api.runinfra.ai/v1` is recorded as production;
any other custom `RUNINFRA_BASE_URL` value is recorded only as `custom_set_redacted`.
The parent runner validates custom base URLs before spawning child canaries:
remote URLs must use HTTPS, local HTTP is allowed, and credentials, query
strings, fragments, and malformed protocols fail closed with a redacted error.
Reports must not contain API keys, registry tokens, local absolute paths,
request payload secrets, source maps, or private repo metadata.
Every preflight and full report includes `candidate.sourceDigestSha256` plus
the SDK version and package source so release reviewers can prove which source
state generated the canary evidence without recording local paths. Full
`--package-source artifact` reports also set `candidate.artifactDigestsChecked`
and record only exact versioned package file names plus SHA-256 values in
`candidate.artifacts`; preflight reports do not require built artifacts and
leave that list empty.
The canonical source manifest includes `typescript/tsconfig.json` and
`python/MANIFEST.in`, so source-map compiler changes or Python sdist manifest
changes must generate new readiness and live-canary reports before promotion.
`verify-promotion-reports.mjs` is the release gate that compares the readiness
and live reports, requires the same candidate source digest, requires the live
artifact report to include npm, Python wheel, and Python sdist hashes, and
requires `--artifacts-root`, and recomputes those hashes from the staged
artifact files before allowing promotion. It fails if either language has
skipped or failed rows. It also requires readiness `rowCoverageErrors` to be
empty, readiness `summary.ready` to equal the canonical matrix row count,
readiness `summary.blocked` to be `0`, and `expectedRows` to match the
canonical live canary matrix exactly,
so a shortened self-consistent report cannot satisfy the gate. The report's
candidate source file count must also match the canonical live-canary source
file manifest.
Promotion evidence must come from strict child canaries against `https://api.runinfra.ai/v1`;
reports generated with any other custom `RUNINFRA_BASE_URL` are useful for
staging smoke tests but cannot satisfy the real publish gate.

## Matrix Rows

The runner exercises SDK methods, not raw HTTP helpers:

- `models.list`
- `models.retrieve.llm`
- `models.retrieve.embedding`
- `models.retrieve.image`
- `models.retrieve.tts`
- `models.retrieve.asr`
- `chat.completions.create`
- `openai.params.chat.completions`
- `openai.params.chat.stream_options`
- `chat.completions.stream.final`
- `chat.completions.stream.cancel`
- `chat.completions.stream.slow_consumer`
- `chat.completions.stream.malformed_frame.local`
- `chat.completions.stream.disconnect.local`
- `chat.completions.stream.stalled_read.local`
- `responses.create`
- `openai.params.responses`
- `responses.stream.final`
- `responses.stream.cancel`
- `responses.stream.slow_consumer`
- `responses.stream.malformed_frame.local`
- `responses.stream.disconnect.local`
- `responses.stream.stalled_read.local`
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
- `error.insufficient_credits.local`
- `error.rate_limit.local`
- `request.client_request_id.local`
- `request.custom_headers.local`
- `request.timeout.local`
- `request.extra_body.local`
- `request.unknown_fields.local`
- `browser.api_key_guard.local`
- `security.api_key_redaction.local`
- `error.body.unsupported_parameter`
- `retry.safety.get.local`
- `retry.safety.post.requires_idempotency.local`
- `retry.safety.post.with_idempotency.local`
- `retry.safety.post.non_replayable_json.no_retry.local`
- `retry.safety.stream.no_retry.local`
- `retry.safety.audio_binary.no_retry.local`
- `retry.safety.audio_multipart.no_retry.local`
- `retry.safety.voice_binary.no_retry.local`
- `webhooks.delivery_surface.absent`
- `webhooks.verify_signature.local`
- `webhooks.construct_event.local`
- `webhooks.verify_signature.export`
- `webhooks.construct_event.export`
- `idempotency.replay.responses`

When any `RUNINFRA_*_MODEL` canary variable is configured, `models.list` must
include every configured canary model ID before the row can pass. Reports record
only the item count and request ID, not the configured or missing model IDs.
The `models.retrieve.*` rows perform live object lookups for each configured
modality model ID and require the response id to match the requested id without
recording configured model names in reports.

Network success rows assert `x-request-id` exposure and the relevant
OpenAI-compatible envelope fields: models list object plus data array, chat
ids/models/choices/messages, Responses ids/status/output or semantic stream
event type/status, finite embedding vectors, image URL/base64 outputs, binary
non-JSON TTS responses, and string ASR transcripts. The TTS binary-interface
row validates TypeScript `blob()` and `stream()` handling plus the Python raw
byte response surface. Final streaming rows drain real SSE streams and require
terminal events. Chat final and slow-consumer rows accept either normal chat
delta chunks or OpenAI-style usage chunks with empty `choices` and numeric token
usage, without recording token counts. Cancellation streaming rows require
normal chat chunks, consume a prefix, and then close early to cover consumer cancellation. TypeScript cancellation rows break out of
`for await`, and Python cancellation rows close the active iterator, so both
languages release local stream resources after partial consumption.
Responses rows prove the compatibility adapter returns the documented envelope
or semantic stream events after the gateway forwards supported request fields
through the chat-completions serving path. They do not prove full stateful
Responses API semantics.
Slow-consumer streaming rows drain real chat and Responses SSE streams while
pausing after each event; reports record only request IDs, event counts, and a
redacted delay marker. The pause budget is bounded by `RUNINFRA_CANARY_TIMEOUT_SECONDS`,
so an excessive valid delay fails closed instead of holding a canary job open.
Local streaming fault rows do not call the production gateway; they run against
deterministic local SSE bodies from the installed SDK package and prove typed
malformed-frame, disconnect, and stalled-read error handling for both chat and
Responses streams: `chat.completions.stream.malformed_frame.local`,
`responses.stream.malformed_frame.local`,
`chat.completions.stream.disconnect.local`,
`responses.stream.disconnect.local`,
`chat.completions.stream.stalled_read.local`, and
`responses.stream.stalled_read.local`.
The OpenAI parameter rows prove chat sampling and metadata pass-through, chat
`stream_options.include_usage` usage chunks with numeric token fields but
without recording token counts, Responses instructions, metadata, temperature,
output-token controls, embeddings `encoding_format: "float"` plus `dimensions`,
exact image `response_format` output matching while sending an explicit image
`size` to the backend, TTS `response_format` request handling with a non-JSON
binary audio response, and ASR `language`, fixed `prompt`, plus
`response_format` request handling. The TTS parameter row does not claim exact
codec or content-type matching because deployments expose model-specific output
formats. The ASR parameter row does not claim the language hint changed model
behavior; it requires the transcript match and, for `verbose_json`, at least one
verbose response field.
The model-not-found row performs a live `models.retrieve()` lookup for the
deterministic missing model id `runinfra-sdk-canary-missing-model` and requires
a traced `model_not_found` 404 error. Unsupported SDK request options must
fail closed without sending a network request. The webhook delivery-surface row
asserts unshipped create/list methods are absent while local signature helpers
remain callable.
Local rate-limit error rows do not call the production gateway; they run
against deterministic installed package transports and prove 429 responses map
to typed `RateLimitError` failures with `Retry-After` metadata and request IDs.
Local insufficient-credits error rows use the same installed package transport
path and prove 402 responses map to typed `InsufficientCreditsError` failures
with request IDs, without requiring a real workspace to exhaust billing credits.
Webhook verification rows exercise both client-attached helpers and top-level
package exports. The unsupported body-parameter row sends a real OpenAI-style
request with a RunInfra probe parameter and requires a clear traced 400/422
invalid-parameter style error instead of success, silent ignore, unrelated
auth/credits/rate-limit/model errors, 5xx, or transport failure. ASR uploads a
deterministic speech fixture and requires the normalized transcript to include
`RUNINFRA_ASR_EXPECTED_TEXT`; silence fixtures are not valid GA proof.
Voice pipeline rows also require deterministic speech audio and expected text;
generated silence is not accepted as GA proof.
Local retry-safety rows do not call the production gateway; they run against
deterministic local HTTP responses from the installed SDK package. They prove
safe GET requests retry transient failures, charge-bearing JSON POSTs retry only
with an idempotency key on replay-safe helpers, non-replayable JSON helpers
such as embeddings and images are not retried, and streaming, binary TTS,
multipart ASR, and binary voice-pipeline requests are sent once even when an
idempotency key is present.
Local request-option rows do not call the production gateway; they prove
user-supplied client request IDs and custom request headers are sent as headers,
are not serialized into JSON request bodies, and cannot override
SDK-controlled credential or tracing headers. Local per-request timeout rows
also prove timeout options are applied without serializing timeout option names
into JSON request bodies. Local explicit JSON extra-body rows prove the
deliberate body-extension escape hatch injects only requested JSON fields,
does not serialize SDK option names, rejects typed-field overrides, and stays
out of multipart upload paths. Local unknown-request-field rows prove that
unknown direct request fields fail before network send, and that deliberate JSON
extensions still have to use `extraBody` / `extra_body`.
Local browser API-key guard rows prove the shipped TypeScript artifact fails
closed in browser-like runtimes unless `dangerouslyAllowBrowser: true` is set,
and that the Python package exposes no browser-token helper surface.
Local API-key redaction rows prove initial transport failures, response body
read failures, status error bodies, and stream read failures do not echo the
configured API key, while the request URL stays credential-free and the key is
sent only as an `Authorization: Bearer` header. Python rows also assert
traceback output and explicit exception chains do not retain unredacted causes.
Webhook signature rows use installed package artifacts and deterministic local
payloads because they are verification helpers, not live delivery endpoints.

The idempotency row is intentionally strict. It does not pass merely because
two calls returned successfully. The second response must expose replay
evidence in one of these default fields: `idempotency_replayed`,
`_idempotency_replayed`, `_idempotent_replay`, `idempotency.replayed`, or
`replay.replayed`. Override
the field list with `RUNINFRA_CANARY_IDEMPOTENCY_EVIDENCE_FIELD` only when the
gateway exposes equivalent replay evidence under a different response path.

## Promotion Rule

Do not remove the experimental label from images, TTS, ASR, or voice pipeline
until both language reports pass strict mode with the deployed models listed in
the release notes or handoff. Unit tests and package scans remain required, but
they do not replace this live matrix.

# Agent 4 Goal: SDK Production Stability

Date: 2026-05-23
Agent: 4
Repo: `runinfra-sdk`
Branch/PR: `hardening/sdk-ga-canary-gates`, PR `RightNow-AI/runinfra-sdk#9`

## Goal

Move TS/Python SDKs from secure beta to production-grade GA. Done means clean npm/PyPI installs, live contract match, strict artifact canaries, protected PR merge, OIDC/provenance release, and no leakage of secrets, source maps, internal source, private config, local paths, caches, or fixtures.

Agent 4 owns SDK hardening, package safety, live contract proof, and release evidence. Read state first, patch narrowly, test artifacts, get review for risky changes, and never claim production-ready with skipped or unverified canaries.

## Verified State

- Local `main` carries PR #9 commits; verify exact ahead count with `git status`.
- PR checks are green: TS SDK, Python SDK, CodeQL/default code scanning, package/build/test gates.
- Branch protection is active: merge is blocked by `REVIEW_REQUIRED`; current auth user cannot self-approve.
- Code scanning showed 0 open alerts and 0 open high/critical alerts. Default branch still has 3 moderate Dependabot alerts.
- Current RunPipe canary env proves gateway/auth/request-id/models-list shape only. It lacks live model IDs/audio fixtures, so strict GA is incomplete.
- `/models` returns a valid object with empty `data`; shape proof only, not model coverage.
- Registry install/import gate is enforced after real publish. Local proof: `verify-clean-installs --mode registry --version 0.1.3` passed for npm/PyPI 0.1.3.
- Strict preflight writes redacted readiness reports without live calls; fake-key proof showed blocked readiness, 0 child reports, and no key leak.

## Production Bar

- Registry consumer installs verify imports and versions for npm and PyPI.
- SDKs cover/document chat, responses, embeddings, images, TTS, ASR, voice pipeline, streaming, errors, idempotency, request IDs, retries, local webhook verification helpers, and absent unshipped webhook delivery methods.
- OpenAI-compatible calls prove supported parameters and clear unsupported errors without hiding auth, credit, rate-limit, model, or deployment failures.
- Strict artifact canaries pass with no required skips for LLM, responses, embeddings, image, TTS, ASR, voice, streaming final/cancel, idempotency replay, error shape, and install/import.
- Package scans prove no source maps, `.env`, `.npmrc`, secrets, local paths, private config, caches, fixtures, or internal files.

## Remaining Blockers

1. Need non-author approval before PR #9 can merge into protected `main`.
2. Strict canary env is missing model IDs, embedding dimensions, image/TTS/ASR/voice coverage, audio fixtures, expected transcripts, and idempotency enablement.
3. Advanced OpenAI proof still needs tools/schema outputs, stream options, image/audio variants, embedding dimensions/base64, and model-specific options.
4. Python `RunInfra` is documented as sync-only for v0.1.4; `AsyncRunInfra` stays deferred until it has matching unit, streaming, live-canary, and clean-install coverage.
5. Webhook delivery create/list stays out of the public SDK surface until real delivery endpoints exist.
6. Browser clients must use a backend proxy/server route. Ephemeral browser tokens are not shipped in v0.1.4 and direct browser API-key use remains blocked by default.

## Guardrails

Inspect git/PR/checks before claims. Fix only GA-linked contract, security, packaging, canary, or docs gaps. Verify tests, type/build, scans, clean installs, and source/artifact canaries. Review changes over 2 files, over 100 lines, or release/architecture decisions. Merge only through protected PR after non-author approval. Publish only via trusted workflow after merge and strict canary proof. Do not bypass protection, self-approve, force-push `main`, weaken checks/tests, use pasted registry tokens, ship source maps/internal bundles, or run destructive git reconciliation.

## Next Checkpoint

Collect strict production canary env/fixtures, then rerun preflight and artifact canaries until every required SDK path is proven.

## 2026-05-23 Agent 4 Checkpoint

Added release-gate hardening:

- Strict preflight now blocks invalid or non-finite `RUNINFRA_CANARY_TIMEOUT_SECONDS` before live canaries run.
- Workflow policy now checks npm and PyPI publish jobs separately for OIDC `id-token: write` and environment mapping, while the CLI verifier always reads the real workflow files.
- Registry clean-install verification now pins npm to `https://registry.npmjs.org/` and PyPI to `https://pypi.org/simple` instead of inheriting alternate indexes; polluted local registry env was tested.

Fresh local verification:

- TS tests passed, 112 tests.
- Python tests passed, 101 tests plus 88 subtests.
- TS typecheck/build passed.
- Workflow policy and version sync passed.
- Registry install/import passed for npm/PyPI version `0.1.3`.
- Code scanning open alerts: 0. Open high/critical alerts: 0.
- Second-opinion review initially blocked on non-finite timeout and redirectable workflow-file env hooks; both were fixed.

Current blockers remain:

- PR #9 is still blocked by `REVIEW_REQUIRED`.
- Strict preflight is blocked: 6 ready rows, 18 blocked rows, no child reports.
- Missing live inputs still include API key, model IDs, embedding dimensions, image/TTS/ASR/voice fixtures, expected transcripts, pipeline ID/key, and idempotency opt-in.

## 2026-05-23 Agent 4 Checkpoint: Webhook Export Canary Coverage

Added release-gate coverage for the top-level webhook helper exports in both SDKs:

- Strict canary matrix now includes `webhooks.verify_signature.export` and `webhooks.construct_event.export`.
- TypeScript source canary now calls exported `verifyWebhookSignature` and `constructWebhookEvent` directly.
- Python source canary now calls exported `verify_webhook_signature` and `construct_webhook_event` directly.
- `LIVE-CANARIES.md` documents that webhook verification rows cover both client-attached helpers and top-level package exports.

Fresh local verification:

- Added failing TS preflight assertion first; it failed because the two export rows were absent.
- TS tests passed, 112 tests.
- Python tests passed, 101 tests plus 88 subtests.
- TS typecheck and build passed.
- Workflow policy, version sync, Python canary syntax, and `git diff --check` passed.
- Source canary report passed parity: TypeScript 8 passed/18 skipped, Python 8 passed/18 skipped.
- Strict preflight remains intentionally blocked but improved to 8 ready rows and 18 blocked rows.

Current blockers remain:

- PR #9 still needs non-author approval before protected merge.
- Strict live canaries still require scoped production canary env and fixtures for LLM, embeddings, image, TTS, ASR, voice pipeline, and idempotency.
- This checkpoint proves more local public helper surface, not live multimodal GA readiness.

## 2026-05-23 Agent 4 Checkpoint: Audio Binary Interface Canary Coverage

Added a TTS binary-interface row to the strict canary matrix:

- New row: `audio.speech.binary_interfaces`.
- TypeScript canary now validates `RunInfraAudioResponse.blob()` and `RunInfraAudioResponse.stream()` using real TTS calls when live TTS env is present.
- Existing `audio.speech.create` continues to validate `arrayBuffer()`.
- Python canary validates its raw `AudioResponse.content` byte surface under the same TTS readiness gate.
- `LIVE-CANARIES.md` now documents the language-specific binary response coverage.

Fresh local verification:

- Added failing TS preflight assertion first; it failed because `audio.speech.binary_interfaces` was absent.
- Review found the initial TS stream drain could hang after headers; fixed by bounding each raw stream read with `RUNINFRA_CANARY_TIMEOUT_SECONDS`, canceling the reader on timeout/error, and adding a regression assertion against bare `reader.read()`.
- TS tests passed, 113 tests.
- Python tests passed, 101 tests plus 88 subtests.
- TS typecheck and build passed.
- Workflow policy, version sync, Python canary syntax, and `git diff --check` passed.
- Source canary report passed parity: TypeScript 8 passed/19 skipped, Python 8 passed/19 skipped, expected rows 27.
- Strict preflight remains intentionally blocked: 8 ready rows and 19 blocked rows.

Current blockers remain:

- This does not prove live TTS until `RUNINFRA_TTS_MODEL` plus voice or reference-audio inputs are supplied.
- Strict live canaries still require scoped production canary env and fixtures for the broader multimodal matrix.

## 2026-05-23 Agent 4 Checkpoint: Image OpenAI Parameter Canary Coverage

Added a strict image parameter row for OpenAI-compatible image output coverage:

- New row: `openai.params.images`.
- Strict readiness now tracks `RUNINFRA_IMAGE_SIZE` and `RUNINFRA_IMAGE_RESPONSE_FORMAT`.
- TypeScript and Python canaries now send `size` plus `response_format` and assert exact image output matching for `url` versus `b64_json`.
- TS/Python READMEs and `LIVE-CANARIES.md` now document the live-gated image parameter row.

Fresh local verification:

- Added failing TS preflight assertion first; it failed because `openai.params.images` was absent.
- Review noted that image dimensions are not exposed in the response, so the row cannot prove the backend honored `size`; docs now state that size is sent under a strict readiness gate while `response_format` is asserted exactly.
- TS tests passed, 113 tests.
- Python tests passed, 101 tests plus 88 subtests.
- TS typecheck and build passed.
- Workflow policy, version sync, Python canary syntax, and `git diff --check` passed.
- Source canary report passed parity: TypeScript 8 passed/20 skipped, Python 8 passed/20 skipped, expected rows 28.
- Strict preflight remains intentionally blocked: 8 ready rows and 20 blocked rows.

Current blockers remain:

- This does not prove live image parameter support until `RUNINFRA_IMAGE_MODEL`, `RUNINFRA_IMAGE_SIZE`, and `RUNINFRA_IMAGE_RESPONSE_FORMAT` are supplied for a deployed image backend.
- Strict live canaries still require scoped production canary env and fixtures for the broader multimodal matrix.

## 2026-05-23 Agent 4 Checkpoint: ASR OpenAI Parameter Canary Coverage

Added a strict ASR parameter row for OpenAI-compatible audio transcription coverage:

- New row: `openai.params.audio.transcriptions`.
- Strict readiness now tracks `RUNINFRA_ASR_RESPONSE_FORMAT` and requires `RUNINFRA_ASR_LANGUAGE` for this parameter-specific row.
- TypeScript and Python canaries now send ASR `language`, a fixed canary `prompt`, and `response_format` as `json` or `verbose_json`.
- The row requires the deterministic fixture transcript to include `RUNINFRA_ASR_EXPECTED_TEXT`, asserts request ID exposure, and records only request ID plus response format, not transcript text or fixture contents.
- Docs now phrase ASR parameter coverage as live-gated proof, not already live-verified GA; ASR remains experimental until strict live artifacts pass.

Fresh local verification:

- Added failing TS/Python docs and child-canary parity assertions first; they failed on missing ASR parameter row/docs.
- TS tests passed, 114 tests.
- Python tests passed, 101 tests plus 88 subtests.
- TS typecheck and build passed.
- Workflow policy, version sync, Python canary syntax, and `git diff --check` passed.
- Source canary report passed parity: TypeScript 8 passed/21 skipped, Python 8 passed/21 skipped, expected rows 29.
- Strict preflight remains intentionally blocked: 8 ready rows and 21 blocked rows.
- Review found two doc precision issues: ASR row wording sounded already verified, and `RUNINFRA_ASR_LANGUAGE` was called optional while required for the new row. Both were fixed.
- Security/leakage review found no blocking issue and confirmed strict preflight still fails closed without live env.

Current blockers remain:

- This does not prove live ASR parameter support until `RUNINFRA_ASR_MODEL`, `RUNINFRA_ASR_LANGUAGE`, `RUNINFRA_ASR_RESPONSE_FORMAT`, `RUNINFRA_ASR_FIXTURE_PATH`, and `RUNINFRA_ASR_EXPECTED_TEXT` are supplied for a deployed ASR backend.
- Strict live canaries still require scoped production canary env and fixtures for the broader multimodal matrix.

## 2026-05-23 Agent 4 Checkpoint: TTS OpenAI Parameter Canary Coverage

Added a strict TTS parameter row for OpenAI-compatible audio speech coverage:

- New row: `openai.params.audio.speech`.
- Strict readiness now requires `RUNINFRA_TTS_RESPONSE_FORMAT` for this parameter-specific row.
- The response format is allowlisted to OpenAI speech values: `mp3`, `opus`, `aac`, `flac`, `wav`, or `pcm`.
- TypeScript and Python canaries now send `response_format` only in the dedicated parameter row, so base `audio.speech.create` and `audio.speech.binary_interfaces` remain isolated baseline TTS proof.
- The parameter row requires a non-empty non-JSON binary audio response and request ID exposure.
- Canary reports record `responseFormat: set_redacted`, request ID, content type, and byte length; they do not write the requested response-format value, prompt text beyond static canary code, or audio bytes.
- Docs now describe the row as live-gated TTS `response_format` request coverage without claiming exact codec or content-type matching.

Fresh local verification:

- Added failing TS/Python docs, child-canary parity, and strict preflight assertions first; they failed on the missing TTS parameter row.
- TS tests passed, 114 tests.
- Python tests passed, 101 tests plus 88 subtests.
- TS typecheck and build passed.
- Workflow policy, version sync, Python canary syntax, and `git diff --check` passed.
- Source canary report passed parity: TypeScript 8 passed/22 skipped, Python 8 passed/22 skipped, expected rows 30.
- Strict preflight remains intentionally blocked: 8 ready rows and 22 blocked rows.
- Review found two important issues: TTS response format needed an OpenAI allowlist, and the parameter row needed isolation from base TTS rows. Both were fixed.
- Security review found the same indirect leak risk through response format/content type; allowlisting plus redacted response-format evidence addresses it.

Current blockers remain:

- This does not prove live TTS parameter support until `RUNINFRA_TTS_MODEL`, valid voice/reference inputs, and a valid `RUNINFRA_TTS_RESPONSE_FORMAT` are supplied for a deployed TTS backend.
- Strict live canaries still require scoped production canary env and fixtures for the broader multimodal matrix.

## 2026-05-23 Agent 4 Checkpoint: Broader Artifact And Canary Leak Scanners

Added release-gate scanner hardening:

- New shared JS scanner policy: `scripts/secret-scan-policy.mjs`.
- npm package verification now uses the shared scanner instead of a private narrow regex list.
- live canary report leak checks now use the same shared scanner before reports are accepted.
- Python wheel/sdist verification now blocks the same broader credential and local-path families.
- Added direct TS/Python tests for GitHub fine-grained/session tokens, AWS access keys, Stripe-style keys, webhook signing secrets, JWT-looking values, RunInfra/generic secret keys, Google/Slack token shapes, Windows/macOS/Linux user paths, `.npmrc`, `.env`, `.env.local`, encrypted private keys, and PGP private key blocks.

Review fixes:

- Reviewer found Python scanner parity was broken because `.npmrc` and `.env` were over-escaped; added direct samples and fixed the regex.
- Reviewer found `whsec_` webhook signing secrets and encrypted/PGP private key headers were not covered; added direct samples and fixed both JS and Python scanners.
- Reviewer noted broader local-path rules can false-positive future README examples. This is accepted for release artifacts because the current production bar is "fail closed on local paths"; current package artifacts pass.

Fresh local verification:

- TS tests passed, 115 tests.
- Python tests passed, 102 tests plus 105 subtests.
- TS typecheck and build passed.
- Python verifier and live Python canary syntax passed.
- Workflow policy and version sync passed.
- Fresh npm tarball built and passed `verify-npm-package`.
- Fresh Python wheel/sdist built, passed `verify-python-package`, and passed `twine check`.
- Clean artifact install/import passed for npm and Python.
- Source canary report passed parity: TypeScript 8 passed/22 skipped, Python 8 passed/22 skipped, expected rows 30.
- Artifact canary report passed parity with the same 8 passed/22 skipped shape.
- Strict preflight remains intentionally blocked: 8 ready rows and 22 blocked rows.
- `git diff --check` passed with CRLF warnings only.

Current blockers remain:

- This scanner checkpoint improves release safety but does not prove live multimodal GA readiness.
- PR #9 still needs non-author approval before protected merge.
- Strict live canaries still require scoped production canary env and fixtures for LLM, embeddings, image, TTS, ASR, voice pipeline, unsupported-parameter live error proof, and idempotency replay.

## 2026-05-23 Agent 4 Checkpoint: Live Model-Not-Found Error Canary Coverage

Added a live endpoint error-mapping row:

- New row: `error.model.not_found`.
- Parent matrix now expects 31 rows.
- Strict readiness requires `RUNINFRA_API_KEY` for this row.
- TypeScript canary calls `models.retrieve("runinfra-sdk-canary-missing-model")` and requires `ModelNotFoundError`, status `404`, type `model_not_found`, and request ID exposure.
- Python canary mirrors the same missing-model lookup and mapped error assertions.
- `LIVE-CANARIES.md` documents the row as traced live error-mapping proof, not as broader GA readiness.

Fresh local verification:

- Confirmed no local `.env*`, audio fixtures, or relevant `RUNINFRA_*` canary env values were available in this shell, so strict live canaries could not be made green from local state.
- Added failing TS/Python tests first; they failed because `error.model.not_found` was absent from the runner, docs, and child canaries.
- TS tests passed, 116 tests.
- Python tests passed, 103 tests plus 105 subtests.
- TS typecheck and build passed.
- Python canary syntax passed.
- Workflow policy and version sync passed.
- Source canary report passed parity: TypeScript 8 passed/23 skipped, Python 8 passed/23 skipped, expected rows 31.
- Artifact canary report passed parity with the same 8 passed/23 skipped shape.
- Clean artifact install/import passed for npm and Python.
- Strict preflight remains intentionally blocked: 8 ready rows and 23 blocked rows. The new `error.model.not_found` row is blocked only on `RUNINFRA_API_KEY`.
- Fake-key preflight proved the new row becomes ready with an API key present and the fake key is not leaked in the report.
- Two second-opinion reviews passed with no blockers.

Current blockers remain:

- This improves live error-mapping coverage but does not prove live multimodal GA readiness.
- PR #9 still needs non-author approval before protected merge.
- Strict live canaries still require scoped production canary env and fixtures for LLM, embeddings, image, TTS, ASR, voice pipeline, unsupported-parameter live error proof, model-not-found live proof, and idempotency replay.

## 2026-05-23 Agent 4 Checkpoint: Webhook Delivery Surface Removal

Removed unshipped webhook delivery dead buttons from the SDK public surface:

- TypeScript `client.webhooks` now exposes only `verifySignature` and `constructEvent`; `create` and `list` are absent from runtime and declarations.
- Python `client.webhooks` now exposes only `verify_signature` and `construct_event`; `create` and `list` are absent.
- Strict canary matrix replaced `webhooks.create.unsupported` plus `webhooks.list.unsupported` with one `webhooks.delivery_surface.absent` row.
- Source/artifact canaries and clean-install checks now prove delivery methods are absent while local signature helpers remain callable.
- READMEs, changelogs, `LIVE-CANARIES.md`, and `AGENT-NOTES.md` document that delivery create/list is not public SDK surface until real gateway routes ship.
- Package versions moved to `0.1.4` because `0.1.3` is already published. `0.1.4` was checked as available: npm returned no match for `@runinfra/sdk@0.1.4`, and PyPI latest remains `runinfra 0.1.3`.
- `UnsupportedOperationError` remains exported only for older v0.1.x compatibility; current public helpers do not raise it.

Fresh local verification:

- Added failing TS/Python tests first; they failed on stale README/canary/runtime create/list public surface.
- TS typecheck passed.
- TS tests passed, 117 tests.
- Python tests passed, 104 tests plus 105 subtests.
- Python canary and package syntax passed.
- Workflow policy and version sync passed for `0.1.4`.
- Fresh npm tarball `runinfra-sdk-0.1.4.tgz` built and passed `verify-npm-package`.
- Fresh Python wheel/sdist `runinfra-0.1.4` built, passed `verify-python-package`, and passed `twine check`.
- Clean artifact install/import passed for npm and Python at `0.1.4`.
- Source canary report passed parity: TypeScript 7 passed/23 skipped, Python 7 passed/23 skipped, expected rows 30.
- Artifact canary report passed parity with the same 7 passed/23 skipped shape.
- Strict preflight remains intentionally blocked: 7 ready rows and 23 blocked rows.
- Runtime artifact checks showed TypeScript and Python webhook delivery methods absent and signature helpers callable.
- `git diff --check` passed with CRLF warnings only.

Current blockers remain:

- This removes a public dead surface but does not prove live multimodal GA readiness.
- PR #9 still needs non-author approval before protected merge.
- Strict live canaries still require scoped production canary env and fixtures for LLM, embeddings, image, TTS, ASR, voice pipeline, unsupported-parameter live error proof, model-not-found live proof, and idempotency replay.

## 2026-05-23 Agent 4 Checkpoint: Dev Tooling Alert Patch

Patched current moderate dev/build-tooling security alerts without changing SDK runtime dependencies or package allowlists:

- TypeScript test tooling moved to `vitest@3.2.4`.
- `pnpm` overrides now force `vite@6.4.2` and `esbuild@0.25.12`.
- Python pinned dev tooling moved to `pytest==9.0.3`.
- Resolved dependency graph proves `vitest@3.2.4`, `vite@6.4.2`, `esbuild@0.25.12`, and installed Python `pytest 9.0.3`.

Fresh local verification:

- `pnpm --dir typescript install --frozen-lockfile` passed.
- TS typecheck passed.
- TS tests passed, 117 tests.
- Python tests passed, 104 tests plus 105 subtests.
- Python canary/package syntax passed.
- Workflow policy and version sync passed for `0.1.4`.
- Fresh npm tarball `runinfra-sdk-0.1.4.tgz` built and passed `verify-npm-package`.
- Fresh Python wheel/sdist `runinfra-0.1.4` built, passed `verify-python-package`, and passed `twine check`.
- Clean artifact install/import passed for npm and Python at `0.1.4`.
- Source canary report passed parity: TypeScript 7 passed/23 skipped, Python 7 passed/23 skipped.
- Artifact canary report passed parity with the same 7 passed/23 skipped shape.
- Strict preflight remains intentionally blocked: 7 ready rows and 23 blocked rows.
- `git diff --check` passed with CRLF warnings only.

Current blockers remain:

- This closes dev-tooling alert exposure but does not prove live multimodal GA readiness.
- PR #9 still needs non-author approval before protected merge.
- Strict live canaries still require scoped production canary env and fixtures for LLM, embeddings, image, TTS, ASR, voice pipeline, unsupported-parameter live error proof, model-not-found live proof, and idempotency replay.

## 2026-05-23 Agent 4 Checkpoint: Python Sync-Only Posture Verified

Verified the Python production-ergonomics decision for v0.1.4:

- `python/README.md` documents that `RunInfra` is intentionally sync-only and tells FastAPI, Starlette, Django ASGI, and asyncio users to run SDK calls in a worker thread, task queue, or background job.
- The README explicitly says `AsyncRunInfra` is not shipped until it has the same unit, streaming, live-canary, and package-install coverage as the sync client.
- `python/tests/test_runinfra_sdk.py` includes `test_readme_documents_sync_only_async_runtime_guidance`, so the sync-only guidance remains a tested release artifact.

Current blockers remain:

- This closes the Python async/sync documentation choice for v0.1.4 but does not add an async client.
- PR #9 still needs non-author approval before protected merge.
- Strict live canaries still require scoped production canary env and fixtures for LLM, embeddings, image, TTS, ASR, voice pipeline, unsupported-parameter live error proof, model-not-found live proof, and idempotency replay.

## 2026-05-23 Agent 4 Checkpoint: Browser API-Key Protection Docs

Hardened the public browser-security posture without changing runtime behavior:

- Root `README.md` now says not to put `RUNINFRA_API_KEY` in browser code, and directs browser apps through a server route or backend proxy.
- TypeScript README now repeats the same production stance, documents that the SDK fails closed in browser runtimes, and keeps `dangerouslyAllowBrowser: true` framed as a controlled non-public runtime escape hatch.
- Public docs now state that ephemeral browser tokens are not shipped in v0.1.4 and must not be invented until scoped tokens, expiry, audit logging, and live canary coverage exist.
- TypeScript docs test now asserts the browser API-key, backend proxy, and no-ephemeral-token guidance across both root and package READMEs.

Fresh local verification:

- Added the browser-security docs test first; it failed on missing explicit browser/proxy/token guidance.
- Targeted browser-security docs test passed after the README updates.
- TS typecheck passed.
- TS tests passed, 118 tests.
- Python tests passed, 104 tests plus 105 subtests.
- TS build and pack passed; tarball contents remained `CHANGELOG.md`, `dist/index.d.ts`, `dist/index.js`, `LICENSE`, `package.json`, and `README.md`.
- `verify-npm-package` passed on fresh `runinfra-sdk-0.1.4.tgz`.
- Clean npm artifact install/import passed for TypeScript `0.1.4`.
- Workflow policy and version sync passed.
- `git diff --check` passed with CRLF warnings only.

Current blockers remain:

- This closes the documented browser-default security stance but does not ship ephemeral browser tokens.
- PR #9 still needs non-author approval before protected merge.
- Strict live canaries still require scoped production canary env and fixtures for LLM, embeddings, image, TTS, ASR, voice pipeline, unsupported-parameter live error proof, model-not-found live proof, and idempotency replay.

## 2026-05-23 Agent 4 Checkpoint: Streaming Cancellation Canary Closure

Hardened the streaming cancellation proof and docs:

- Python live canary partial-stream rows now close the active iterator returned by `iter(stream)` after consuming the cancellation prefix, instead of looking for a nonexistent `stream.close()` method.
- The Python unit suite imports `scripts/sdk-live-canary-python.py` and behavior-tests `read_some_stream()` with a fake close-tracking iterator, so the canary helper itself is now covered, not only string-checked.
- TypeScript and Python READMEs document early stream-consumer cleanup without overclaiming backend cancellation. TypeScript explains that breaking from `for await` cancels the local SSE reader, and Python shows `iterator.close()` for manual partial reads.
- `LIVE-CANARIES.md` now states that cancellation rows cover local stream-resource release after partial consumption for both languages, while backend transport cancellation remains best effort.

Fresh local verification:

- Targeted red tests failed first on missing streaming cancellation docs and on the old Python canary helper.
- Targeted streaming cancellation tests passed after the patch.
- `pnpm --dir typescript install --frozen-lockfile` passed.
- `python -m pip install -r python/requirements-dev.txt` passed with pinned tooling already installed.
- TS typecheck passed.
- TS tests passed, 119 tests.
- Python tests passed, 106 tests plus 105 subtests.
- Python canary/package syntax passed.
- Workflow policy and version sync passed for `0.1.4`.
- TS build and `pnpm --dir typescript pack` passed; npm tarball contents remained limited to changelog, dist, license, package.json, and README.
- Python wheel/sdist build, Python package verifier, and `twine check` passed.
- npm package verifier and clean artifact install/import for both npm and Python passed.
- Source and artifact canary parity passed: TypeScript 7 passed/23 skipped, Python 7 passed/23 skipped.
- Strict preflight remains intentionally blocked: 7 ready rows and 23 blocked rows because no scoped live canary env/fixtures are present in this shell.
- Code scanning refresh: 0 open alerts, 0 high/critical. Dependabot refresh: 3 open moderate default-branch alerts, 0 high/critical.
- Second-opinion review found no blockers; CodeRabbit CLI was not installed, so the available subagent review path was used.

Current blockers remain:

- This closes a cancellation canary correctness gap but does not prove live multimodal GA readiness.
- PR #9 still needs non-author approval before protected merge.
- Strict live canaries still require scoped production canary env and fixtures for LLM, embeddings, image, TTS, ASR, voice pipeline, unsupported-parameter live error proof, model-not-found live proof, and idempotency replay.

## 2026-05-23 Agent 4 Checkpoint: Slow-Consumer Streaming Canary Coverage

Added live-gated slow-consumer streaming rows for chat and Responses:

- New strict canary rows: `chat.completions.stream.slow_consumer` and `responses.stream.slow_consumer`.
- TypeScript and Python child canaries now drain real chat and Responses SSE streams while pausing after each event, assert terminal events, validate stream envelopes, and record only request IDs, event counts, and a redacted delay marker.
- `RUNINFRA_CANARY_STREAM_SLOW_CONSUMER_DELAY_MS` is optional, redacted in parent/child reports, defaults to 25 ms, and is bounded to a non-negative integer from 0 to 5000.
- Parent canary runner rejects invalid slow-consumer delay before spawning child canaries, so bad config cannot open live streams.
- Child canary slow rows validate the delay before stream creation in both TypeScript and Python.
- Slow-consumer sleep is bounded by `RUNINFRA_CANARY_TIMEOUT_SECONDS`, so a large valid delay fails closed instead of holding live canary jobs open.
- `LIVE-CANARIES.md` documents the new rows, env variable, redacted evidence, and timeout-bound behavior.

Fresh local verification:

- Added failing TS/Python slow-consumer tests first; they failed on missing rows, invalid-delay acceptance, missing child env redaction, post-open delay validation, and unbounded slow sleep.
- Targeted slow-consumer tests passed: TS 3 tests, Python 3 tests.
- `pnpm --dir typescript install --frozen-lockfile` passed with the existing esbuild ignored-build-script warning.
- `python -m pip install -r python/requirements-dev.txt` passed with pinned tooling already installed.
- TS typecheck passed.
- TS tests passed, 122 tests.
- Python tests passed, 109 tests plus 105 subtests.
- Python canary/package syntax passed.
- Workflow policy and version sync passed for `0.1.4`.
- TS build and `pnpm --dir typescript pack` passed; npm tarball contents remained limited to changelog, dist, license, package.json, and README.
- Python wheel/sdist build, Python package verifier, and `twine check` passed.
- npm package verifier and clean artifact install/import for both npm and Python passed.
- Source and artifact canary parity passed: TypeScript 7 passed/25 skipped, Python 7 passed/25 skipped, expected rows 32.
- Strict preflight remains intentionally blocked: 7 ready rows and 25 blocked rows because no scoped live canary env/fixtures are present in this shell.
- `git diff --check` passed with CRLF warnings only.
- Second-opinion review initially found two blockers: valid delays could exceed the job budget, and invalid delay could be validated after opening streams in direct child runs. Both were fixed and the final second-opinion review reported no blockers.

Current blockers remain:

- This adds live-gated slow-consumer proof but does not make strict live multimodal canaries green without production canary env/fixtures.
- PR #9 still needs non-author approval before protected merge.
- Strict live canaries still require scoped production canary env and fixtures for LLM, embeddings, image, TTS, ASR, voice pipeline, unsupported-parameter live error proof, model-not-found live proof, and idempotency replay.

## 2026-05-23 Agent 4 Checkpoint: Chat Stream Options Usage Canary Coverage

Added live-gated OpenAI-compatible chat stream-options coverage:

- New strict canary row: `openai.params.chat.stream_options`.
- TypeScript and Python child canaries now send `stream_options.include_usage: true` with a real streaming chat completion.
- The row drains the full stream, requires a terminal chat event, and requires a usage chunk with `choices: []`.
- The usage chunk must contain non-negative integer `prompt_tokens`, `completion_tokens`, and `total_tokens`.
- Reports record only request ID, event count, and `usage: "present"`; token counts, prompt text, and output text are not written.
- `LIVE-CANARIES.md` plus TS/Python READMEs document the new row as live-gated proof, not GA completion.

Fresh local verification:

- Added failing TS/Python docs and child-canary parity tests first; they failed on the missing row.
- Second-opinion review found the initial TS validator rejected valid `choices: []`; fixed and added a regression assertion.
- Second-opinion review then found the row accepted an empty usage object; fixed both languages to require numeric token fields without recording their values.
- Targeted chat stream-options tests passed: TS 1 test, Python 1 test.
- `pnpm --dir typescript install --frozen-lockfile` passed with the existing esbuild ignored-build-script warning.
- `python -m pip install -r python/requirements-dev.txt` passed with pinned tooling already installed.
- TS typecheck passed.
- TS tests passed, 123 tests.
- Python tests passed, 110 tests plus 105 subtests.
- Python canary/package syntax passed.
- Workflow policy and version sync passed for `0.1.4`.
- TS build and `pnpm --dir typescript pack` passed; npm tarball contents remained limited to changelog, dist, license, package.json, and README.
- Python wheel/sdist build, Python package verifier, and `twine check` passed.
- npm package verifier and clean artifact install/import for both npm and Python passed.
- Source and artifact canary parity passed: TypeScript 7 passed/26 skipped, Python 7 passed/26 skipped, expected rows 33.
- Strict preflight remains intentionally blocked: 7 ready rows and 26 blocked rows because no scoped live canary env/fixtures are present in this shell. The new row is blocked on `RUNINFRA_API_KEY` and `RUNINFRA_LLM_MODEL`.
- `git diff --check` passed with CRLF warnings only.
- Final second-opinion review reported no blockers. CodeRabbit CLI was not installed, so the available subagent review path was used.

Current blockers remain:

- This adds live-gated chat stream-options proof but does not make strict live multimodal canaries green without production canary env/fixtures.
- PR #9 still needs non-author approval before protected merge.
- Strict live canaries still require scoped production canary env and fixtures for LLM, embeddings, image, TTS, ASR, voice pipeline, unsupported-parameter live error proof, model-not-found live proof, and idempotency replay.

## 2026-05-23 Agent 4 Checkpoint: Responses Adapter Contract Documentation

Closed the documented contract mismatch for `/v1/responses`:

- Verified the RunPipe gateway source routes `POST /v1/responses` through `responsesRequestToChatCompletion`, `postWorkspaceChatCompletion`, and `chatResponseToResponsesResponse`, so the public SDK must describe it as an adapter instead of a full stateful Responses implementation.
- TypeScript and Python READMEs now state that RunInfra `/v1/responses` is a chat-completions compatibility adapter. They document supported `input` and `instructions` conversion, chat-completions forwarding, Responses-style rewrapping, and the lack of full Responses state, include, reasoning, tool, conversation-item, or background-job semantics.
- TypeScript public source now documents `ResponsesCreateRequest` as the compatibility-adapter request shape.
- Python `_Responses.create()` now has a docstring with the same adapter limitation.
- `LIVE-CANARIES.md` now says Responses canary rows prove the adapter envelope or semantic stream events, not full stateful Responses API semantics.
- TS/Python tests assert the docs and source stay aligned with the adapter contract.

Fresh local verification:

- Targeted TS/Python tests failed first on missing adapter docs/source wording.
- Targeted TS test passed: `pnpm --dir typescript test --run -t "OpenAI-compatible parameter subset"`.
- Targeted Python test passed: `python -m pytest python\tests\test_runinfra_sdk.py -q -k openai_parameter_subset`.
- `pnpm --dir typescript install --frozen-lockfile` passed with the existing esbuild ignored-build-script warning.
- `python -m pip install -r python\requirements-dev.txt` passed with pinned tooling already installed.
- Workflow policy and version sync passed for `0.1.4`.
- TS typecheck passed.
- TS tests passed, 123 tests.
- Python tests passed, 110 tests plus 105 subtests.
- Python package/canary syntax passed.
- TS build and `pnpm --dir typescript pack` passed; npm tarball contents remained limited to changelog, dist, license, package.json, and README.
- Python wheel/sdist build passed.
- npm package verifier, Python package verifier, and `twine check` passed.
- Clean artifact install/import passed for both npm and Python.
- Source and artifact canary parity passed: TypeScript 7 passed/26 skipped, Python 7 passed/26 skipped, expected rows 33.
- Strict preflight remains intentionally blocked: 7 ready rows and 26 blocked rows because no scoped live canary env/fixtures are present in this shell.
- `git diff --check` passed with CRLF warnings only.
- Code scanning refresh: 0 open alerts, 0 high/critical. Dependabot refresh: 3 open medium alerts, 0 high/critical.
- Final second-opinion review reported no blockers. CodeRabbit CLI was not installed, so the available subagent review path was used.

Current blockers remain:

- This closes the Responses adapter contract-doc gap but does not make strict live multimodal canaries green without production canary env/fixtures.
- PR #9 still needs non-author approval before protected merge.
- Strict live canaries still require scoped production canary env and fixtures for LLM, embeddings, image, TTS, ASR, voice pipeline, unsupported-parameter live error proof, model-not-found live proof, and idempotency replay.

## 2026-05-23 Agent 4 Checkpoint: Local Streaming Fault Canary Coverage

Added deterministic local streaming fault coverage for both public stream surfaces:

- New strict matrix rows: `chat.completions.stream.malformed_frame.local`, `chat.completions.stream.disconnect.local`, `chat.completions.stream.stalled_read.local`, `responses.stream.malformed_frame.local`, `responses.stream.disconnect.local`, and `responses.stream.stalled_read.local`.
- TypeScript child canary uses local `Response` and `ReadableStream` bodies, never production gateway calls, and asserts typed `RunInfraStreamParseError`, `RunInfraConnectionError`, and `RunInfraTimeoutError` behavior with request IDs.
- Python child canary uses a local transport plus byte iterators that inject malformed frames, connection resets, and timeout errors, also without production calls.
- Runner readiness marks these `.local` rows as ready without env because they prove installed SDK stream behavior, not deployed model behavior.
- TS/Python tests now assert runner, child canaries, and docs stay in parity for all six rows.
- `LIVE-CANARIES.md` documents the local rows separately from live network streaming rows and includes them in the matrix list.

Fresh local verification:

- Targeted local streaming-fault tests passed: TS 1 test, Python 1 test.
- Python canary syntax passed.
- Source canary report passed: TypeScript 13 passed/26 skipped, Python 13 passed/26 skipped.
- TS typecheck passed.
- TS tests passed, 124 tests.
- Python tests passed, 111 tests plus 105 subtests.
- Workflow policy and version sync passed for `0.1.4`.
- TS build and `pnpm --dir typescript pack` passed; npm tarball contents remained limited to changelog, dist, license, package.json, and README.
- Python wheel/sdist build, Python package verifier, and `twine check` passed.
- npm package verifier and clean artifact install/import for both npm and Python passed.
- Artifact canary report passed: TypeScript 13 passed/26 skipped, Python 13 passed/26 skipped.
- Strict preflight remains intentionally blocked: 13 ready rows and 26 blocked rows because no scoped live canary env/fixtures are present in this shell.
- `git diff --check` passed with CRLF warnings only.
- Second-opinion review found no Critical or Important issues. Its minor docs finding was fixed.

Current blockers remain:

- This proves deterministic SDK stream-fault handling, not live multimodal GA readiness.
- PR #9 still needs non-author approval before protected merge.
- Strict live canaries still require scoped production canary env and fixtures for LLM, embeddings, image, TTS, ASR, voice pipeline, unsupported-parameter live error proof, model-not-found live proof, and idempotency replay.

## 2026-05-23 Agent 4 Checkpoint: Local Retry-Safety Canary Coverage

Added deterministic local retry-policy coverage for installed TypeScript and Python SDK packages:

- New strict matrix rows: `retry.safety.get.local`, `retry.safety.post.requires_idempotency.local`, `retry.safety.post.with_idempotency.local`, `retry.safety.stream.no_retry.local`, `retry.safety.audio_binary.no_retry.local`, and `retry.safety.audio_multipart.no_retry.local`.
- TypeScript child canary uses local fake `fetch` responses and a local base URL to prove safe GET retries, non-idempotent JSON POSTs do not retry, idempotent JSON POSTs do retry with `Idempotency-Key`, and streaming, binary TTS, and multipart ASR requests are sent once even with idempotency.
- Python child canary mirrors the same policy through an injected local transport and queued fake responses.
- Runner readiness marks these `.local` rows as ready without env because they prove SDK retry behavior, not deployed model behavior.
- TS/Python tests assert runner, child canaries, and docs stay in parity for all six rows.
- `LIVE-CANARIES.md` documents the local rows separately from live idempotency replay and live network rows.

Fresh local verification:

- Targeted local retry-safety tests passed: TS 1 test, Python 1 test.
- Python canary syntax passed.
- Source canary report passed: TypeScript 19 passed/26 skipped, Python 19 passed/26 skipped.
- TS typecheck passed.
- TS tests passed, 125 tests.
- Python tests passed, 112 tests plus 105 subtests.
- Workflow policy and version sync passed for `0.1.4`.
- TS build and `pnpm --dir typescript pack` passed; npm tarball contents remained limited to changelog, dist, license, package.json, and README.
- Python wheel/sdist build, Python package verifier, and `twine check` passed.
- npm package verifier and clean artifact install/import for both npm and Python passed.
- Artifact canary report passed: TypeScript 19 passed/26 skipped, Python 19 passed/26 skipped.
- Strict preflight remains intentionally blocked: 19 ready rows and 26 blocked rows because no scoped live canary env/fixtures are present in this shell.
- `git diff --check` passed with CRLF warnings only.
- Second-opinion review found no Critical, Important, or Minor issues.

Current blockers remain:

- This proves deterministic SDK retry-safety behavior, not live multimodal GA readiness.
- PR #9 still needs non-author approval before protected merge.
- Strict live canaries still require scoped production canary env and fixtures for LLM, embeddings, image, TTS, ASR, voice pipeline, unsupported-parameter live error proof, model-not-found live proof, and idempotency replay.

## 2026-05-23 Agent 4 Checkpoint: Source-Aware Public Surface Coverage Gate

Added a no-network release gate that maps public SDK surfaces to strict canary rows:

- New command: `node scripts/run-sdk-live-canaries.mjs --verify-surface-coverage`.
- The gate validates duplicate surface entries, empty row lists, unknown row references, and source/docs-declared public surfaces without mapped canary rows.
- Declared public surfaces are derived from TypeScript source, Python source, and package README supported-route sections.
- Current derived state: 22 declared public surfaces, 26 mapped coverage surfaces, 45 strict canary rows, 0 uncovered surfaces.
- Stream iterator surfaces are explicitly mapped: `RunInfraStream[Symbol.asyncIterator]` and `RunInfraStream.__iter__`.
- Full-run reports and strict preflight reports now include `surfaceCoverage`; even config-error and artifact-setup early failures carry the same manifest result and merge manifest errors into parity failures.
- Promotion docs now place surface coverage before strict preflight and artifact live canaries, and the TS/Python README tests assert that order.

Fresh local verification:

- `pnpm --dir typescript exec tsc -p tsconfig.json --noEmit` passed.
- `pnpm --dir typescript test` passed, 127 tests.
- `python -m pytest python\tests -q` passed, 113 tests plus 105 subtests.
- `node scripts\verify-workflow-policy.mjs` passed.
- `node scripts\verify-version-sync.mjs` passed.
- `node scripts\run-sdk-live-canaries.mjs --verify-surface-coverage` passed with 22 declared surfaces, 26 mapped surfaces, and 0 uncovered surfaces.
- `pnpm --dir typescript build` and `pnpm --dir typescript pack` passed; npm tarball contents remained limited to changelog, dist, license, package.json, and README.
- `python -m build python`, `python scripts\verify-python-package.py python\dist`, and `python -m twine check python\dist\*` passed.
- `node scripts\verify-npm-package.mjs typescript\runinfra-sdk-*.tgz` passed.
- `node scripts\verify-clean-installs.mjs --package both --mode artifact` passed.
- Source and artifact canary parity passed: TypeScript 19 passed/26 skipped, Python 19 passed/26 skipped.
- Strict preflight remains intentionally blocked: 19 ready rows and 26 blocked rows because scoped production canary env/fixtures are not present in this shell.
- `git diff --check` passed with CRLF warnings only.
- Two independent read-only reviews initially found blockers: self-only manifest validation, missing surface coverage in early failure reports, missing stream iterator coverage, and README order tests that only checked substrings. Follow-up fixes addressed all findings; both reviewers returned Ready with no Critical, Important, or Minor findings. CodeRabbit CLI was not installed, so the available subagent review path was used.

Current blockers remain:

- This closes the public-surface coverage gate but does not make strict live multimodal canaries green.
- PR #9 still needs non-author approval before protected merge.
- Strict live canaries still require scoped production canary env and fixtures for LLM, embeddings, image, TTS, ASR, voice pipeline, unsupported-parameter live error proof, model-not-found live proof, and idempotency replay.

## 2026-05-24 Agent 4 Checkpoint: RunPipe Env Aliases And Model Catalog Readiness

Added two live-readiness hardening changes:

- Parent live-canary runner now accepts legacy RunPipe canary env aliases and forwards them to child canaries as canonical `RUNINFRA_*` env names. Reports list only alias names used, not values.
- `models.list` now fails closed when any configured `RUNINFRA_*_MODEL` canary env value is absent from the live `/v1/models` catalog. Reports still record only request ID and item count, not configured or missing model IDs.
- Second-opinion review found stale `TEST_PIPELINE_ID` could still appear as a redacted env field when canonical `RUNINFRA_VOICE_PIPELINE_ID` won. Fixed by keeping `TEST_PIPELINE_ID` as an accepted alias but removing it from parent and child report env lists.

Fresh local verification:

- Added failing TS/Python parity tests first; they failed on missing catalog enforcement, then passed after the patch.
- `pnpm --dir typescript exec tsc -p tsconfig.json --noEmit` passed.
- `pnpm --dir typescript test` passed, 130 tests.
- `python -m pytest python\tests -q` passed, 114 tests plus 105 subtests.
- `python -m py_compile scripts\sdk-live-canary-python.py scripts\verify-python-package.py` passed.
- `node scripts\run-sdk-live-canaries.mjs --verify-surface-coverage` passed with 22 declared surfaces, 26 mapped surfaces, 45 rows, and 0 uncovered surfaces.
- `node scripts\run-sdk-live-canaries.mjs --package-source source --report artifacts\sdk\live-canary-source-no-env.json` passed: TypeScript 19 passed/26 skipped, Python 19 passed/26 skipped.
- `pnpm --dir typescript build` and `pnpm --dir typescript pack` passed; npm tarball contents remained limited to changelog, dist, license, package.json, and README.
- `python -m build python`, `python scripts\verify-python-package.py python\dist`, and `python -m twine check python\dist\*` passed.
- `node scripts\verify-npm-package.mjs typescript\runinfra-sdk-0.1.4.tgz` passed.
- `node scripts\verify-clean-installs.mjs --package both --mode artifact` passed.
- `node scripts\run-sdk-live-canaries.mjs --package-source artifact --report artifacts\sdk\live-canary-artifact-no-env.json` passed: TypeScript 19 passed/26 skipped, Python 19 passed/26 skipped.
- `git diff --check` passed with CRLF warnings only.
- After the review fix, targeted TS alias/catalog tests passed, targeted Python catalog/surface tests passed, full TS tests passed at 130 tests, full Python tests passed at 114 tests plus 105 subtests, artifact scanners passed, `twine check` passed, clean artifact installs passed, and artifact no-env canaries passed again at TypeScript 19 passed/26 skipped and Python 19 passed/26 skipped.

RunPipe live env evidence:

- Strict preflight using the redacted RunPipe canary env file remains blocked: 34 ready rows, 11 blocked rows, 16 missing input groups. Alias names used were `RUNINFRA_LLM_MODEL<=TEST_MODEL`, `RUNINFRA_TTS_TASK_TYPE<=TEST_TTS_TASK_TYPE`, and `RUNINFRA_VOICE_PIPELINE_ID<=TEST_PIPELINE_ID`.
- Updated strict preflight and source reports no longer include `TEST_PIPELINE_ID` as an env field; it appears only as the alias name used for `RUNINFRA_VOICE_PIPELINE_ID`.
- Source canary using the same RunPipe env exited non-zero as expected: TypeScript 20 passed/14 failed/11 skipped, Python 20 passed/14 failed/11 skipped.
- The failed live rows include `models.list`, `models.retrieve.llm`, chat, Responses, streaming, and unsupported-parameter rows. This confirms the SDK now fails readiness when the configured model is not listed by the live catalog.
- The redacted live report passed the shared forbidden-content scanner and did not contain any long values from the RunPipe env file.

Current blockers remain:

- This proves the catalog readiness gate, not live multimodal GA.
- The scoped canary workspace still lacks active verified deployments/catalog entries for the configured model, so live LLM/chat/Responses rows fail.
- Strict live canaries still need deployed and catalog-listed LLM, embeddings, image, TTS, ASR, and voice resources plus deterministic fixtures and idempotency replay evidence.
- PR #9 still needs non-author approval before protected merge.

## 2026-05-24 Agent 4 Checkpoint: Env-File Preflight Fix And Fresh Package Gates

Fixed production-readiness bugs in the SDK live-canary runner:

- `scripts/run-sdk-live-canaries.mjs` now loads `--runinfra-env-file` before strict preflight and before child canaries spawn.
- The runner still tolerates legacy `--env-file` when it reaches the script, but `--runinfra-env-file` is the safe project flag because Node 24 can consume `--env-file` before script argument parsing.
- Env-file values are only applied when the current process env does not already contain a non-empty value in the same canonical/alias group, so explicit shell env still wins.
- Added a TypeScript regression test proving strict preflight can become ready from a temporary canary env file without leaking the fake API key, transcript text, fixture path, model IDs, or pipeline ID.
- Added a regression proving an explicit shell alias such as `TEST_ASR_FILE` wins over a canonical env-file value such as `RUNINFRA_ASR_FIXTURE_PATH`.
- Added a regression for the Node-consumed `--env-file` path with inline comments, so fallback parsing matches Node's env-file values when deciding whether to remove env-file canonical keys behind explicit aliases.
- Added a regression proving missing env-file errors do not print the supplied local path.
- Replaced secret-shaped fake test API keys with non-token-shaped placeholders so source/report scans do not produce avoidable false positives.

Fresh TDD evidence:

- New regression failed first because the runner ignored script-level env-file loading.
- Hubble second-opinion review found a real blocker: env-file canonical keys could mask explicit shell aliases. Added the failing alias-precedence regression, fixed the loader, and reran the target.
- Hubble re-review found a second blocker in the Node-consumed `--env-file` path with inline comments. Matched Node's unquoted-comment parsing and added a regression for that path.
- Hubble final re-review after the `process.execArgv` coverage fix returned `NO BLOCKERS`.
- `pnpm --dir typescript test --run -t "runinfra-env-file|Node consumes|redacts missing"` passed after the fix: 4 targeted tests.

Fresh local verification after the fix:

- `pnpm --dir typescript exec tsc -p tsconfig.json --noEmit` passed.
- `pnpm --dir typescript test` passed: 134 tests.
- `python -m pytest python\tests -q` passed: 114 tests plus 105 subtests.
- `python -m py_compile scripts\sdk-live-canary-python.py scripts\verify-python-package.py` passed.
- `pnpm --dir typescript build` passed.
- `pnpm --dir typescript pack --pack-destination ..\artifacts\npm-local` passed. Tarball contents remain limited to changelog, dist, license, package.json, and README.
- `python -m build python --outdir artifacts\python-local` passed.
- `node scripts\verify-npm-package.mjs artifacts\npm-local\runinfra-sdk-0.1.4.tgz` passed.
- `python scripts\verify-python-package.py artifacts\python-local` passed.
- `python -m twine check artifacts\python-local\*` passed.
- `node scripts\verify-clean-installs.mjs --mode artifact --npm-tarball artifacts\npm-local\runinfra-sdk-0.1.4.tgz --python-wheel artifacts\python-local\runinfra-0.1.4-py3-none-any.whl` passed.
- `node scripts\run-sdk-live-canaries.mjs --verify-surface-coverage` passed: 22 declared surfaces, 26 mapped surfaces, 45 rows, 0 uncovered surfaces.
- Source no-env canaries passed: TypeScript 19 passed/26 skipped, Python 19 passed/26 skipped.
- Artifact no-env canaries passed: TypeScript 19 passed/26 skipped, Python 19 passed/26 skipped.
- Workflow policy passed with OIDC/provenance/SHA-pinned/no long-lived registry token checks.
- Version sync passed for `0.1.4`.

Registry state:

- npm registry currently exposes `@runinfra/sdk` versions `0.1.0`, `0.1.1`, `0.1.2`, and `0.1.3`; `0.1.4` is not published.
- PyPI currently exposes `runinfra` versions `0.1.0`, `0.1.1`, `0.1.2`, and `0.1.3`; `0.1.4` is not published.
- Registry clean-install for `0.1.4` cannot pass until trusted publishing publishes that version.
- Registry clean-install for `0.1.3` fails the current GA surface gate because published `0.1.3` still exposes webhook delivery `create/list`. This is expected and is why local artifact `0.1.4` must be published through the protected trusted path after live gates are green.

RunPipe env preflight after the env-file fix:

- The strict preflight command now reads the redacted RunPipe canary env file through `--runinfra-env-file` without relying on Node's own `--env-file` option.
- Result: blocked, 34 ready rows and 11 blocked rows.
- Alias keys used: `RUNINFRA_LLM_MODEL`, `RUNINFRA_TTS_TASK_TYPE`, and `RUNINFRA_VOICE_PIPELINE_ID`.
- Remaining blocked rows:
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
  - `idempotency.replay.responses`

Current blockers remain:

- This fixes the env-file readiness gate and proves local artifacts, but does not make strict live multimodal canaries green.
- `0.1.4` is not on npm/PyPI yet.
- Live embeddings/image/TTS/ASR/voice/idempotency replay proof remains missing.
- RunPipe production still needs the gateway contract patch deployed before production source canaries can turn the known streaming/unsupported-parameter rows green.
- Do not call SDK GA and do not publish a GA release until strict live canaries, registry install/import, CodeQL/security checks, docs, and independent review are all green.

## 2026-05-24 Agent 4 Checkpoint: Safe Env-File Docs For Promotion Commands

Closed a follow-up documentation gap from the env-file runner fix:

- Root `README.md`, `LIVE-CANARIES.md`, `AGENT-NOTES.md`, `typescript/README.md`, and `python/README.md` now document `--runinfra-env-file <path-to-env-file>` for local canary input files.
- The same docs now explicitly warn not to use Node's `--env-file` option in promotion commands because the runner must own env-file parsing, explicit shell-env precedence, and redacted reporting.
- TypeScript and Python doc tests now assert the safe flag and warning stay present across all five promotion/handoff docs.

Fresh TDD evidence:

- Added the doc tests first. They failed because the docs did not mention `--runinfra-env-file <path-to-env-file>`.
- After the docs update, `pnpm --dir typescript test --run -t "safe live-canary env-file"` passed: 1 targeted test.
- `python -m pytest python\tests -q -k "safe_live_canary_env_file"` passed: 1 targeted test.

Fresh local verification after the doc update:

- `pnpm --dir typescript exec tsc -p tsconfig.json --noEmit` passed.
- `pnpm --dir typescript test` passed: 135 tests.
- `python -m pytest python\tests -q` passed: 115 tests plus 105 subtests.
- `python -m py_compile scripts\sdk-live-canary-python.py scripts\verify-python-package.py` passed.
- `pnpm --dir typescript build` passed.
- `python -m build python --outdir artifacts\python-local` passed.
- `pnpm --dir typescript pack --pack-destination ..\artifacts\npm-local` passed. Tarball contents remain limited to changelog, dist, license, package.json, and README.
- `node scripts\verify-npm-package.mjs artifacts\npm-local\runinfra-sdk-0.1.4.tgz` passed.
- `python scripts\verify-python-package.py artifacts\python-local` passed.
- `python -m twine check artifacts\python-local\*` passed.
- `node scripts\verify-clean-installs.mjs --mode artifact --npm-tarball artifacts\npm-local\runinfra-sdk-0.1.4.tgz --python-wheel artifacts\python-local\runinfra-0.1.4-py3-none-any.whl` passed.
- `node scripts\run-sdk-live-canaries.mjs --verify-surface-coverage` passed: 22 declared surfaces, 26 mapped surfaces, 45 rows, 0 uncovered surfaces.
- Source no-env canaries passed: TypeScript 19 passed/26 skipped, Python 19 passed/26 skipped.
- Artifact no-env canaries passed: TypeScript 19 passed/26 skipped, Python 19 passed/26 skipped.
- Workflow policy passed with OIDC/provenance/SHA-pinned/no long-lived registry token checks.
- Version sync passed for `0.1.4`.
- The strict preflight command using the redacted RunPipe canary env file still exits non-zero as expected: blocked, 34 ready rows and 11 blocked rows.
- Diff whitespace check passed with CRLF warnings only.
- Focused secret-shaped pattern scan over changed docs/tests reported 0 hits; package-facing docs also avoid concrete local paths and env-file names.
- Second-opinion review reported no blockers. Its warnings about the local env-file path in this goal file and the scan wording were addressed in this checkpoint; follow-up re-review returned `NO BLOCKERS`.

Current blockers remain:

- This improves operator safety and release documentation, but does not make strict live multimodal canaries green.
- `0.1.4` is not on npm/PyPI yet.
- Live embeddings/image/TTS/ASR/voice/idempotency replay proof remains missing.
- RunPipe production still needs the gateway contract patch deployed before production source canaries can turn the known streaming/unsupported-parameter rows green.
- Do not call SDK GA and do not publish a GA release until strict live canaries, registry install/import, CodeQL/security checks, docs, and independent review are all green.

## 2026-05-24 Agent 4 Checkpoint: Fresh Live Discovery And Source Canary Evidence

Refreshed current production live evidence after the safe env-file docs commit:

- RunPipe SDK live-target discovery with a 45s inference probe reported `targets_incomplete` and initially classified the only LLM candidate as non-promotable because the `/openai/v1/chat/completions` probe timed out.
- Re-running the same discovery with a 120s probe warmed the existing LLM endpoint and selected the LLM target successfully.
- The long-probe discovery still reported missing active verified targets for embeddings, image, TTS, and ASR.
- Current strict SDK preflight using the redacted RunPipe canary env file remains blocked: 34 ready rows and 11 blocked rows.
- Current source canaries using the same redacted RunPipe canary env file exited non-zero with matching TypeScript and Python summaries: 31 passed, 3 failed, 11 skipped.

Current source-canary failed rows in both SDKs:

- `chat.completions.stream.final`
- `chat.completions.stream.slow_consumer`
- `error.body.unsupported_parameter`

Current source-canary skipped rows in both SDKs:

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
- `idempotency.replay.responses`

Interpretation:

- LLM chat/Responses baseline is reachable after a longer warm probe, but strict GA remains blocked.
- The three failed rows are the known production gateway contract gaps that need the RunPipe gateway patch deployed.
- The skipped rows still require deployed and catalog-listed embeddings, image, TTS, ASR, voice fixtures, and explicit idempotency replay evidence.
- Do not retry paid modality provisioning blindly; previous embedding provisioning attempts failed and were cleaned up. The next modality work needs a proven template or runtime/bridge fix before inserting production catalog rows.

## 2026-05-24 Agent 4 Checkpoint: Embeddings Readiness Claim Tightening

Corrected SDK package metadata and handoff docs that implied embeddings were already tested at the same level as the reachable LLM path:

- TypeScript and Python package descriptions now say "LLM and embeddings contract-tested" instead of "LLM + embeddings tested".
- Root README, package READMEs, and AGENT-NOTES now say embeddings are beta and contract-tested, but not strict live-canary verified in the current promotion artifacts.
- TypeScript and Python changelogs now state that live coverage is partial for LLM and blocked for embeddings until strict promotion artifacts include a deployed embedding target.
- Added regression tests so the package metadata and docs cannot drift back to the overclaim while the live embedding target remains missing.

Fresh targeted verification:

- `pnpm --dir typescript test --run -t "overclaim embeddings|modality status|fresh dist"` passed: 3 tests passed, 133 skipped.
- `python -m pytest python\tests\test_runinfra_sdk.py -q -k "overclaim_embeddings or pyproject_uses_non_deprecated_license_metadata"` passed: 2 tests passed, 114 deselected.

Fresh broader verification:

- `pnpm --dir typescript test` passed: 136 tests.
- `python -m pytest python\tests -q` passed: 116 tests plus 105 subtests.
- `pnpm --dir typescript exec tsc -p tsconfig.json --noEmit` passed.
- `pnpm --dir typescript build` passed.
- `python -m build python --outdir artifacts\python-local` passed.
- `pnpm --dir typescript pack --pack-destination ..\artifacts\npm-local` passed. Tarball contents remain changelog, dist, license, package.json, and README.
- `node scripts\verify-npm-package.mjs artifacts\npm-local\runinfra-sdk-0.1.4.tgz` passed.
- `python scripts\verify-python-package.py artifacts\python-local` passed.
- `python -m twine check artifacts\python-local\*` passed.
- `node scripts\verify-clean-installs.mjs --mode artifact --npm-tarball artifacts\npm-local\runinfra-sdk-0.1.4.tgz --python-wheel artifacts\python-local\runinfra-0.1.4-py3-none-any.whl` passed.
- Package/docs scan for the old overclaim strings returned no hits outside the new negative assertions in tests.

Current blockers remain:

- This closes a public-readiness claim gap, not live multimodal readiness.
- Strict live canaries still need deployed and catalog-listed embeddings, image, TTS, ASR, voice fixtures, and explicit idempotency replay evidence.
- RunPipe production still needs the gateway contract patch deployed before production source canaries can turn the known streaming/unsupported-parameter rows green.

## Compact Optimal SDK Goal (Under 3800 Chars)

Take `runinfra-sdk` from secure beta to production-grade GA without weakening security or overstating readiness. Done means the TypeScript and Python packages install cleanly from npm/PyPI, expose stable OpenAI-compatible request shapes, and pass local, artifact, registry, and live canary gates for every surface we claim: models, chat completions, Responses, streaming SSE, embeddings, image generation, audio speech, audio transcription, voice pipeline, errors, request IDs, retries, idempotency, and webhook signature helpers.

Method: read current repo state first, patch narrowly, keep TS and Python behavior aligned, add failing tests before fixes, run full package verification, scan artifacts for secrets, source maps, local paths, private config, caches, fixtures, `.env`, and `.npmrc`, and update docs only to claims proven by tests or live artifacts. Any change over 2 files or 100 lines needs independent review.

Release bar: no long-lived npm/PyPI tokens, no secrets in reports/logs/artifacts, no direct browser API-key use, and trusted publishing only through protected GitHub OIDC workflows with provenance. Merge/publish only after strict live canaries pass with no required skips for every GA-claimed modality, registry clean-install/import passes for the exact version, CodeQL/security checks are clean or explicitly accepted, docs match behavior, and protected main receives required non-author review.

Current non-GA blockers to close before publish: deploy the RunPipe gateway contract patch so streaming final/slow-consumer and unsupported-parameter rows pass; provision or catalog verified embeddings, image, TTS, ASR, and voice targets plus deterministic fixtures; prove idempotency replay; finish Python explicit signature hardening; rerun source, artifact, registry, and live canaries; record evidence in this file. Until those are green, call it beta contract-tested, not production GA.

## 2026-05-24 Agent 4 Checkpoint: Python Explicit Request Signatures

Finished Python SDK public-signature hardening:

- Public Python request helpers now use explicit OpenAI-style keyword-only parameters instead of arbitrary `**kwargs`.
- `extra_body` is the only deliberate JSON/body extension hatch for gateway compatibility probes or newly rolled out fields.
- `extra_body` rejects non-mappings, blank/non-string keys, and any override of typed request fields, including omitted typed fields such as `stream`.
- Chat, Responses, embeddings, TTS, ASR, images, and webhook helper methods were tightened; voice pipeline was already explicit.
- ASR multipart validation still covers typed fields and `extra_body` fields before body construction.
- Python unsupported-parameter live canary now sends the probe through `extra_body`.
- Python README and changelog document the explicit-parameter behavior without claiming GA.

Fresh verification:

- Targeted signature/`extra_body` tests passed: 4 tests, 9 subtests.
- Full Python tests passed: 120 tests, 114 subtests.
- Python canary/verifier syntax compile passed.
- Python wheel/sdist built in `artifacts/python-local` and `python/dist`.
- Python package scanner passed for both artifact locations.
- `twine check` passed for both artifact locations.
- Clean artifact install/import passed for the fresh local Python wheel.
- Source no-env canaries passed: TypeScript 19 passed/26 skipped, Python 19 passed/26 skipped.
- Artifact no-env canaries passed after rebuilding `python/dist`: TypeScript 19 passed/26 skipped, Python 19 passed/26 skipped.
- Surface coverage verification passed: 22 declared surfaces, 26 mapped surfaces, 45 rows, 0 uncovered surfaces.
- `git diff --check` passed with CRLF warnings only.
- Source grep found no public SDK `**kwargs` definitions in `python/runinfra/__init__.py`.
- CodeRabbit CLI was not installed, so the external CodeRabbit path was unavailable.
- Independent read-only reviewer returned `NO BLOCKERS`; residual curated-list risk was addressed with a source-level no-`**kwargs` regression test.

Current blockers remain:

- This closes the Python public signature gap, not full GA readiness.
- `0.1.4` is still not published to npm/PyPI.
- Strict live canaries still need deployed and catalog-listed embeddings, image, TTS, ASR, voice fixtures, idempotency replay proof, and the RunPipe gateway contract patch for known streaming/unsupported-parameter rows.

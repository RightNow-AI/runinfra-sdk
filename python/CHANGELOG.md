# Changelog

All notable changes to the `runinfra` Python SDK are documented here. This
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.4] - 2026-05-23

### Changed
- Removed unshipped webhook delivery `create` / `list` methods from the
  public `client.webhooks` surface. Local signature verification remains
  available through `verify_signature`, `construct_event`,
  `verify_webhook_signature`, and `construct_webhook_event`.
- Replaced the live-canary unsupported-webhook rows with
  `webhooks.delivery_surface.absent`, so source, artifact, and clean-install
  gates prove the dead delivery methods are absent instead of merely
  fail-closed.
- Replaced arbitrary `**kwargs` on public request helpers with explicit
  OpenAI-style keyword parameters plus an `extra_body` mapping for deliberate
  gateway compatibility probes.
- Kept `responses.create()` keyword parameters limited to the
  gateway-supported Responses compatibility adapter fields; stateful OpenAI
  Responses fields remain unsupported unless the gateway adds them.
- Limited `extra_body` to JSON body helpers; multipart ASR uses explicit typed
  parameters only, matching the TypeScript SDK's extension posture.
- Documented concrete asyncio and FastAPI background-task patterns for the
  sync-only Python client while keeping `AsyncRunInfra` out of the public
  surface until it has full parity coverage.
- Updated Responses adapter docs to list the typed `top_p`, `tools`,
  `tool_choice`, and `response_format` fields.
- Added Python overloads so `stream=True` calls on chat completions and
  Responses statically narrow to `RunInfraStream` while non-stream calls keep
  their typed response envelopes.
- Hardened parent live-canary parity so strict reports fail when child reports
  contain failed/skipped rows or inconsistent summary counts.
- Hardened promotion readiness verification so forged or stale readiness
  summaries cannot contradict the strict readiness rows.
- Included `typescript/tsconfig.json` and `python/MANIFEST.in` in promotion
  source digests so source-map or package-manifest changes require fresh
  readiness and live-canary evidence before publish.
- Corrected modality-status docs so chat/responses are not described as
  strict-live green before fresh production artifact canaries pass.
- Extended package leakage scanners to reject PyPI/Twine and pip credential
  config material such as `.pypirc`, `.netrc`, `pip.conf`, and `pip.ini`.
- Added a local strict canary row proving user-supplied client request IDs are
  sent as headers and do not leak into JSON request bodies.
- Added a local strict canary row proving custom request headers are sent as
  headers, do not leak into JSON bodies, and cannot override SDK credentials.
- Added a local strict canary row proving per-request timeout options map to
  timeout errors without leaking timeout option names into JSON bodies.
- Added a local strict canary row proving explicit JSON `extra_body` extensions
  are serialized deliberately, do not serialize SDK option names, reject typed
  field overrides, and stay out of multipart ASR helpers.
- Added a local strict canary row proving unknown direct request fields are
  rejected before network sends and that unsupported JSON body probes must use
  `extra_body`.
- Added a local strict canary row proving the Python package exposes no browser
  token helper surface while the TypeScript package enforces the browser
  API-key guard.
- Added a `[EXPERIMENTAL]` docstring to the public voice pipeline surface so
  runtime help matches its not-yet-live-verified status.
- Added a local strict canary row proving initial transport, response body read,
  status error body, and stream read public errors redact the configured API
  key while still sending it only as a bearer header. The Python canary also
  verifies traceback output and explicit exception chains do not retain
  unredacted causes.
- Added a local strict canary row proving 429 rate-limit responses map to
  `RateLimitError` with `retry_after_seconds` and request-id metadata.
- Added a local strict canary row proving 402 insufficient-credits responses
  map to `InsufficientCreditsError` with request-id metadata.

### Compatibility
- `UnsupportedOperationError` remains exported for older v0.1.x consumers, but
  current public helpers do not raise it.

## [0.1.3] - 2026-05-23

### Security
- Hardened the shared release path with pinned CI and publish build tooling,
  SHA-pinned workflow actions, protected-branch dispatch checks, and an exact
  version confirmation before any real registry publish.
- Extended wheel and sdist verification to scan shipped files for source maps,
  local machine paths, package tokens, private keys, and registry config leaks.

### Changed
- Added the repository Python dev requirements file used by CI and publish
  workflows so package builds no longer float on latest build tool releases.

## [0.1.2] - 2026-05-23

### Changed
- Hardened CI and publish gates with exact npm tarball and Python wheel/sdist
  content verification.
- Added version-sync and workflow-policy checks to prevent stale SDK releases
  and long-lived registry-token regressions.
- Updated public docs to match the shipped voice pipeline helper: experimental,
  pipeline-scoped, and not yet live-canary verified.
- Switched Python license metadata to the non-deprecated `license` and
  `license-files` form.

## [0.1.1] - 2026-05-23

### Changed
- **`Development Status`** classifier: `5 - Production/Stable` -> `4 - Beta`.
  The 0.1.0 release went out via a CI bypass that skipped live-canary
  verification for image/TTS/ASR modalities; "Production/Stable" was
  inaccurate. PyPI listing now reflects beta state honestly.
- **`description`**: now states "beta; LLM and embeddings contract-tested,
  image/audio surfaces experimental" so the registry listing avoids implying
  live multimodal GA proof.
- **`Issues` URL**: now points at `RightNow-AI/runinfra-sdk` (the public source
  repo). Previous value pointed at the non-existent `RunPipe` slug.

### Added
- **Modality status section** in the README documenting which surfaces are
  contract-tested vs experimental.
- **`[EXPERIMENTAL]` docstrings** on `_Images` (driving `client.images.*`) and
  `_Audio` (driving `client.audio.speech.*` and `client.audio.transcriptions.*`).
  These surfaces match the OpenAI HTTP envelope but have not been verified
  end-to-end against a live deployed pipeline in the public-gateway canary
  suite. Test against your own deployments before using in production.
- This `CHANGELOG.md`.

### Provenance
This is the first release published via GitHub OIDC trusted publishing
(`.github/workflows/publish.yml` -> `pypi` environment). The release was
attested by `pypa/gh-action-pypi-publish@release/v1` against the configured
trusted-publisher rule on PyPI. Verify the project's publisher chain at
https://pypi.org/manage/project/runinfra/publishing/.

### Known beta gaps
- Live-canary coverage is currently partial for LLM and blocked for embeddings
  until the strict promotion artifacts include a deployed embedding target. Image,
  TTS, and ASR surfaces are runnable but not yet verified end-to-end.
- Webhook delivery routes are not shipped; `client.webhooks.create` /
  `.list()` raise `UnsupportedOperationError`. Local signature verification
  (`verify_signature`, `construct_event`) works.
- `client.voice.pipeline.create` posts audio to the pipeline-scoped `/pipeline` route.
  It is experimental until live canary coverage is complete.

### Toward 1.0.0 GA
GA requires all 5 model modalities plus voice pipeline live-canary verified and
public-repo release gates that block stale, missing, or bypassed canary
evidence.

## [0.1.0] - 2026-05-22

Initial public release. See README for the API surface.

# Changelog

All notable changes to `@runinfra/sdk` are documented here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.4] - 2026-05-23

### Changed
- Removed unshipped webhook delivery `create` / `list` methods from the
  public `client.webhooks` surface. Local signature verification remains
  available through `verifySignature`, `constructEvent`,
  `verifyWebhookSignature`, and `constructWebhookEvent`.
- Replaced the live-canary unsupported-webhook rows with
  `webhooks.delivery_surface.absent`, so source, artifact, and clean-install
  gates prove the dead delivery methods are absent instead of merely
  fail-closed.
- Added explicit TypeScript request typing for OpenAI-compatible image
  parameters `n`, `size`, `response_format`, `quality`, `style`, and `user`,
  matching the documented SDK surface and Python keyword parameters.
- Added explicit TypeScript request typing for OpenAI-style chat completions
  and the gateway-supported Responses adapter parameters that were already
  pass-through compatible at runtime.
- Added explicit TypeScript request typing for auxiliary embedding and audio
  parameters `user`, `speed`, and `temperature`, matching the Python SDK.
- Closed TypeScript request body interfaces around typed fields and added
  `extraBody` request options for deliberate JSON body extensions.
- Closed the runtime ASR multipart body around explicit typed fields so cast
  request objects cannot append arbitrary form fields.
- Added `created_at` to the TypeScript Responses response envelope and updated
  Responses adapter docs to list the typed `top_p`, `tools`, `tool_choice`, and
  `response_format` fields.
- Hardened parent live-canary parity so strict reports fail when child reports
  contain failed/skipped rows or inconsistent summary counts.
- Hardened promotion readiness verification so forged or stale readiness
  summaries cannot contradict the strict readiness rows.
- Included `typescript/tsconfig.json` and `python/MANIFEST.in` in promotion
  source digests so source-map or package-manifest changes require fresh
  readiness and live-canary evidence before publish.
- Corrected modality-status docs so chat/responses are not described as
  strict-live green before fresh production artifact canaries pass.
- Added a local strict canary row proving user-supplied client request IDs are
  sent as headers and do not leak into JSON request bodies.
- Added a local strict canary row proving custom request headers are sent as
  headers, do not leak into JSON bodies, and cannot override SDK credentials.
- Added a local strict canary row proving per-request timeout options map to
  timeout errors without leaking timeout option names into JSON bodies.
- Added a local strict canary row proving explicit JSON `extraBody` extensions
  are serialized deliberately, do not serialize SDK option names, reject typed
  field overrides, and fail closed on multipart paths.
- Added a local strict canary row proving unknown direct request fields are
  rejected before network sends and that unsupported JSON body probes must use
  `extraBody`.
- Added a local strict canary row proving the shipped SDK fails closed in
  browser-like runtimes unless `dangerouslyAllowBrowser: true` is explicitly
  set.
- Added `@experimental` JSDoc to the public voice pipeline surface so IDEs and
  generated declarations match its not-yet-live-verified status.
- Added a local strict canary row proving initial transport, response body read,
  status error body, and stream read public errors redact the configured API
  key while still sending it only as a bearer header.
- Added a local strict canary row proving 429 rate-limit responses map to
  `RateLimitError` with retry-after and request-id metadata.
- Added a local strict canary row proving 402 insufficient-credits responses
  map to `InsufficientCreditsError` with request-id metadata.
- Extended package leakage scanners to reject PyPI/Twine and pip credential
  config material such as `.pypirc`, `.netrc`, `pip.conf`, and `pip.ini`.

### Compatibility
- `UnsupportedOperationError` remains exported for older v0.1.x consumers, but
  current public helpers do not raise it.

## [0.1.3] - 2026-05-23

### Security
- Hardened browser credential safeguards by requiring
  `dangerouslyAllowBrowser` to be an actual boolean and by failing closed in
  browser worker runtimes unless explicitly allowed.
- Replaced trailing-slash URL regex normalization with a bounded loop to avoid
  regex backtracking risk on adversarial base URLs.

### Changed
- Pinned CI and publish build tooling with a TypeScript lockfile and Python
  dev requirements file, and pinned workflow actions to immutable commits.
- Made real publish dispatch default to dry-run and require an exact version
  confirmation on `main`.
- Extended package verification to scan shipped files for source maps, local
  machine paths, package tokens, private keys, and registry config leaks.

## [0.1.2] - 2026-05-23

### Changed
- Hardened CI and publish gates with exact npm tarball and Python wheel/sdist
  content verification.
- Added version-sync and workflow-policy checks to prevent stale SDK releases
  and long-lived registry-token regressions.
- Updated public docs to match the shipped voice pipeline helper: experimental,
  pipeline-scoped, and not yet live-canary verified.

## [0.1.1] - 2026-05-23

### Changed
- **`license`**: `UNLICENSED` -> `LicenseRef-Proprietary` (aligns with Python SDK; the prior value was contradictory for a public package).
- **`repository.url`**: now points at `RightNow-AI/runinfra-sdk` (the public source repo). Previous value pointed at the non-existent `RunPipe` slug.
- **`bugs.url`**: same fix.
- **`description`**: now states "beta; LLM and embeddings contract-tested, image/audio surfaces experimental" so the registry listing avoids implying live multimodal GA proof.

### Added
- **Modality status section** in the README documenting which surfaces are
  contract-tested vs experimental.
- **`@experimental` JSDoc** on `client.images.*`, `client.audio.speech.*`, and
  `client.audio.transcriptions.*` - these surfaces match the OpenAI HTTP
  envelope but have not been verified end-to-end against a live deployed
  pipeline in the public-gateway canary suite. Test against your own
  deployments before using in production.
- This `CHANGELOG.md`.

### Provenance
This is the first release published via GitHub OIDC trusted publishing
(`.github/workflows/publish.yml` -> `npm` environment). The published
tarball includes a Sigstore-backed provenance attestation that ties the
release to a specific CI run. Verify with:
```bash
npm view @runinfra/sdk@0.1.1 dist.attestations
```
v0.1.0 was published from a local machine to bootstrap the Trusted Publisher
configuration and does not have provenance. All v0.1.1+ releases will.

### Known beta gaps
- Live-canary coverage is currently partial for LLM and blocked for embeddings until the strict promotion artifacts include a deployed embedding target. Image,
  TTS, and ASR surfaces are runnable but not yet verified end-to-end.
- Webhook delivery routes are not shipped; `client.webhooks.create` /
  `.list()` throw `UnsupportedOperationError`. Local signature verification
  (`verifySignature`, `constructEvent`) works.
- `client.voice.pipeline.create` posts audio to the pipeline-scoped `/pipeline` route.
  It is experimental until live canary coverage is complete.

### Toward 1.0.0 GA
GA requires all 5 model modalities plus voice pipeline live-canary verified and
public-repo release gates that block stale, missing, or bypassed canary
evidence.

## [0.1.0] - 2026-05-22

Initial public release. See README for the API surface.

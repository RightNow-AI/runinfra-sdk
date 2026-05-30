# Changelog

All notable changes to `@runinfra/sdk` are documented here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.4] - 2026-05-23

### Added
- Added typed helpers for chat completions, Responses, embeddings, image
  generation, text to speech, speech to text, model discovery, local webhook
  signature verification, and co-located voice pipelines.
- Added OpenAI-style request fields for chat, Responses, embeddings, image
  generation, TTS, and ASR helpers, including `extraBody` for deliberate JSON
  gateway extensions.
- Added typed gateway errors for authentication, permissions, rate limits,
  insufficient credits, deployment failures, missing models, timeouts,
  connection failures, and malformed streams.
- Added request tracing through `X-Client-Request-Id`, response request IDs,
  and idempotency keys for replay-safe chat and Responses requests.

### Changed
- Removed unshipped webhook delivery `create` and `list` methods from the
  public `client.webhooks` namespace. Local signature verification remains
  available through `verifySignature`, `constructEvent`,
  `verifyWebhookSignature`, and `constructWebhookEvent`.
- Closed public request body types around supported fields so typos and
  unsupported direct fields fail before a network request is sent.
- Closed ASR multipart requests around explicit file, filename, language,
  prompt, temperature, and response-format fields.
- Documented the Responses helper as a chat-completions compatibility adapter
  instead of full OpenAI Responses state.
- Kept charge-bearing retries conservative. Embeddings, images, streaming,
  binary TTS, multipart ASR, and voice-pipeline requests are sent once even
  when an idempotency key is provided.

### Security
- Hardened browser-runtime protection so secret API keys are not accepted in
  public client bundles unless `dangerouslyAllowBrowser: true` is explicitly
  set.
- Hardened API-key redaction in transport errors, response body errors, and
  stream read errors.
- Hardened package verification to reject source maps, debug source markers,
  local private paths, registry config files, credential files, and package
  token material.

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
- Hardened package verification for exact npm tarball and Python wheel/sdist
  contents.
- Added version-sync and workflow-policy checks to prevent stale SDK releases
  and long-lived registry-token regressions.
- Updated docs to describe the voice pipeline helper as a pipeline-scoped
  preview helper.

## [0.1.1] - 2026-05-23

### Changed
- Changed package metadata to use the proprietary license reference consistently
  across TypeScript and Python packages.
- Updated repository and issue URLs to point at the public SDK repo.
- Clarified package status as beta while image and audio helpers remain
  deployment-dependent preview surfaces.

### Added
- Added the modality status section to the README.
- Added preview JSDoc annotations for deployment-dependent helpers.
- Added this changelog.

## [0.1.0] - 2026-05-22

Initial public release. See README for the API surface.

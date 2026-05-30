# Changelog

All notable changes to the `runinfra` Python SDK are documented here. This
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- Removed unshipped webhook delivery `create` and `list` methods from the
  public `client.webhooks` namespace. Local signature verification remains
  available through `verify_signature`, `construct_event`,
  `verify_webhook_signature`, and `construct_webhook_event`.
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
- Hardened package verification to reject source maps, debug source markers,
  local private paths, registry config files, credential files, and package
  token material.

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
- Hardened package verification for exact npm tarball and Python wheel/sdist
  contents.
- Added version-sync and workflow-policy checks to prevent stale SDK releases
  and long-lived registry-token regressions.
- Updated docs to describe the voice pipeline helper as a pipeline-scoped
  preview helper.
- Switched Python license metadata to the non-deprecated `license` and
  `license-files` form.

## [0.1.1] - 2026-05-23

### Changed
- Changed `Development Status` from production/stable to beta.
- Updated repository and issue URLs to point at the public SDK repo.
- Clarified package status as beta while image and audio helpers remain
  deployment-dependent preview surfaces.

### Added
- Added the modality status section to the README.
- Added preview docstrings for deployment-dependent helpers.
- Added this changelog.

## [0.1.0] - 2026-05-22

Initial public release. See README for the API surface.

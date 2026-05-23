# Changelog

All notable changes to `@runinfra/sdk` are documented here. This project follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- **`description`**: now states "beta; LLM + embeddings tested, image/audio surfaces experimental" so the registry listing accurately reflects verification state.

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
- Live-canary coverage is currently restricted to LLM + embeddings. Image,
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

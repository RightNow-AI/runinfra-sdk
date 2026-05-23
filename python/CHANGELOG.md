# Changelog

All notable changes to the `runinfra` Python SDK are documented here. This
project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
- **`description`**: now states "beta; LLM + embeddings tested, image/audio
  surfaces experimental" so the registry listing accurately reflects
  verification state.
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
- Live-canary coverage is currently restricted to LLM + embeddings. Image,
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

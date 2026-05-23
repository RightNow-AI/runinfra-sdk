# Agent 4 Goal: SDK Production Stability

Date: 2026-05-23
Agent: 4
Repo: `runinfra-sdk`
Goal: take the TypeScript and Python SDKs from secure beta to production-grade GA without weakening security, release provenance, or live contract coverage.

## Done Means

- TS and Python SDKs match the live RunInfra API contract.
- Packed artifacts and registry installs work in clean consumer projects.
- Live canaries prove models, chat, responses, embeddings, images, audio speech, audio transcription, voice pipeline, streaming final/cancel, invalid auth, invalid options, fail-closed webhooks, and idempotency replay.
- No source maps, local paths, secrets, API keys, `.env` values, private config, or internal-only build artifacts leak into npm, PyPI, CI logs, canary reports, or package metadata.
- CI gates are green: TS tests/build/package verify, Python tests/build/twine verify, clean installs, workflow policy, version sync, and GitHub default CodeQL analysis.
- Trusted publishing stays OIDC/provenance based. No long-lived npm/PyPI publish tokens.
- Merge happens through protected PR into `main`; local state is reconciled without destructive reset.

## Current Verified State

- Local SDK `main` is ahead of `origin/main` with GA canary/security commits.
- PR branch: `hardening/sdk-ga-canary-gates`.
- PR: `RightNow-AI/runinfra-sdk#9`, "Add SDK GA canary and CodeQL gates".
- Direct push to `main` is blocked by branch protection, as desired.
- Local TS/Python package, test, build, clean-install, and artifact canary gates passed before the CodeQL correction.
- Live canaries enforce expected rows and redacted reports. Some rows were skipped when live env/fixtures were absent; GA still requires strict all-row live execution.
- GitHub default CodeQL checks passed. A custom advanced CodeQL workflow failed because default setup is enabled, so do not add `.github/workflows/codeql.yml`.

## Immediate Checkpoint

1. Remove the conflicting custom CodeQL workflow.
2. Update workflow policy/docs to reference GitHub default CodeQL checks.
3. Keep the hardened parser that catches quoted, unquoted, and shorthand unpinned `uses`.
4. Re-run policy checks, mutation checks, package checks, and source/secret/package leak scans.
5. Push to `hardening/sdk-ga-canary-gates`.
6. Merge only after PR checks and branch protection are green.

## GA Gates

- Strict production live canaries run with all required env and ASR fixture present.
- Streaming proves final chunks, cancel behavior, no secret leakage, and no unsafe retries for non-idempotent streams.
- OpenAI-compatible surfaces are tested for supported model parameters across chat, responses, embeddings, images, voice/audio, metadata/tools where implemented, and error envelopes.
- Unsupported surfaces fail closed with typed errors.
- Package contents are inspected for source maps, credentials, local absolute paths, caches, secret-bearing fixtures, and private config.
- Security remains dependency-light, TLS-enforced off localhost, bearer-token-only, no telemetry, no credential URLs, and no raw key echo in errors/logs/reports.

## Do Not Do

- Do not publish with pasted long-lived npm/PyPI tokens.
- Do not bypass branch protection or force-push `main`.
- Do not claim GA if any canary row is skipped or unverified.
- Do not hide contract mismatches by weakening tests.
- Do not add source maps or internal source bundles to published packages.
- Do not use destructive git commands to reconcile local `main`.

## Method

Read real repo state first, patch narrowly, verify locally, run adversarial review for broad changes, then merge only through the protected PR path. If a gate needs missing live credentials or fixtures, mark it blocked instead of calling the SDK production-ready.

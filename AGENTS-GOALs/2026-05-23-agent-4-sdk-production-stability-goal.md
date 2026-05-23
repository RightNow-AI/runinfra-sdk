# Agent 4 Goal: SDK Production Stability

Date: 2026-05-23
Agent: 4
Repo: `runinfra-sdk`
Goal: take the TS and Python SDKs from secure beta to production-grade GA without weakening security, provenance, or live contract coverage.

## Done Means

- TS and Python SDKs match the live RunInfra API contract.
- Packed artifacts and registry installs work in clean consumers.
- Strict live canaries prove models, chat, responses, embeddings, images, TTS, ASR, voice pipeline, streaming final/cancel, errors, fail-closed webhooks, local webhook helpers, and idempotency replay.
- No source maps, local paths, secrets, API keys, `.env`, `.npmrc`, private config, tests, caches, or internal build artifacts leak into npm, PyPI, CI logs, canary reports, or metadata.
- CI gates are green: TS tests/build/package verify, Python tests/build/twine verify, clean installs, workflow policy, version sync, and default CodeQL.
- Trusted publishing stays OIDC/provenance based. No long-lived npm/PyPI publish tokens.
- Merge happens through protected PR into `main`; local state is reconciled without destructive reset.

## Current Verified State

- PR branch: `hardening/sdk-ga-canary-gates`; PR: `RightNow-AI/runinfra-sdk#9`.
- Direct push to `main` is blocked by branch protection, as desired.
- Commit `b1f9c09` fixed the CodeQL default-setup conflict by removing the advanced workflow and documenting GitHub default CodeQL. PR checks went green after push.
- Merge is still blocked by GitHub `REVIEW_REQUIRED`; current auth user is the PR author, and GitHub rejected self-approval.
- Current checkpoint hardens GA canaries/runtime: local webhook rows, report leak guard, Python request IDs/UTF-8 SSE, deterministic voice fixture proof, OpenAI parameter rows, unsupported body-parameter proof, and native response-shape guards for base64 embeddings / non-JSON ASR.
- Local verification passed: TS typecheck/tests/build/pack/package scan/clean install, Python tests/build/twine/package scan/clean install, version sync, workflow policy, diff check, source/artifact canaries, and second-opinion review.
- Canary proves 24-row parity with 6 local rows passed and 18 live rows skipped because prod env is absent. This is progress, not GA.
- Code scanning API showed 0 open alerts and 0 open high/critical alerts. Default branch still reports 3 moderate Dependabot alerts.

## Remaining GA Gates

- Get non-author approval and merge PR #9 through branch protection.
- Run strict production artifact canaries with all env present, including ASR and voice fixtures/expected text.
- Prove images, TTS, ASR, and voice pipeline with deployed model/backend coverage before removing experimental labels.
- Expand strict-live OpenAI-compatible parameter coverage beyond the verified native subset: tools/schema outputs, stream options, embeddings dimensions/base64, image/audio streaming, and model-specific advanced options.
- Decide GA Python ergonomics: ship `AsyncRunInfra` or keep sync-only documented as a deliberate GA limitation.
- Keep webhook delivery create/list fail-closed unless real delivery endpoints ship.

## Do Not Do

- Do not publish with pasted long-lived npm/PyPI tokens.
- Do not bypass branch protection, self-approve, force-push `main`, or weaken checks.
- Do not claim GA if any canary row is skipped or unverified.
- Do not hide contract mismatches by weakening tests.
- Do not add source maps or internal source bundles to packages.
- Do not use destructive git commands to reconcile local `main`.

## Method

Read current state first, patch narrowly, verify locally, run adversarial review for broad changes, then merge only through the protected PR path. If a gate needs missing live credentials, fixtures, or external approval, mark it explicitly instead of calling the SDK production-ready.

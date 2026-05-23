# Agent 4 Goal: SDK Production Stability

Date: 2026-05-23
Agent: 4
Repo: `runinfra-sdk`
Branch/PR: `hardening/sdk-ga-canary-gates`, PR `RightNow-AI/runinfra-sdk#9`

## Goal

Move TS/Python SDKs from secure beta to production-grade GA. Done means clean npm/PyPI installs, live contract match, strict artifact canaries, protected PR merge, OIDC/provenance release, and no leakage of secrets, source maps, internal source, private config, local paths, caches, or fixtures.

Agent 4 owns SDK hardening, package safety, live contract proof, and release evidence. Read state first, patch narrowly, test artifacts, get review for risky changes, and never claim production-ready with skipped or unverified canaries.

## Verified State

- Local `main` is ahead of `origin/main` by 8 commits; PR #9 contains the SDK GA canary/security work.
- PR checks are green: TS SDK, Python SDK, CodeQL/default code scanning, package/build/test gates.
- Branch protection is active: merge is blocked by `REVIEW_REQUIRED`; current auth user cannot self-approve.
- Code scanning showed 0 open alerts and 0 open high/critical alerts. Default branch still has 3 moderate Dependabot alerts.
- Current RunPipe canary env proves gateway/auth/request-id/models-list shape only. It lacks live model IDs/audio fixtures, so strict GA is incomplete.
- `/models` returns a valid object with empty `data`; shape proof only, not model coverage.
- Registry install/import gate is enforced after real publish. Local proof: `verify-clean-installs --mode registry --version 0.1.3` passed for npm/PyPI 0.1.3.
- Strict preflight writes redacted readiness reports without live calls; fake-key proof showed blocked readiness, 0 child reports, and no key leak.

## Production Bar

- Registry consumer installs verify imports and versions for npm and PyPI.
- SDKs cover/document chat, responses, embeddings, images, TTS, ASR, voice pipeline, streaming, errors, idempotency, request IDs, retries, and fail-closed webhooks.
- OpenAI-compatible calls prove supported parameters and clear unsupported errors without hiding auth, credit, rate-limit, model, or deployment failures.
- Strict artifact canaries pass with no required skips for LLM, responses, embeddings, image, TTS, ASR, voice, streaming final/cancel, idempotency replay, error shape, and install/import.
- Package scans prove no source maps, `.env`, `.npmrc`, secrets, local paths, private config, caches, fixtures, or internal files.

## Remaining Blockers

1. Need non-author approval before PR #9 can merge into protected `main`.
2. Strict canary env is missing model IDs, embedding dimensions, image/TTS/ASR/voice coverage, audio fixtures, expected transcripts, and idempotency enablement.
3. Advanced OpenAI proof still needs tools/schema outputs, stream options, image/audio variants, embedding dimensions/base64, and model-specific options.
4. Python GA choice remains open: ship `AsyncRunInfra` or document sync-only as intentional.
5. Webhook delivery create/list stays fail-closed until real delivery endpoints exist.

## Guardrails

Inspect git/PR/checks before claims. Fix only GA-linked contract, security, packaging, canary, or docs gaps. Verify tests, type/build, scans, clean installs, and source/artifact canaries. Review changes over 2 files, over 100 lines, or release/architecture decisions. Merge only through protected PR after non-author approval. Publish only via trusted workflow after merge and strict canary proof. Do not bypass protection, self-approve, force-push `main`, weaken checks/tests, use pasted registry tokens, ship source maps/internal bundles, or run destructive git reconciliation.

## Next Checkpoint

Collect strict production canary env/fixtures, then rerun preflight and artifact canaries until every required SDK path is proven.

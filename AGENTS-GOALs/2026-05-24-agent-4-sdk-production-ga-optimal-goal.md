# Agent 4 SDK Production GA Goal

## Goal
Make RunInfra SDKs production-grade and GA-ready for npm and PyPI without weakening security, breaking contract, leaking secrets/source maps, or pretending unverified behavior is done.

Targets:
- npm: `@runinfra/sdk`
- PyPI: `runinfra`
- API: `https://api.runinfra.ai/v1`

## Done Means
The SDK is ready only when all of these are true:
- TypeScript and Python SDKs expose the same supported product contract unless a difference is explicitly documented.
- Chat, responses, streaming, images, audio, models, errors, retries, idempotency, timeouts, pagination, and OpenAI-compatible paths are covered by unit tests and live canaries.
- SDK parameters are validated, typed, documented, and mapped exactly to backend behavior. No dead parameters, silent drops, fake options, or undocumented lossy conversions.
- Streaming is stable under normal chunks, split SSE frames, keepalive/comment frames, error events, aborts, and slow consumers. No retry of non-idempotent streams.
- Voice and image surfaces either work end-to-end against real backend routes or are removed/hidden before GA.
- Security checks prove API keys are only sent in `Authorization: Bearer`, never URLs, logs, thrown errors, source maps, npm tarballs, PyPI artifacts, README examples, or workflow output.
- Browser usage is explicitly blocked or safe by design. Server-side usage is the default.
- npm package and PyPI wheel/sdist clean-install and import from fresh environments.
- Published artifacts are built from the intended promoted commit and match promotion evidence.
- CI prevents publishing when tests, artifact scans, package surface checks, clean installs, provenance/trusted publishing, or live canaries fail.

## Not Done Yet If Any Of This Remains
- Any SDK method calls a missing backend route.
- Any endpoint returns a shape different from the SDK type.
- Any OpenAI-compatible endpoint is partial without documentation.
- Audio, image, model, or response APIs pass local tests but lack live canary evidence.
- Source maps, raw source, secrets, `.env`, local paths, logs, or generated private artifacts appear in package outputs.
- PyPI/npm publish relies on long-lived tokens instead of trusted publishing, except for approved emergency bootstrap.
- RunPipe gateway and RunInfra Engine behavior are not aligned with SDK docs and tests.

## Methodology
Work in small commits. For each GA gap:
1. Inspect current SDK, RunPipe gateway, and RunInfra Engine behavior before changing code.
2. Add a failing regression test or live canary first.
3. Implement the smallest contract-correct fix.
4. Update README, typed docs, and goal notes only when behavior is verified.
5. Run focused tests, full SDK tests, package artifact scans, clean installs, and workflow policy checks.
6. Run second-opinion review for changes over 2 files, over 100 lines, or any security decision.
7. Never call it production-grade from memory. Cite the exact command or live canary result.

## Priority Order
1. Contract mismatches: missing routes, response shape drift, parameter drift.
2. Live canaries: chat, responses, streaming, image, audio, models, OpenAI compatibility.
3. Artifact security: npm tarball, PyPI wheel, PyPI sdist, source-map and secret scans.
4. Publish safety: trusted publishing, provenance, exact artifact promotion, rollback notes.
5. Developer experience: clear errors, stable retries, complete examples, async/sync Python decision.

## Anti-Actions
Do not publish, push, deploy, rotate secrets, provision paid infra, or change production settings without explicit current approval. Do not hide failing surfaces behind marketing copy. Do not remove tests to pass CI. Do not merge unrelated work. Do not use pasted registry tokens in committed files or logs.

## Session Log

### 2026-05-25T04:48:50+03:00 - Agent 4
- Ran `pnpm --dir typescript build`: passed.
- Ran `python -m pytest python\tests -q`: 130 passed, 127 subtests passed.
- Ran production source live canary with the scoped local SDK live env file and `--package-source source`: TypeScript 33 passed / 1 failed / 15 skipped; Python 33 passed / 1 failed / 15 skipped.
- The shared failed row is `error.body.unsupported_parameter`. The failure is `unexpected_success`, meaning production accepted the reserved `runinfra_unsupported_parameter_probe` Responses body extension instead of returning a clear 400/422 `unsupported_parameter` error.
- Added redacted child-canary diagnostics so failed rows keep raw messages hidden but expose safe enum diagnostics such as `unexpected_success`.
- Post-review cleanup removed local path details from this goal note, added an executable TypeScript canary self-test for `errorSummary()`, and normalized unknown diagnostics to `null` for TS/Python report parity.
- Verified focused regressions: TypeScript `child live-canary failure diagnostics` passed; Python `error_summary_adds_safe_diagnostics` passed.
- Verified full local suites: `pnpm --dir typescript exec tsc -p tsconfig.json --noEmit` passed; `pnpm --dir typescript test -- --reporter dot --testTimeout 5000` passed 200 tests; `python -m pytest python\tests -q` passed 131 tests and 127 subtests.
- Verified policy/security gates: `node scripts\verify-workflow-policy.mjs`, `node scripts\run-sdk-live-canaries.mjs --verify-surface-coverage`, `node scripts\secret-scan-policy.mjs`, and `git diff --check` passed.
- Current source live-canary candidate digest after this change: `ab6fd0dc6525f5701385722d7c39736ca1829c3b5f86b3fa55c62607a6efa5ed`, source file count 15.
- GA remains blocked. Do not publish npm/PyPI until the production gateway rejects the reserved Responses parameter, strict multimodal canary inputs are complete, artifact canaries pass, and registry install/import proof passes.

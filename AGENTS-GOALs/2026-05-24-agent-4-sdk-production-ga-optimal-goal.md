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

### 2026-05-25T12:54:00+03:00 - Agent 4
- Added safe live model discovery to the parent live-canary runner: `--discover-models` calls only `GET /models`, classifies catalog candidate IDs into `RUNINFRA_LLM_MODEL`, `RUNINFRA_EMBEDDING_MODEL`, `RUNINFRA_IMAGE_MODEL`, `RUNINFRA_TTS_MODEL`, and `RUNINFRA_ASR_MODEL` buckets, and writes a redacted report without running inference rows.
- Discovery is explicitly informational. It does not make strict preflight ready, does not prove callability, and does not replace `models.retrieve.*` or multimodal canary rows.
- Added `scripts/live-canary-model-discovery.mjs` to the canonical source digest manifest so promotion reports cannot reuse stale source identity after discovery logic changes.
- Added regression coverage for model discovery reports, fail-closed missing-key behavior, source digest inclusion, docs wording, stalled discovery requests before headers, stalled discovery JSON bodies after headers, and conflicting runner mode flags.
- Ran live discovery with the scoped local SDK live env file. Result: completed, catalog count 1, classified count 1, invalid count 0. The catalog produced one LLM candidate bucket and no embedding/image/TTS/ASR candidates.
- Current source candidate identity after this change: digest `681c1fad119cb8c3166a03f7f8b0120a0c4d36812e8071b5a8a9ba19234bb25b`, source file count 16.
- Strict preflight with the scoped local SDK live env file remains blocked: 34 ready rows, 15 blocked rows.
- Source live canary rerun after warm-up remains blocked only by the production unsupported-parameter behavior: TypeScript 33 passed / 1 failed / 15 skipped; Python 33 passed / 1 failed / 15 skipped. The failed row in both languages is `error.body.unsupported_parameter` with diagnostic `unexpected_success`.
- Second-opinion review found two warnings: model discovery timeout did not cover stalled response bodies, and `--discover-models --preflight` could skip strict readiness. Both were fixed before commit.
- Verification passed: `pnpm --dir typescript exec tsc -p tsconfig.json --noEmit`; `pnpm --dir typescript test -- --reporter dot --testTimeout 5000` with 207 tests; `python -m pytest python\tests -q` with 131 tests and 127 subtests; `pnpm --dir typescript build`; `node scripts\verify-workflow-policy.mjs`; `node scripts\run-sdk-live-canaries.mjs --verify-surface-coverage`; `node scripts\secret-scan-policy.mjs`; `git diff --check` with expected Windows CRLF warnings only.
- GA remains blocked. Do not publish npm/PyPI until production rejects the reserved Responses parameter, real embedding/image/TTS/ASR/voice/idempotency canary inputs exist and pass, artifact canaries pass, registry install/import proof passes, and independent review is clean.

### 2026-05-25T13:22:00+03:00 - Agent 4
- Refreshed exact local package artifacts from commit `30e41d5`: `pnpm --dir typescript install --frozen-lockfile`, `pnpm --dir typescript build`, `pnpm --dir typescript pack`, and `python -m build python --outdir python\dist` all completed.
- Artifact leakage/shape gates passed: `node scripts\verify-npm-package.mjs typescript\runinfra-sdk-0.1.4.tgz`, `python scripts\verify-python-package.py python\dist`, and `python -m twine check` for the `runinfra-0.1.4` wheel and sdist.
- Clean artifact consumer installs passed: `node scripts\verify-clean-installs.mjs --package both --mode artifact` verified npm import, Python wheel import, and Python sdist import.
- Artifact-mode strict readiness with the scoped SDK live env file remained blocked: 34 ready rows, 15 blocked rows. Source identity stayed `681c1fad119cb8c3166a03f7f8b0120a0c4d36812e8071b5a8a9ba19234bb25b`, source file count 16.
- Artifact-mode strict live canary installed the packed npm tarball and Python wheel, recorded all three artifact digests, and remained blocked with the same live status: TypeScript 33 passed / 1 failed / 15 skipped; Python 33 passed / 1 failed / 15 skipped. The failed row in both languages is still `error.body.unsupported_parameter` with diagnostic `unexpected_success`.
- Artifact digests recorded in the live report: npm `c719ba363c25917b0af325c4b4cf4e4e2dd3eea648569acdace541e52300ff7d`, Python wheel `d48aab15bedf7c9ba6e49d30a0355e9475f179e6d3af9d8c51760cb2a19f72b4`, Python sdist `f61e040597dd492edd8d4870dc1b7196dc5c9f3eb5b1b5b6ff7a897459ef1bfe`.
- `node scripts\verify-promotion-reports.mjs --readiness artifacts\sdk\live-canary-readiness-current-artifact.json --live artifacts\sdk\live-canary-current-artifact.json` failed as expected, proving the promotion gate rejects blocked readiness, skipped multimodal/idempotency rows, and the unsupported-parameter live failure.
- No source change, push, deploy, publish, registry change, secret rotation, or paid provisioning was performed in this checkpoint.

### 2026-05-25T13:29:00+03:00 - Agent 4
- Verified current public registry availability for SDK `0.1.4` without publishing: `node scripts\verify-clean-installs.mjs --package both --mode registry --version 0.1.4 --registry-attempts 1 --registry-retry-delay-ms 1000` failed at registry preflight.
- Canonical npm does not currently have `@runinfra/sdk@0.1.4`, and canonical PyPI does not currently have `runinfra==0.1.4`. The script stopped before creating consumer install workspaces.
- Registry install/import proof for `0.1.4` remains blocked until a trusted-publishing release is actually performed after strict readiness/live/artifact promotion gates pass.

### 2026-05-25T13:25:10+03:00 - Agent 4
- Re-checked the current RunPipe production-gateway source state after `git fetch --all --prune`. `origin/main` still does not contain the SDK gateway contract fix commit family; the current production blocker is therefore integration/deploy state, not missing local SDK artifact code.
- The active RunPipe checkout is dirty with unrelated plan/token/UI work, so no edits or merges were done there.
- Used the existing isolated RunPipe worktree `C:\Users\jaber\RightNow-Full\RunPipe-sdk-gateway-main-20260525` on `fix/sdk-gateway-contracts-main-20260525` for the gateway candidate. It was clean, contained the SDK gateway contract tests/code, and was behind current `origin/main`.
- Merged current `origin/main` into that isolated gateway branch. Merge commit: `bc8ea7aa Merge remote-tracking branch 'origin/main' into fix/sdk-gateway-contracts-main-20260525`.
- Verified the post-merge gateway candidate with focused checks: `pnpm test -- app/api/v1/workspace-flat.test.ts -t "rejects reserved runinfra-prefixed body parameters before proxying"` passed 1 test; `pnpm test -- app/api/v1/[...path]/route.test.ts -t "rejects reserved runinfra-prefixed responses parameters before proxying"` passed 1 test; `pnpm test -- lib/api/responses-compat.test.ts` passed 16 tests.
- Verified `pnpm typecheck` in the isolated gateway worktree: passed.
- Verified `git diff --check HEAD~1..HEAD` in the isolated gateway worktree: passed.
- Current gateway candidate branch is clean and ahead of `origin/main` by 11 commits. It is ready for review/push/deploy approval as the local fix candidate for the SDK live-canary `error.body.unsupported_parameter` blocker, but it has not been pushed or deployed by Agent 4 in this checkpoint.
- SDK GA remains blocked until that production gateway behavior is live, strict multimodal/idempotency canary inputs exist and pass, artifact and registry install/import gates pass, and independent review is clean.

### 2026-05-25T13:25:48+03:00 - Agent 4
- Ran the SDK GitHub security gate. The first `node scripts\verify-github-security-status.mjs --repo RightNow-AI/runinfra-sdk` attempt failed with `401 Unauthorized` because the process did not have a GitHub token.
- Confirmed `gh auth status` had an authenticated CLI session, then reran the verifier with the CLI token supplied through `GITHUB_TOKEN` without printing it.
- Verified `node scripts\verify-github-security-status.mjs --repo RightNow-AI/runinfra-sdk`: passed, with no open high/critical code-scanning alerts reported for `RightNow-AI/runinfra-sdk`.

### 2026-05-25T13:26:14+03:00 - Agent 4
- Queried RunPod state read-only through MCP. Do not copy raw MCP output into commits because worker environment fields can include platform-injected secrets.
- Existing RunPod endpoint inventory contains one SDK canary endpoint for LLM coverage: `runinfra-sdk-canary-llm-mpiw58hc`, configured as a serverless L4/vLLM canary for `RUNINFRA_MODALITY=llm`, with min workers `0` and max workers `1`.
- Existing template inventory includes the LLM canary template plus stock SGLang, TEI embedding, and vLLM templates. No pods are currently listed.
- No existing RunPod endpoint was found for embeddings, images, TTS, ASR, or voice pipeline canary coverage in this read-only check.
- Strict multimodal canaries therefore still need either approved provisioning of scoped canary targets or already-deployed RunPipe workspace models that expose those modalities before GA can be claimed.

### 2026-05-25T13:27:17+03:00 - Agent 4
- Verified `node scripts\run-sdk-live-canaries.mjs --verify-surface-coverage`: passed. The report listed 22 declared public SDK surfaces, no uncovered surfaces, and no uncovered strict matrix rows.
- Verified `node scripts\verify-workflow-policy.mjs`: passed all publish and CI policy checks, including OIDC trusted publishing, no long-lived registry tokens, strict promotion reports, CodeQL gate wiring, exact promoted artifact use, branch lock to main, default dry-run, version confirmation, and SHA-pinned workflow actions.
- Verified `node scripts\secret-scan-policy.mjs`: passed with exit code 0.

### 2026-05-25T13:41:36+03:00 - Agent 4
- Fixed SDK contract polish found by second-opinion review before GA: removed gateway-rejected Responses adapter parameters from the typed TS and Python public surfaces, added docs/changelog wording that Responses is limited to gateway-supported adapter fields, and kept unsupported body escape hatches under explicit extra-body controls.
- Added voice pipeline client-side scope guards. A default flat `/v1` client now rejects `voice.pipeline.create()` before network I/O unless it was configured with `pipelineId` or a pipeline-scoped base URL, preventing a public SDK method from silently calling a missing flat gateway route.
- Added typed replay metadata for the gateway `X-RunInfra-Idempotent-Replay: true` header. JSON SDK responses now expose `_idempotent_replay: true` alongside `_request_id`, and the strict live-canary default idempotency evidence paths now include `_idempotent_replay`.
- Verified focused SDK regressions: TS Responses parameter typing, Python Responses signature, TS voice pipeline guard, Python voice pipeline guard, TS request-id/replay metadata, and Python request-id/replay metadata all passed.
- Verified broad SDK gates: `pnpm --dir typescript exec tsc -p tsconfig.json --noEmit` passed; `pnpm --dir typescript test -- --reporter dot --testTimeout 5000` passed 208 tests; `python -m pytest python\tests -q` passed 133 tests and 133 subtests; `pnpm --dir typescript build` passed.
- Verified SDK policy/security gates: `node scripts\run-sdk-live-canaries.mjs --verify-surface-coverage`, `node scripts\verify-workflow-policy.mjs`, `node scripts\secret-scan-policy.mjs`, and `git diff --check` passed. `git diff --check` only printed expected Windows LF-to-CRLF warnings on touched files.
- In the isolated RunPipe gateway candidate worktree, added request-id propagation to flat image generation, TTS, and ASR routes and asserted `x-request-id` plus client request-id echo in `app/api/v1/workspace-flat.test.ts`.
- Verified gateway candidate: `pnpm test -- app/api/v1/workspace-flat.test.ts` passed 103 tests; `pnpm typecheck` passed; `git diff --check` passed with expected Windows LF-to-CRLF warnings only. Committed locally as `19e3da6f fix: propagate v1 trace headers for multimodal routes` on `fix/sdk-gateway-contracts-main-20260525`.
- GA remains blocked for production publishing. The SDK source is stronger, but npm/PyPI publish still requires the gateway candidate to be pushed/deployed, strict live readiness to stop reporting blocked multimodal/idempotency rows, strict artifact-mode live canaries to pass, registry install/import proof for the release version, and independent review after final candidate artifacts are regenerated.

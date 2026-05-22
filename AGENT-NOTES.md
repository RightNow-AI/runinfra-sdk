# SDK agent handoff — what you need to know

This document is for future Claude / Codex / Cursor sessions working on the
RunInfra SDKs. Read this BEFORE making changes.

> **Repo context (2026-05-23):** This is the PUBLIC `RightNow-AI/runinfra-sdk`
> repo. The SDK was extracted from the private monorepo
> `RightNow-AI/RunInfra-Landing` on 2026-05-23 (post v0.1.1 publish). All
> future releases (v0.2.0+) publish from THIS repo via OIDC trusted publishing.
>   - v0.1.0: bootstrap publish from a local machine (no provenance)
>   - v0.1.1: first CI publish via OIDC from RunInfra-Landing (has provenance)
>   - v0.2.0+: published from this repo

After the v0.2.0+ migration, both npm + PyPI Trusted Publisher rules need to
be reconfigured to point at `RightNow-AI/runinfra-sdk` + `publish.yml` +
the `npm` / `pypi` environments respectively. The old rules pointing at
`RunInfra-Landing` can be removed.

## What ships

Two public packages, both with first releases on 2026-05-22:

| Registry | Package | Version | Source |
|---|---|---|---|
| npm | `@runinfra/sdk` | `0.1.1` (and 0.1.0 bootstrap) | `sdks/typescript/` |
| PyPI | `runinfra` | `0.1.1` (and 0.1.0 bootstrap) | `sdks/python/` |

Customer install:
```
npm install @runinfra/sdk
pip install runinfra
```

## The SDK lives in a private monorepo (`RightNow-AI/RunInfra-Landing`)

The repo this code lives in is **private**. That repo also contains the
frontend (runinfra.ai), the API routes, billing logic, internal admin tools.

What's exposed publicly via the SDK publish:
- The repo name (visible in npm provenance attestation claims).
- The workflow filename (`sdk-publish.yml`).
- The GH environment names (`npm`, `pypi`).
- The specific commit SHA per release.

What's NOT exposed:
- Any source code.
- Engine source. Billing logic. Internal routes. Customer data.
- Anything outside the published tarball.

**Published tarball contents (always exactly these files):**

npm `@runinfra/sdk`:
- `dist/index.js`
- `dist/index.d.ts`
- `README.md`
- `CHANGELOG.md`
- `LICENSE`
- `package.json`

PyPI `runinfra`:
- `runinfra/__init__.py`
- `runinfra/py.typed`
- `README.md`
- `CHANGELOG.md`
- `LICENSE`
- `pyproject.toml`

Source maps are NOT included. The SDK `tsconfig.json` does not emit them.
The Engine repo (separate) has its own sourceMap concern documented in the
Engine's CLAUDE.md (P1 to disable for v1.0.0).

**The right long-term fix**: extract SDK to its own public repo
`RightNow-AI/runinfra-sdk`. This makes provenance point at a clean public
repo and lets customers browse source for trust. Estimated 1 day of work
post-stabilization. See "Roadmap → Repo extraction" below.

## OIDC trusted publishing

Both registries are configured to accept publishes ONLY from this specific
workflow + environment combination:

| Registry | Trusted publisher rule |
|---|---|
| npm | `RightNow-AI/RunInfra-Landing` + `sdk-publish.yml` + env `npm` |
| PyPI | `RightNow-AI/RunInfra-Landing` + `sdk-publish.yml` + env `pypi` |

No long-lived registry tokens are accepted. `scripts/publish-sdk-artifacts.mjs`
explicitly rejects `NODE_AUTH_TOKEN`, `NPM_TOKEN`, `TWINE_PASSWORD`,
`PYPI_API_TOKEN`. The workflow sets `NODE_AUTH_TOKEN: ""` on the publish step
to suppress the `actions/setup-node` placeholder.

**v0.1.0 was bootstrapped locally** because npm requires the package to exist
before a Trusted Publisher rule can be added. The local publish used
`npm login --auth-type=legacy` + 2FA OTP, no token-in-env. v0.1.0 has the
npm registry signature (auto) but no Sigstore-backed provenance attestation.

**v0.1.1+** are published via the workflow and DO have provenance attestations.

Verify provenance on a release:
```
npm view @runinfra/sdk@0.1.1 dist.attestations
```

## The `bypass_live_canary` flag — currently load-bearing

The strict CI pipeline expects 5 modalities (LLM, embeddings, image, ASR, TTS)
to have `active_verified` deployments in prod with billing proof for each
canary call. As of 2026-05-22, **the canary infrastructure is not yet stable
enough to deliver this**. Production deploys keep SIGINT'ing in-process
provisioning, leaving zero `active_verified` deployments in the database.

We added a `RUNINFRA_SDK_BYPASS_LIVE_CANARY` env flag + a
`bypass_live_canary: true` workflow input that skip these gates:

- Goal-readiness validation (`verify-sdk-goal-completion.mjs` early-exits
  with a synthetic passing report).
- Live-targets discovery + canary verification.
- Env-check + focused-smoke + OpenAI-compat smoke.
- The bypass DOES NOT skip:
  - Secret hygiene (`verify-sdk-secret-hygiene.mjs`).
  - Release verification artifact-shape gates.
  - Source digest matching.
  - Token rejection (still rejects all registry tokens).
  - OIDC trusted publishing path (still required).

**Trigger pattern (current):**
```
gh workflow run sdk-publish.yml --repo RightNow-AI/RunInfra-Landing \
  --ref main -f publish=true -f bypass_live_canary=true
```

**Retire the bypass for v1.0.0.** This requires:
1. Real LLM + embeddings canary deployments in prod (the `runinfra-sdk-canary`
   workspace, ID `13517b38-b3cb-47b4-a474-0473b0e92f95`).
2. Engine durable-worker refactor so Fly redeploys don't SIGINT canaries.
3. Image / ASR / TTS canary pipelines authored + deployed.
4. Workflow `bypass_live_canary` input removed.
5. Six bypass branches removed from the four gate scripts.

Audit P2 finding: `bypassed: true` field gets silently dropped in goal-readiness
output. Future enhancement: thread it through so JSON consumers (audit
dashboards) can detect bypass mode.

## Modality status — what's actually verified

| Surface | Status as of 0.1.1 |
|---|---|
| `client.chat.completions.create` | Beta, contract-tested |
| `client.responses.create` | Beta, contract-tested |
| `client.embeddings.create` | Beta, contract-tested |
| `client.images.generate` | **Experimental** — HTTP envelope matches OpenAI Images API but no live-canary verification |
| `client.audio.speech.create` | **Experimental** — same |
| `client.audio.transcriptions.create` | **Experimental** — same |
| `client.webhooks.verifySignature` / `.constructEvent` | Works locally |
| `client.webhooks.create` / `.list` | Throws `UnsupportedOperationError` — delivery not shipped |
| `client.voice.pipeline.create` | Throws `UnsupportedOperationError` — not shipped |

The READMEs include a Modality Status table that mirrors this. JSDoc
(`@experimental` tag) + Python docstrings (`[EXPERIMENTAL]` marker) on the
classes/methods drive IDE warnings for customers using experimental surfaces.

## Critical files

**SDK source:**
- `sdks/typescript/src/index.ts` — the entire TS SDK (single-file, ~1700 lines)
- `sdks/python/runinfra/__init__.py` — the entire Python SDK (single-file)
- `sdks/typescript/src/index.test.ts` — TS contract tests
- `sdks/python/tests/test_runinfra_sdk.py` — Python contract tests

**Packaging:**
- `sdks/typescript/package.json` — npm metadata; `files[]` array is the
  publish whitelist
- `sdks/python/pyproject.toml` — PyPI metadata; classifier `Development
  Status :: 4 - Beta` until 1.0.0
- `sdks/python/MANIFEST.in` — explicit include/exclude for the sdist

**Workflow:**
- `.github/workflows/sdk-publish.yml` — single source of truth for publish
- Bypass env propagation happens on individual gate steps, NOT job-level
  (job-level leaks into vitest contract tests; see PR #227 history)

**Gate scripts (read-only — don't modify lightly):**
- `scripts/sdk-live-report-contract.mjs` — what "fully verified" means
- `scripts/verify-sdk-publish-readiness.mjs` — top of the gate stack
- `scripts/verify-sdk-goal-completion.mjs` — goal checklist
- `scripts/verify-sdk-live-targets.mjs` — live discovery validation
- `scripts/verify-sdk-live-report.mjs` — live canary report validation
- `scripts/verify-sdk-release.mjs` — broad release gate
- `scripts/verify-sdk-secret-hygiene.mjs` — secret pattern scan
- `scripts/publish-sdk-artifacts.mjs` — the OIDC publisher

## Versioning policy

- **Patch (0.1.x)**: doc fixes, JSDoc tweaks, packaging metadata changes that
  do not alter the API surface. Customers don't need to retest.
- **Minor (0.x.0)**: new methods, new options, new surfaces. Or graduating
  an experimental surface to beta. Backwards-compatible additions only.
- **Major (1.0.0)**: GA. Requires all 5 modalities live-canary verified
  end-to-end, bypass retired, strict gate flipped back on. Surface-stable
  guarantees + 12-month deprecation notice for breaking changes.

## Publish playbook (current state)

1. Update `sdks/typescript/package.json` version + `sdks/python/pyproject.toml`
   version + `sdks/typescript/src/index.ts:RUNINFRA_SDK_VERSION` constant +
   `sdks/python/runinfra/__init__.py:__version__` constant.
2. Update both CHANGELOG.md files.
3. Commit + push + PR + merge to main.
4. `gh workflow run sdk-publish.yml --ref main -f publish=true -f bypass_live_canary=true`
5. `gh run watch <id>` for ~10 minutes.
6. Verify: `npm view @runinfra/sdk@<version> dist.attestations`
   + `pip index versions runinfra`.

## Things future agents must NOT do

- **Do not** add `NODE_AUTH_TOKEN` / `NPM_TOKEN` / `PYPI_API_TOKEN` /
  `TWINE_PASSWORD` to GH Secrets or pass them to publish scripts.
  `publish-sdk-artifacts.mjs` rejects these by design.
- **Do not** set `RUNINFRA_SDK_BYPASS_LIVE_CANARY` at the job level in the
  workflow. It must be on individual gate steps only. Job-level leaks into
  vitest contract tests (see PR #227 history).
- **Do not** add literal strings like `"Verify SDK goal readiness"` in
  workflow comments — the workflow contract test uses `indexOf` on those
  labels (PR #228).
- **Do not** publish from a local machine again once Trusted Publishers
  are in place. The local bootstrap was a one-shot for v0.1.0 only.
- **Do not** add sourcemaps to the SDK tsconfig. The current `sourceMap`
  default (undefined → false) is intentional.
- **Do not** widen the `files[]` array in `package.json` without auditing
  what would ship. The current list is exhaustive on purpose.
- **Do not** delete the LICENSE file. Socket.dev flags packages without one.
- **Do not** ship the engine repo's `RUNINFRA_ENGINE_*` env vars in any SDK
  build artifact. The `verify-sdk-secret-hygiene.mjs` script will catch this,
  but be paranoid.

## Roadmap

### Immediate (post-v0.1.1)
- Confirm the v0.1.1 CI publish actually generates provenance attestations
  (the local v0.1.0 publish did not).
- Configure npm + PyPI download badges in the READMEs.
- Submit `runinfra` to PyPI for Trusted Repository badge.

### Near-term (post-stabilization)
- Author LLM canary pipeline + deploy to `runinfra-sdk-canary` workspace.
- Validate the existing canary harness works against a real `active_verified`
  deployment.
- Retire `bypass_live_canary` for LLM modality first; tighten gate to
  `REQUIRED_LIVE_COVERAGE = ["llm"]`.
- Ship 0.2.0 with LLM live-verified, others still experimental.

### Mid-term (post-LLM-canary)
- Repeat for embeddings → 0.3.0.
- Repo extraction to `RightNow-AI/runinfra-sdk` public repo. Use
  `git subtree split` to preserve history. Reconfigure OIDC publishers.

### Long-term (v1.0.0 GA)
- All 5 modalities live-verified.
- Engine durable-worker refactor to eliminate SIGINT-on-redeploy.
- Retire bypass flag entirely + delete the 6 bypass branches from gate
  scripts.
- SLA + deprecation policy committed.

## Contact + escalation

- Security concerns: licensing@runinfra.ai (production), security@runinfra.ai
  (vulnerabilities).
- Build / packaging questions: this file + `AGENTS-GOALs/2026-05-20-agent-4-sdk-production-release-goal.md`.
- Live canary infrastructure (the bypass blocker): see Engine `AGENTS-GOALs/`
  for the durable-worker refactor proposal.

Last updated: 2026-05-23 by SDK v0.1.1 release.

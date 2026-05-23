# SDK agent handoff — read before changing anything

This document is for future Claude / Codex / Cursor sessions working on the
RunInfra SDKs. Read it BEFORE making changes — the setup has non-obvious
constraints around OIDC trusted publishing and registry policy.

> **Repo context (2026-05-23):** This is the PUBLIC `RightNow-AI/runinfra-sdk`
> repo. Both SDKs were extracted here on 2026-05-23 from the private monorepo
> `RightNow-AI/RunInfra-Landing` (which still contains the frontend, billing,
> engine RPC clients, admin tools).
>
> - **v0.1.0** — bootstrap publish from a local machine (npm registry signature
>   only; no Sigstore-backed provenance). Required because npm needs the
>   package to exist before a Trusted Publisher rule can be added.
> - **v0.1.1** — published from this repo via OIDC trusted publishing. Has
>   Sigstore provenance + npm `--provenance` attestations.
> - **v0.1.2** — hardened release gates, exact artifact allowlists, GitHub
>   environment protection, and Node 24-compatible workflow actions.
> - **v0.1.3** — hardened browser runtime guards, avoided URL normalization
>   regex backtracking, pinned CI build tooling, SHA-pinned workflow actions,
>   and made real publish dispatch require an exact version confirmation.
> - **v0.2.0+** — same path as 0.1.3.
>
> Both registries' Trusted Publisher rules have been migrated to point at
> THIS repo. The old rules pointing at `RunInfra-Landing` were removed.

## What ships

| Registry | Package | Source dir | Latest |
|---|---|---|---|
| npm | `@runinfra/sdk` | `typescript/` | `0.1.3` |
| PyPI | `runinfra` | `python/` | `0.1.3` |

Customer install:
```
npm install @runinfra/sdk
pip install runinfra
```

## Published tarball contents — keep these tight

**npm `@runinfra/sdk`** (controlled by `typescript/package.json` `files[]`):

- `dist/index.js`
- `dist/index.d.ts`
- `README.md`
- `CHANGELOG.md`
- `LICENSE`
- `package.json`

**PyPI `runinfra`** (controlled by `python/MANIFEST.in`):

- `runinfra/__init__.py`
- `runinfra/py.typed`
- `README.md`
- `CHANGELOG.md`
- `LICENSE`
- `pyproject.toml`

The CI workflow asserts exact allowlists and forbids `.map`, `.env`, tests,
source folders, caches, `.npmrc`, and bytecode via
`scripts/verify-npm-package.mjs` and `scripts/verify-python-package.py`. Don't
widen `files[]` or `MANIFEST.in` without understanding what would ship.

No source maps. `typescript/tsconfig.json` deliberately does NOT emit them.

## OIDC trusted publishing — the only allowed path

Both registries are configured to accept publishes ONLY from this exact
combination:

| Registry | Trusted publisher rule |
|---|---|
| npm | `RightNow-AI/runinfra-sdk` + `publish.yml` + env `npm` |
| PyPI | `RightNow-AI/runinfra-sdk` + `publish.yml` + env `pypi` |

The GitHub `npm` and `pypi` environments require reviewer approval by
`jaberjaber23`, prevent self-review, are restricted to protected branches,
and have admin bypass disabled. Main branch protection also enforces admins.

**Critical config gotchas (learned the hard way):**

1. **For the npm publish step, do NOT set `registry-url` on `actions/setup-node`.**
   Setting it creates an `.npmrc` with `_authToken=${NODE_AUTH_TOKEN}`. The
   npm CLI then demands a token instead of using OIDC, and you get
   `ENEEDAUTH` even with valid OIDC config. Set the registry inline in the
   publish step with `npm config set registry https://registry.npmjs.org/`.

2. **npm 11.5.1+ is required.** Older versions don't understand the trusted
   publishing workflow. Install with `npm install -g npm@11.5.1` (or newer)
   before `npm publish`.

3. **`id-token: write` permission** must be on the job, NOT just at workflow
   level. Without it, GitHub doesn't mint the OIDC token.

4. **PyPI trusted-publisher fields must match the OIDC claims exactly.** The
   form is forgiving on case but strict on filename/env. Workflow filename
   is `publish.yml` (NOT `sdk-publish.yml` — that was the old monorepo
   workflow). Environment is lowercase `pypi`.

5. **npm policy after May 2026** requires explicitly checking the
   "npm publish" action when configuring the Trusted Publisher. If you
   don't, the publish call returns a confusing error.

6. **No long-lived registry tokens** anywhere. Don't add `NODE_AUTH_TOKEN`,
   `NPM_TOKEN`, `TWINE_PASSWORD`, `PYPI_API_TOKEN` to GH Secrets. The
   workflow has no fallback for them by design.

## Modality status — what's actually verified

| Surface | Status |
|---|---|
| `client.chat.completions.create`, `client.responses.create` | Beta, contract-tested |
| `client.embeddings.create` | Beta, contract-tested |
| `client.images.generate` | **Experimental** — HTTP envelope matches OpenAI Images API but not live-canary verified end-to-end |
| `client.audio.speech.create` | **Experimental** — same |
| `client.audio.transcriptions.create` | **Experimental** — same |
| `client.webhooks.verifySignature` / `.constructEvent` | Works locally |
| `client.webhooks.create` / `.list` | Throws `UnsupportedOperationError` — delivery not shipped |
| `client.voice.pipeline.create` | **Experimental** - posts binary audio to the pipeline-scoped `/pipeline` route, not live-canary verified |

Python remains sync-only in v0.1.3. Keep FastAPI/async users pointed at worker
threads, queues, or background jobs until `AsyncRunInfra` ships with matching
unit, streaming, live-canary, and clean-install coverage.

The READMEs include a Modality Status table that mirrors this. JSDoc
(`@experimental`) and Python docstrings (`[EXPERIMENTAL]`) on the classes
drive IDE warnings for customers using experimental surfaces.

## Repository layout

```
runinfra-sdk/
├── README.md             — project overview + install
├── LIVE-CANARIES.md      — strict GA live-canary matrix and env contract
├── LICENSE               — proprietary source-available terms
├── AGENT-NOTES.md        — this file
├── .gitignore
├── typescript/
│   ├── package.json      — npm metadata; files[] is the publish whitelist
│   ├── tsconfig.json     — sourceMap NOT emitted on purpose
│   ├── src/
│   │   ├── index.ts      — entire SDK (single file, ~1700 lines)
│   │   └── index.test.ts — contract tests
│   ├── README.md
│   ├── CHANGELOG.md
│   └── LICENSE
├── python/
│   ├── pyproject.toml    — PyPI metadata; classifier 4-Beta until 1.0.0
│   ├── MANIFEST.in       — explicit include/exclude for sdist
│   ├── runinfra/
│   │   ├── __init__.py   — entire SDK (single file)
│   │   └── py.typed
│   ├── tests/
│   │   └── test_runinfra_sdk.py
│   ├── README.md
│   ├── CHANGELOG.md
│   └── LICENSE
└── .github/workflows/
    ├── ci.yml            — type-check + test + build + tarball-leak scan on PR
    └── publish.yml       — manual workflow_dispatch publish via OIDC
```

CodeQL is intentionally enforced by GitHub default setup and protected checks.
Do not add `.github/workflows/codeql.yml` while default setup is enabled;
GitHub rejects advanced uploads in that configuration.

LICENSE files exist in 3 places (root + typescript/ + python/). They are
identical proprietary source-available terms. Customers see them via:

- npm: tarball includes `LICENSE` (per `files[]`)
- PyPI: sdist + wheel include `LICENSE` (per `MANIFEST.in` + `license = { file = "LICENSE" }`)
- GitHub: the root `LICENSE` shows up on the repo page

## Publish playbook

1. Update version in 4 places (keep all in sync):
   - `typescript/package.json` → `"version"`
   - `typescript/src/index.ts` → `RUNINFRA_SDK_VERSION`
   - `python/pyproject.toml` → `version`
   - `python/runinfra/__init__.py` → `__version__`

2. Update both CHANGELOG.md files (`typescript/CHANGELOG.md` and
   `python/CHANGELOG.md`).

3. Commit + push + PR + merge to `main`.

4. Wait for `ci.yml` and the GitHub default CodeQL `Analyze (...)` checks to
   pass green on `main`.

5. Trigger publish:
   ```
   gh workflow run publish.yml --repo RightNow-AI/runinfra-sdk --ref main \
     -f package=both -f dry_run=false -f confirm_version=<version>
   ```

   - `package`: `both` | `typescript` | `python`
   - `dry_run`: `true` (verify only) | `false` (actually publish)
   - `confirm_version`: exact package version, required when `dry_run=false`

Before GA promotion, also run:
```
pnpm --dir typescript build
node scripts/verify-clean-installs.mjs --package both --mode artifact
node scripts/run-sdk-live-canaries.mjs --package-source artifact --strict --report artifacts/sdk/live-canary.json
```

Do not graduate image, TTS, ASR, or voice pipeline out of experimental status
without strict TypeScript + Python live-canary reports for the exact production
gateway, models, workspace key, and pipeline key. Strict reports must keep
TS/Python row parity, redact custom base URLs, drain final streams to terminal
events, and prove idempotency replay with explicit gateway evidence.

6. Watch:
   ```
   gh run watch <run-id> --repo RightNow-AI/runinfra-sdk
   ```
   Expect ~3-5 minutes.

7. Verify post-publish:
   ```
   npm view @runinfra/sdk@<version> dist.attestations
   pip index versions runinfra
   ```

   `dist.attestations` should be a non-empty JSON blob (Sigstore-signed
   provenance). PyPI provenance is visible at
   https://pypi.org/manage/project/runinfra/publishing/.

## Versioning policy

- **Patch (0.1.x)** — doc fixes, JSDoc tweaks, packaging metadata changes
  that don't alter the API surface. Customers don't need to retest.
- **Minor (0.x.0)** — new methods, new options, new surfaces. Or graduating
  an experimental surface to beta. Backwards-compatible additions only.
- **Major (1.0.0)** — GA. Requires all 5 modalities live-canary verified
  end-to-end. Surface-stable guarantees + 12-month deprecation notice for
  breaking changes.

## What changed from the monorepo setup

If you're reading old AGENTS-GOALs files from `RunInfra-Landing/AGENTS-GOALs/`,
some things are now obsolete in the new repo context:

| Old (monorepo `RunInfra-Landing`) | New (this repo `runinfra-sdk`) |
|---|---|
| Workflow: `.github/workflows/sdk-publish.yml` | `.github/workflows/publish.yml` + `.github/workflows/ci.yml` + GitHub default CodeQL checks |
| Bypass flag: `RUNINFRA_SDK_BYPASS_LIVE_CANARY` + `bypass_live_canary` input | None. The simplified workflow doesn't run the strict gate scripts. |
| Gate scripts: `scripts/verify-sdk-*.mjs` + `scripts/publish-sdk-artifacts.mjs` | Package gates are local scripts in `scripts/`; strict live canaries run through `scripts/run-sdk-live-canaries.mjs`. |
| Source paths: `sdks/typescript/`, `sdks/python/` | `typescript/`, `python/` (root-level) |
| Workflow has 5-modality live canary gate | CI/publish run package gates; GA still requires strict live canary reports before promotion. |
| Repo URLs in metadata: `RunInfra-Landing` | `runinfra-sdk` |
| Publish requires bypass workflow input | Publish only requires `package=both/typescript/python` + `dry_run=false` |

The strict package gates are replicated here, but GA still requires complete
production live-canary reports for every supported public SDK surface before
retiring the implicit beta status.

## Things future agents must NOT do

- **Do not** add `NODE_AUTH_TOKEN` / `NPM_TOKEN` / `PYPI_API_TOKEN` /
  `TWINE_PASSWORD` to GH Secrets or pass them to the publish workflow.
  OIDC trusted publishing is the only allowed path.
- **Do not** set `registry-url` on `actions/setup-node` in the npm publish
  job. It creates an `.npmrc` that forces token-based auth.
- **Do not** add sourcemaps to `typescript/tsconfig.json`. The current
  setting (sourceMap omitted → false) is intentional.
- **Do not** widen the `files[]` array in `typescript/package.json` without
  auditing what would ship. The list is exhaustive on purpose.
- **Do not** widen `python/MANIFEST.in` without auditing.
- **Do not** delete the LICENSE files. Socket.dev flags packages without one.
- **Do not** publish from a local machine again unless the registry forces
  it. The local bootstrap was a one-shot for v0.1.0; everything after must
  flow through CI.
- **Do not** add the AGENTS.md/CLAUDE.md from the private monorepo to this
  public repo — they reference internal infra.
- **Do not** delete the `typescript/` or `python/` test directories. CI
  needs them.
- **Do not** rename `publish.yml` or `ci.yml` without updating both
  Trusted Publisher rules in the npm + PyPI admin UIs. Their rules pin the
  exact filename.

## Roadmap

### Immediate (post v0.1.1)
- Add npm + PyPI download badges to the root README.
- Add CI status badge to the root README.
- Consider adding `provenance` badge once v0.1.1 attestation is verified.

### Near-term (toward 0.2.0)
- Author real LLM + embeddings canary pipelines in the prod canary
  workspace `13517b38-b3cb-47b4-a474-0473b0e92f95`. Validate the
  canary harness against `active_verified` deployments. This work is
  tracked in the Engine repo (`RunInfra-Engine` / `RunInfra-Engine-Fly`),
  not here.
- When LLM is live-verified end-to-end, bump experimental→beta and ship
  0.2.0.

### Mid-term (toward 0.3.0+)
- Same for embeddings, image, ASR, TTS one at a time.
- Each modality graduation = one minor release.

### Long-term (v1.0.0 GA)
- All 5 modalities live-verified.
- Engine durable-worker refactor to eliminate SIGINT-on-redeploy
  (Engine roadmap).
- Port strict gate scripts from `RunInfra-Landing/scripts/verify-sdk-*.mjs`
  (or define a public-repo equivalent set).
- SLA + deprecation policy committed.
- Drop the "experimental" tags from all surfaces.

## Contact + escalation

- Security: `security@runinfra.ai` for vulnerabilities (preferred over
  GitHub issues for security-sensitive reports).
- Commercial licensing: `licensing@runinfra.ai`.
- General SDK questions: open an issue in this repo.
- Customer support for the RunInfra hosted service: `support@runinfra.ai`.

## History of the migration (for posterity)

The SDK was originally added to `RightNow-AI/RunInfra-Landing` (private
monorepo) under `sdks/typescript/` + `sdks/python/`. The publish workflow
there (`sdk-publish.yml`) had a strict 5-modality live canary gate that
couldn't be satisfied because the canary infrastructure was unstable
(production redeploys SIGINT'ing in-process provisioning).

To unblock the initial release, a `RUNINFRA_SDK_BYPASS_LIVE_CANARY` env
flag was added that skipped live-canary, env-check, smoke, and
goal-readiness gates while keeping secret-hygiene + artifact-shape gates.
This shipped v0.1.0 (bootstrapped locally; no provenance) and was about
to ship v0.1.1 (CI publish from monorepo, would have had provenance).

Concurrently, the monorepo's private nature caused Socket.dev and similar
audit concerns about the source provenance pointing at a private repo.
The decision was made to extract the SDK to this public repo so that
provenance attestations point at a verifiable source.

The extraction (2026-05-23):
1. Bootstrapped this repo (`RightNow-AI/runinfra-sdk`) with copies of
   `sdks/typescript/` + `sdks/python/` from the monorepo at the v0.1.1
   state.
2. Wrote a simplified `ci.yml` + `publish.yml` without the heavy gate
   scripts (the bypass flag isn't needed because the gates aren't present).
3. User reconfigured npm + PyPI Trusted Publishers to point at this repo.
4. v0.1.1 shipped from here as the first OIDC-attested release.
5. The monorepo's `sdks/` directory remains as historical reference but
   should not be modified anymore.

Last updated: 2026-05-23 (post-extraction, first OIDC publish run).

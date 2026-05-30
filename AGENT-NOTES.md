# SDK Maintainer Notes

This file is a public maintainer runbook for the RunInfra SDK repository. Keep
it customer-safe: no local paths, no registry tokens, no private repository
history, no workspace identifiers, and no operational secrets.

## Release State

| Registry | Package | Source dir | Source version |
|---|---|---|---|
| npm | `@runinfra/sdk` | `typescript/` | `0.1.4` |
| PyPI | `runinfra` | `python/` | `0.1.4` |

Registry latest remains `0.1.3` until the protected trusted-publish workflow
publishes `0.1.4` from `main`.

## What Ships

The npm package is limited by `typescript/package.json` `files[]`:

- `dist/index.js`
- `dist/index.d.ts`
- `README.md`
- `CHANGELOG.md`
- `LICENSE`
- `package.json`

The Python package is limited by `python/MANIFEST.in` and package metadata:

- `runinfra/__init__.py`
- `runinfra/py.typed`
- `README.md`
- `CHANGELOG.md`
- `LICENSE`
- `pyproject.toml`

The artifact verifiers reject source maps, environment files, credentials,
tests, caches, build byproducts, `.npmrc`, `.pypirc`, `.netrc`, and Python
bytecode. The Python verifier also checks wheel `RECORD` hashes and sdist
`SOURCES.txt` contents.

No source maps are allowed. `typescript/tsconfig.json` intentionally omits
`sourceMap`, and the promotion source digest includes `typescript/tsconfig.json` and `python/MANIFEST.in`.

## Trusted Publishing Policy

Publishing must use GitHub OIDC trusted publishing from this repository:

| Registry | Trusted publisher rule |
|---|---|
| npm | `RightNow-AI/runinfra-sdk` + `publish.yml` + environment `npm` |
| PyPI | `RightNow-AI/runinfra-sdk` + `publish.yml` + environment `pypi` |

Do not add long-lived registry credentials such as `NODE_AUTH_TOKEN`,
`NPM_TOKEN`, `TWINE_PASSWORD`, or `PYPI_API_TOKEN`. The workflow is intentionally
tokenless.

Important npm details:

1. Do not set `registry-url` on `actions/setup-node` in the publish job. It
   writes an `.npmrc` that can force token authentication.
2. Use npm 11.5.1 or newer for trusted publishing.
3. Keep `id-token: write` on the publish jobs.

Important PyPI details:

1. The trusted publisher must match workflow filename `publish.yml`.
2. The environment name is lowercase `pypi`.
3. Publish only through the protected environment.

## Modality Status

| Surface | Status |
|---|---|
| `client.chat.completions.create`, `client.responses.create` | Beta, contract-tested. Current 0.1.4 promotion artifacts are not strict-live green; publish requires fresh production artifact canaries with zero skipped or failed rows |
| `client.embeddings.create` | Beta, contract-tested. Not strict live-canary verified in the current promotion artifacts |
| `client.images.generate` | Experimental, HTTP envelope matches the documented API but strict live canary coverage is still required |
| `client.audio.speech.create` | Experimental, strict live canary coverage is still required |
| `client.audio.transcriptions.create` | Experimental, strict live canary coverage is still required |
| `client.voice.pipeline.create` | Experimental, pipeline-scoped route, not live-canary verified |
| `client.webhooks.verifySignature`, `client.webhooks.constructEvent` | Local helpers, covered by unit tests |
| Webhook delivery create/list | Not shipped and not exposed on the public SDK surface |

Python remains sync-only in `0.1.4`. Do not claim async support until an
`AsyncRunInfra` client has matching unit tests, streaming tests, live canaries,
and clean-install coverage.

## Release Checklist

1. Keep versions synchronized:
   - `typescript/package.json` `version`
   - `typescript/src/index.ts` `RUNINFRA_SDK_VERSION`
   - `python/pyproject.toml` `version`
   - `python/runinfra/__init__.py` `__version__`
2. Update both changelogs.
3. Run package, policy, and clean-install gates locally.
4. Commit, push, review, and merge to `main`.
5. Confirm `ci.yml` and GitHub default CodeQL checks are green on `main`.
6. Run the protected `publish.yml` workflow with the exact version confirmation.
7. Verify registry installs and provenance after publish.

Required pre-publish commands:

```bash
node scripts/verify-workflow-policy.mjs
node scripts/verify-github-security-status.mjs --repo RightNow-AI/runinfra-sdk
pnpm --dir typescript build
node scripts/verify-clean-installs.mjs --package both --mode artifact
node scripts/run-sdk-live-canaries.mjs --preflight --strict --report artifacts/sdk/live-canary-readiness.json
node scripts/run-sdk-live-canaries.mjs --package-source artifact --strict --report artifacts/sdk/live-canary.json
node scripts/verify-promotion-reports.mjs --readiness artifacts/sdk/live-canary-readiness.json --live artifacts/sdk/live-canary.json --artifacts-root .
```

The publish workflow builds the npm tarball, Python wheel, and Python sdist
once, uploads them as `runinfra-sdk-promoted-artifacts`, downloads the same
artifacts for strict readiness and live promotion reports, recomputes hashes
with `--artifacts-root .`, and the publish jobs publish only the downloaded `runinfra-sdk-promoted-artifacts` files. `dry_run=false` cannot bypass `promotion-gate`.

Clean artifact install/import now exercises the npm tarball, Python wheel, and
Python sdist. The sdist path builds and imports in a disposable consumer
environment and suppresses successful pip output so local paths do not appear
in logs.

## Live Canary Environment Files

Use the runner's env-file support, not Node's process-level env loading:

```bash
node scripts/run-sdk-live-canaries.mjs --write-env-template .env.sdk-live.local
node scripts/run-sdk-live-canaries.mjs --runinfra-env-file <path-to-env-file> --preflight --strict --report artifacts/sdk/live-canary-readiness.json
```

Do not use Node's `--env-file` option in promotion commands.
`--runinfra-env-file <path-to-env-file>` keeps env-file parsing, explicit
shell-env precedence, and report redaction inside the canary runner.

After a blocked preflight, create a redacted missing strict live-canary env
patch:

```bash
node scripts/run-sdk-live-canaries.mjs --readiness-report artifacts/sdk/live-canary-readiness.json --write-missing-env-template .env.sdk-live.missing.local
```

The missing strict live-canary env patch contains only missing placeholders or
safe defaults. It never diffs an existing env file, never copies current env
values, and is not promotion evidence.

GitHub Actions should store deterministic binary fixtures as scoped secrets:
`RUNINFRA_ASR_FIXTURE_BASE64` and `RUNINFRA_VOICE_PIPELINE_AUDIO_BASE64`.

## Promotion Requirements

Do not graduate image, TTS, ASR, embeddings, or voice pipeline status without
strict TypeScript and Python live-canary reports for the exact production
gateway, model set, workspace key, and pipeline key. Strict reports must keep
TypeScript/Python row parity, redact custom base URLs, drain streaming rows to
terminal events, prove idempotency replay with explicit gateway evidence, and
keep the readiness summary at all rows ready with zero blocked rows.

## Do Not Change Without Review

- Do not add registry tokens or token-based publish fallbacks.
- Do not set `registry-url` on `actions/setup-node` in the npm publish job.
- Do not add sourcemaps.
- Do not remove `typescript/tsconfig.json` or `python/MANIFEST.in` from the
  promotion source digest.
- Do not widen `typescript/package.json` `files[]` or `python/MANIFEST.in`
  without auditing the shipped files.
- Do not remove the package verifiers or clean-install gates.
- Do not rename `publish.yml` or the protected publish environments without
  updating registry trusted-publisher rules first.
- Do not claim GA readiness until strict production live canaries and registry
  clean-install checks pass for the exact released artifacts.

## Support

- Security reports: `security@runinfra.ai`
- Commercial licensing: `licensing@runinfra.ai`
- Hosted service support: `support@runinfra.ai`
- General SDK questions: open a GitHub issue in this repository.

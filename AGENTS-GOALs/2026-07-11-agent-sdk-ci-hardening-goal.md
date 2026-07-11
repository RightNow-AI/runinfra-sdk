# SDK CI Test-Runner Hardening

Date: 2026-07-11
Agent: SDK hardening lane
Repo: `runinfra-sdk`
Worktree: `runinfra-sdk-ci-hardening-20260711`
Branch: `fix/sdk-ci-hardening-20260711`

## Goal

Make every complete Python CI, publish, and contributor test command run the
stdlib `unittest` suite from `python/`, so test imports resolve to the checkout
under test instead of an installed package or sibling worktree. Preserve the
existing package/runtime surface and trusted-publishing policy.

Done means the Python suite, TypeScript suite, build, workflow/version/surface
policy checks, and diff check pass from a fresh branch based on current
`origin/main`; an independent hostile review finds no blocker; and the result
is committed locally without pushing.

## Initial Verified State

- Fresh base: `b9e09353da858cdc5ec53a3600a1f345a89ee038` (`origin/main`).
- The dirty detached SDK checkout and old PR #15 worktree are untouched.
- `python -m unittest discover -s tests -v` from `python/` passed all 158 tests.
- Two focused TypeScript policy regressions fail on the unmodified base:
  stale pytest-version expectations and an LF-only publish-workflow mutation
  that does not match Windows CRLF files.
- npm and PyPI both report `0.2.0` as latest.
- GitHub publish run `27575407723` published 0.2.0 with
  `require_live_canary=false`; strict live-canary steps were skipped under the
  documented infrastructure-unavailable override, while build, unit,
  packaging, security, trusted-publish, and registry-install gates ran.

## Scope

- Existing CI and publish workflow Python test steps.
- Python development requirements.
- Pull-request and contributor test commands.
- TypeScript policy regressions for Python tooling and Windows CRLF.
- The slow Python artifact-failure test timeout, isolated as its own concern.
- `AGENT-NOTES.md` release-state accuracy for 0.2.0.

## Out Of Scope

- SDK runtime behavior or public API changes.
- Money, pricing, billing, or credit semantics.
- Live-canary activation, infrastructure provisioning, publishing, pushing,
  or merging.
- Reusing or updating the old PR #15 branch.

## Guardrails

- Use the existing implementation paths, with no feature flag or parallel
  runner.
- Add no package dependency.
- Stage explicit files only and commit with `git commit -F`.
- Do not push or merge from this lane.

## Checkpoint

Implementation is complete on local branch
`fix/sdk-ci-hardening-20260711`, based on
`b9e09353da858cdc5ec53a3600a1f345a89ee038` (`origin/main`). The implementation
HEAD is `ae4b5fcde541ac50f8895d42c8008cd6f4c0fa95`.

Commits, oldest first:

- `5f0fb6f0de49ab17cdcd1ba15bd252d3771f23b1` - cwd-safe stdlib Python runners.
- `3c1823ef937283f85f5d8e2978e8fd9b2cf05c76` - Windows CRLF-safe policy mutation.
- `06d0878a8727365c8c0b1346dc9aa4805bb2e12d` - isolated slow artifact-test timeout.
- `cf6c150e80d95b64d19813769c74df0f4b9f41e8` - accurate 0.2.0 release evidence.
- `f71b2c3d637d3c030fc7c48b1cdd43ee2cf05639` - close hostile-review gaps.
- `ae4b5fcde541ac50f8895d42c8008cd6f4c0fa95` - preserve strict canary wording.

Verified on the exact implementation HEAD:

- Python 3.14.2 from `python/`: discovery guard found 158 tests; all 158 passed.
- An empty-directory discovery probe exited 1, proving the guard rejects zero tests.
- A fresh virtual environment installed the revised development requirements,
  had no pytest package, and passed all 158 stdlib `unittest` tests.
- TypeScript: all 258 Vitest tests passed, including workflow, cwd mutation,
  Windows CRLF, release-evidence, and isolated-timeout regressions.
- TypeScript no-emit typecheck and build passed.
- Workflow policy, version sync, public-surface coverage, secret scan, Python
  compileall, and `git diff --check` passed. Surface coverage reported zero
  uncovered surfaces and zero uncovered rows.
- The declared CI matrix remains Python 3.9 through 3.14. Only Python 3.14.2
  was executable locally; the stdlib runner and guard are 3.9-compatible, but
  Python 3.9 through 3.13 still require the remote CI matrix after integration.
- A fresh fetch found `origin/main` unchanged at the base SHA. The branch was
  six commits ahead and zero behind, so no rebase was required at that point.

The first independent hostile review returned BLOCK with three findings:
the CONTRIBUTING cwd mutation was not coupled to the command block,
`LIVE-CANARIES.md` contradicted the documented override, and Python 3.11 raw
discovery could pass with zero tests. All three were fixed and covered by
regressions. A focused independent rereview of the exact committed range
`b9e09353..ae4b5fc` then returned `RELEASE`: all three findings were closed and
no remaining material issue was found. CodeRabbit was unavailable locally, so
both hostile reviews used the configured read-only Codex reviewer.

No push, merge, publish, registry mutation, live canary, deployment, or money
change was performed. The old PR #15 worktree and dirty main checkout remain
untouched.

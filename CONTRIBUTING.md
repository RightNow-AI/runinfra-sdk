# Contributing to runinfra-sdk

Thanks for your interest. This repo holds the official TypeScript + Python
client SDKs for the RunInfra inference platform. Contributions are
welcome — please read the rules below before opening a pull request.

## Quick start

```
git clone https://github.com/RightNow-AI/runinfra-sdk.git
cd runinfra-sdk

# TypeScript
cd typescript
pnpm install
pnpm test
pnpm build

# Python
cd ../python
python -m pip install -e .
python -m pytest tests/
```

## Branch + PR workflow

1. Create a branch off `main`.
2. Make focused changes — one concern per PR.
3. Push and open a PR against `main`.
4. CI must pass (TypeScript + Python jobs).
5. A maintainer reviews and merges.

## Commit messages

Use Conventional Commits:

- `feat:` — new functionality
- `fix:` — bug fix
- `chore:` — packaging, tooling, repo hygiene
- `docs:` — docs only
- `refactor:` — internal change with no behavior shift
- `test:` — test-only change
- `sec:` — security-relevant fix
- `perf:` — performance improvement

One concern per commit. Squash-merge is the default merge strategy on this
repo, so the PR title becomes the commit message — make it clean.

## What we accept

- Bug fixes (with a regression test that fails before, passes after).
- New SDK method coverage when the gateway already supports it.
- Documentation improvements (READMEs, JSDoc, docstrings, CHANGELOG).
- Test coverage improvements.
- Repo hygiene (CI improvements, dependency updates, etc.).

## What we don't accept

- New runtime dependencies. Both SDKs are zero-dep and stay that way.
- Source-map emission. Look at `typescript/tsconfig.json` — `sourceMap` is
  intentionally omitted.
- Long-lived registry tokens in CI. Releases are OIDC-only.
- Code that calls non-public RunInfra endpoints. The SDK targets only the
  documented public gateway.
- Whitespace / formatting churn unrelated to a real change.

## Code style

- **TypeScript**: strict mode, no `any` in the published surface, explicit
  return types on exported functions, JSDoc on every public method.
- **Python**: type hints on every public function, `TypedDict` for
  response shapes, `from __future__ import annotations`, docstrings on
  every public class + method.

## Tests

Both SDKs have unit tests that mock the HTTP layer:
- TypeScript: `typescript/src/index.test.ts` — runs via `vitest`.
- Python: `python/tests/test_runinfra_sdk.py` — runs via `pytest`.

Add a test for any new behavior. Tests must not require network access.

## Releases

Maintainers cut releases by:
1. Bumping versions in 4 files (see `AGENT-NOTES.md` for the exact list).
2. Updating both `CHANGELOG.md` files.
3. Merging to `main`.
4. Triggering `Publish` workflow via `workflow_dispatch`.
5. Verifying provenance + install on both registries.

Contributors should not bump versions in PRs unless explicitly asked.

## Security

Do NOT report vulnerabilities via GitHub issues or PRs. See
[`SECURITY.md`](./SECURITY.md) for the disclosure process.

## Questions

Open a GitHub issue with the `question` label, or email
`support@runinfra.ai` for service-related questions.

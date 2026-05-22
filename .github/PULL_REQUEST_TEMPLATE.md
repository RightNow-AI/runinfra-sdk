## Summary

<!-- 1-3 sentences. What changed and why. -->

## Type of change

- [ ] Bug fix (non-breaking change which fixes an issue)
- [ ] New feature (non-breaking change which adds functionality)
- [ ] Breaking change (fix or feature that would cause existing functionality to not work as expected)
- [ ] Documentation only
- [ ] CI / tooling / repo hygiene
- [ ] Security fix

## Checklist

- [ ] My code follows the style of this project (TS strict, no `any` in public surface; Python type hints + docstrings)
- [ ] I have added tests for any new behavior
- [ ] All tests pass locally (`pnpm test` for TS, `python -m pytest` for Python)
- [ ] I have updated the relevant `CHANGELOG.md` files (typescript/ and/or python/)
- [ ] I have NOT bumped the SDK version (maintainers handle that at release time)
- [ ] I have NOT added any runtime dependencies (both SDKs are zero-dep by policy)
- [ ] I have NOT exposed any private RunInfra endpoint or internal hostname

## Related issues

<!-- Closes #N -->

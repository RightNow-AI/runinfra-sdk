# Security policy

The RunInfra SDK is published to public registries (npm + PyPI) and consumed
by enterprise customers handling sensitive prompts and data. We take security
findings seriously.

## Supported versions

| Version | Supported? |
|---|---|
| 0.1.x | ✅ Yes (current beta line) |
| < 0.1.0 | ❌ N/A — no prior releases |

When v1.0.0 ships, the SDK adopts a standard 12-month support window: the
two most recent minor lines receive security fixes; older lines reach EOL.

## Reporting a vulnerability

**Please do NOT open a GitHub issue or pull request for security findings.**
Public disclosure before a fix puts other customers at risk.

Email `security@runinfra.ai` with:

1. A clear description of the issue.
2. Steps to reproduce (proof of concept appreciated; not required).
3. Your assessment of the impact.
4. Any suggested remediation.
5. Whether you want public credit after fix is released.

We acknowledge within **2 business days** and target initial triage within
**5 business days**. For critical issues (auth bypass, RCE, sensitive-data
exfiltration) we work to issue a fix within **14 days**; lower-severity
issues within **30 days**.

## Out of scope

The following are explicitly NOT vulnerabilities in this SDK:

- Issues in the RunInfra hosted service itself (`api.runinfra.ai`).
  Report those to `security@runinfra.ai` with the subject prefix
  `[hosted-service]`.
- Issues in the registries (npm, PyPI) themselves. Report to those vendors.
- Theoretical attacks requiring the attacker to already have unauthenticated
  access to the customer's host (e.g., reading API keys from environment
  variables that the customer set — that is not an SDK issue).
- Behavior of the SDK when `dangerouslyAllowBrowser: true` is explicitly
  opted into in a browser environment. We strongly recommend against this
  for production usage.
- Behavior of forks, patches, or modifications of this SDK.

## Hardening posture of this SDK

The SDK is designed defensively for enterprise use:

- **Transport**: HTTPS enforced for any remote `baseURL` (HTTP allowed only
  for `localhost` to support local development).
- **TLS**: System CA bundle, certificate verification on by default. No
  flag to disable it.
- **Browser runtime guard**: Throws `RunInfraError` if loaded in a browser
  unless `dangerouslyAllowBrowser: true` is set. API keys are bearer
  secrets and should not live in client JS.
- **Header injection prevention**: Custom header values are validated for
  CRLF and control characters before being sent. A locked-out list
  prevents customer code from overriding `Authorization`, `Cookie`, etc.
- **URL parameter encoding**: All path/query parameters are encoded via
  `encodeURIComponent` (TS) / `urllib.parse.quote` (Python).
- **No long-lived registry tokens** in our publish pipeline. Releases ship
  exclusively via GitHub OIDC trusted publishing with SLSA provenance
  attestations.
- **Tarball/wheel scrubbing**: CI rejects any release artifact that
  contains `.map`, `.env`, `.test.ts`, `.pyc`, or `__pycache__`.
- **Zero runtime dependencies** (both TS and Python). Reduces the
  transitive-CVE surface to zero.

## Provenance verification

Verify the npm package was built from this repo by this workflow:

```bash
npm view @runinfra/sdk@<version> dist.attestations
```

Verify the PyPI package was attested by the configured trusted publisher
at https://pypi.org/project/runinfra/.

## Contact

- Vulnerabilities: `security@runinfra.ai`
- Licensing inquiries: `licensing@runinfra.ai`
- Hosted-service support: `support@runinfra.ai`

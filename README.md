# RunInfra SDK

[![npm](https://img.shields.io/npm/v/%40runinfra%2Fsdk.svg?logo=npm&label=%40runinfra%2Fsdk)](https://www.npmjs.com/package/@runinfra/sdk)
[![PyPI](https://img.shields.io/pypi/v/runinfra.svg?logo=pypi&label=runinfra)](https://pypi.org/project/runinfra/)
[![CI](https://github.com/RightNow-AI/runinfra-sdk/actions/workflows/ci.yml/badge.svg)](https://github.com/RightNow-AI/runinfra-sdk/actions/workflows/ci.yml)
[![SLSA provenance](https://img.shields.io/badge/SLSA-provenance-7eb35e?logo=sigstore)](https://docs.npmjs.com/about-package-provenance-statements)
[![License](https://img.shields.io/badge/license-Proprietary-blue.svg)](./LICENSE)

Official client SDKs for [RunInfra](https://runinfra.ai), the optimized
inference platform for serving open-source models on the GPU and serving
backend that fits your workload.

## Install

```bash
# TypeScript / JavaScript
npm install @runinfra/sdk

# Python
pip install runinfra
```

## Quick start

```ts
import { RunInfra } from "@runinfra/sdk";

const apiKey = process.env.RUNINFRA_API_KEY;
if (!apiKey) throw new Error("Set RUNINFRA_API_KEY before running this snippet.");

const client = new RunInfra({ apiKey });

const response = await client.chat.completions.create({
  model: "your-deployed-model-id",
  messages: [{ role: "user", content: "Hello!" }],
});

console.log(response.choices?.[0]?.message?.content);
```

```python
import os
from runinfra import RunInfra

api_key = os.environ.get("RUNINFRA_API_KEY")
if not api_key:
    raise RuntimeError("Set RUNINFRA_API_KEY before running this snippet.")

client = RunInfra(api_key=api_key)

response = client.chat.completions.create(
    model="your-deployed-model-id",
    messages=[{"role": "user", "content": "Hello!"}],
)

print(response["choices"][0]["message"]["content"])
```

## Packages

| Package | Registry | Source | Status |
|---|---|---|---|
| [`@runinfra/sdk`](https://www.npmjs.com/package/@runinfra/sdk) | npm | [`typescript/`](./typescript) | Beta |
| [`runinfra`](https://pypi.org/project/runinfra/) | PyPI | [`python/`](./python) | Beta |

See each package's own README + CHANGELOG for surface-level docs.

## Modality status (v0.1.4)

| Surface | Status |
|---|---|
| Chat completions, Responses | Beta, contract-tested. Strict live GA is still blocked until streaming final/slow-consumer rows pass against production |
| Embeddings | Beta, contract-tested. Not strict live-canary verified in the current promotion artifacts |
| Images, Audio TTS/ASR | **Experimental**, not live-canary verified |
| Voice pipeline | **Experimental**, pipeline-scoped route, not live-canary verified |
| Webhook delivery | Not shipped. Local verification helpers are available in both SDKs; create/list methods are not public SDK surface |

See per-package READMEs and CHANGELOG for the path to v1.0.0 GA.
The strict multimodal GA canary contract is documented in
[`LIVE-CANARIES.md`](./LIVE-CANARIES.md).

## Browser security

RunInfra API keys are bearer secrets. Do not put `RUNINFRA_API_KEY` in browser
code. Browser apps should call your server route or backend proxy first, then
your server calls RunInfra with the workspace or pipeline-scoped key. Ephemeral
browser tokens are not shipped in v0.1.4; do not build a direct browser token
flow until scoped tokens, expiry, audit logging, and live canary coverage exist.

## License

Proprietary, source-available. See [LICENSE](./LICENSE). For commercial
licensing inquiries, contact `licensing@runinfra.ai`.

## Provenance

Each release published from this repo via GitHub Actions OIDC trusted
publishing carries a Sigstore-backed provenance attestation linking it to a
specific CI run.

Code scanning runs through GitHub default CodeQL setup and protected branch
checks. Do not add an advanced CodeQL workflow unless default setup is disabled.

Verify the npm package:
```bash
npm view @runinfra/sdk@latest dist.attestations
```

Verify registry install/import for an exact release:
```bash
node scripts/verify-clean-installs.mjs --package both --mode registry --version <version>
```

Check strict live-canary readiness without exposing env values:
```bash
node scripts/run-sdk-live-canaries.mjs --preflight --strict --report artifacts/sdk/live-canary-readiness.json
```

Run the strict artifact live canary against the exact package artifacts:
```bash
node scripts/run-sdk-live-canaries.mjs --package-source artifact --strict --report artifacts/sdk/live-canary.json
```

The trusted-publish workflow builds the npm tarball, Python wheel, and Python
sdist once, uploads them as `runinfra-sdk-promoted-artifacts`, runs strict
promotion reports against those downloaded artifacts, and publishes only the
same downloaded artifacts after environment approval. `dry_run=false` cannot
bypass the strict report gate. CI audio fixtures use
`RUNINFRA_ASR_FIXTURE_BASE64` and `RUNINFRA_VOICE_PIPELINE_AUDIO_BASE64`;
the workflow decodes them to local fixture files and reports only redacted
presence/path status.

The artifact scanners enforce exact package allowlists before promotion. The
Python wheel scan also validates the wheel `RECORD` manifest covers every file
with SHA-256 hashes and byte sizes, so a stale or tampered wheel manifest fails
before PyPI promotion. The Python sdist scan validates
`runinfra.egg-info/SOURCES.txt` against the expected source file set, so stale
source manifests cannot hide from the archive gate.

After the strict artifact live canary passes, verify that the readiness and
live reports prove the same candidate source digest and that both language
reports passed every row. The promotion verifier requires strict child canary
reports from `https://api.runinfra.ai/v1`; reports generated with custom
non-production `RUNINFRA_BASE_URL` values are staging smoke evidence, not publish evidence:
```bash
node scripts/verify-promotion-reports.mjs --readiness artifacts/sdk/live-canary-readiness.json --live artifacts/sdk/live-canary.json
```

If canary inputs live in a local env file, load it through the runner:
```bash
node scripts/run-sdk-live-canaries.mjs --runinfra-env-file <path-to-env-file> --preflight --strict --report artifacts/sdk/live-canary-readiness.json
```

Do not use Node's `--env-file` option in promotion commands. `--runinfra-env-file <path-to-env-file>` keeps env-file parsing, explicit shell-env precedence, and report redaction inside the canary runner.

Verify the PyPI release:
- Go to https://pypi.org/project/runinfra/ -> Releases -> click a version ->
  see the Trusted Publisher chain.

## Issues + contributing

Open an issue or pull request against this repo. See
[`CONTRIBUTING.md`](./CONTRIBUTING.md) for the workflow + style rules.

For **security issues**, do NOT open a GitHub issue - see
[`SECURITY.md`](./SECURITY.md) for disclosure process.

For RunInfra service issues (deployments, billing, account), email
`support@runinfra.ai`.

---

See [AGENT-NOTES.md](./AGENT-NOTES.md) for the comprehensive handoff doc
for future AI agents working on these SDKs.

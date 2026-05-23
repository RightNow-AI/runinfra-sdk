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

## Modality status (v0.1.3)

| Surface | Status |
|---|---|
| Chat completions, Responses, Embeddings | Beta, contract-tested |
| Images, Audio TTS/ASR | **Experimental**, not live-canary verified |
| Voice pipeline | **Experimental**, pipeline-scoped route, not live-canary verified |
| Webhook delivery | Not shipped. Local verification helpers are available in both SDKs |

See per-package READMEs and CHANGELOG for the path to v1.0.0 GA.
The strict multimodal GA canary contract is documented in
[`LIVE-CANARIES.md`](./LIVE-CANARIES.md).

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

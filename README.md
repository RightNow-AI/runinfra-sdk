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
| Chat completions, Responses | Beta. Typed helpers for verified LLM and vision-language deployments. |
| Embeddings | Beta. Typed helper for verified embedding deployments. |
| Images, Audio TTS/ASR | Preview. Available when the selected deployment exposes the matching route. |
| Voice pipeline | Preview. Pipeline-scoped helper for co-located audio-to-response deployments. |
| Webhook delivery | Local verification helpers are available in both SDKs. Delivery management is handled outside the public SDK surface. |

See each package README and changelog for language-specific examples and exact helper names.

## Browser security

RunInfra API keys are bearer secrets. Do not put `RUNINFRA_API_KEY` in browser
code. Browser apps should call your server route or backend proxy first, then
your server calls RunInfra with the workspace or pipeline-scoped key. Direct
browser token flows are not supported by the public SDK.

## License

Proprietary, source-available. See [LICENSE](./LICENSE). For commercial
licensing inquiries, contact `licensing@runinfra.ai`.

## Package provenance

RunInfra publishes SDK packages through trusted publishing where the registry
supports it. npm releases include provenance metadata, and PyPI releases use
the configured trusted publisher chain.

You can inspect npm provenance with:
```bash
npm view @runinfra/sdk@latest dist.attestations
```
For PyPI, open the release page at https://pypi.org/project/runinfra/ and
inspect the publishing details for the selected version.

## Issues + contributing

Open an issue or pull request against this repo. See
[`CONTRIBUTING.md`](./CONTRIBUTING.md) for the workflow + style rules.

For **security issues**, do NOT open a GitHub issue - see
[`SECURITY.md`](./SECURITY.md) for disclosure process.

For RunInfra service issues (deployments, billing, account), email
`support@runinfra.ai`.

---

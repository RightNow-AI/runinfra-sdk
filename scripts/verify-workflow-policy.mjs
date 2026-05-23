#!/usr/bin/env node
import { readFileSync } from "node:fs";

const publish = readFileSync(".github/workflows/publish.yml", "utf8");
const ci = readFileSync(".github/workflows/ci.yml", "utf8");

const checks = [
  {
    label: "publish workflow uses npm environment",
    ok: /environment:\s*npm/u.test(publish),
  },
  {
    label: "publish workflow uses pypi environment",
    ok: /environment:\s*pypi/u.test(publish),
  },
  {
    label: "publish jobs request OIDC id-token permission",
    ok: /id-token:\s*write/u.test(publish),
  },
  {
    label: "npm publish keeps setup-node registry-url unset",
    ok: !/registry-url\s*:/u.test(publish),
  },
  {
    label: "npm publish requires provenance",
    ok: /npm publish\b[^\n]*--provenance/u.test(publish),
  },
  {
    label: "PyPI publish uses trusted publishing action",
    ok: /pypa\/gh-action-pypi-publish@release\/v1/u.test(publish),
  },
  {
    label: "workflows do not reference long-lived registry tokens",
    ok: !/(NODE_AUTH_TOKEN|NPM_TOKEN|PYPI_API_TOKEN|TWINE_PASSWORD)/u.test(`${publish}\n${ci}`),
  },
  {
    label: "workflows do not carry old live-canary bypass controls",
    ok: !/RUNINFRA_SDK_BYPASS_LIVE_CANARY|bypass_live_canary/u.test(`${publish}\n${ci}`),
  },
  {
    label: "CI verifies exact npm package contents",
    ok: /verify-npm-package\.mjs/u.test(ci),
  },
  {
    label: "CI verifies exact Python package contents",
    ok: /verify-python-package\.py/u.test(ci),
  },
  {
    label: "CI verifies SDK version synchronization",
    ok: /verify-version-sync\.mjs/u.test(ci),
  },
  {
    label: "publish workflow verifies SDK version synchronization",
    ok: /verify-version-sync\.mjs/u.test(publish),
  },
];

const failed = checks.filter((check) => !check.ok);
for (const check of checks) {
  console.log(`${check.ok ? "[OK]" : "[FAIL]"} ${check.label}`);
}

if (failed.length) {
  process.exit(1);
}

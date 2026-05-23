#!/usr/bin/env node
import { readFileSync } from "node:fs";

const publish = readFileSync(".github/workflows/publish.yml", "utf8");
const ci = readFileSync(".github/workflows/ci.yml", "utf8");

function jobBlock(workflow, jobName) {
  const start = workflow.indexOf(`  ${jobName}:`);
  if (start === -1) return "";
  const rest = workflow.slice(start + `  ${jobName}:`.length);
  const nextJob = rest.search(/\n  [a-zA-Z0-9_-]+:\n/u);
  return nextJob === -1 ? rest : rest.slice(0, nextJob);
}

const publishNpmJob = jobBlock(publish, "publish-npm");
const publishPypiJob = jobBlock(publish, "publish-pypi");
const workflows = `${publish}\n${ci}`;
const actionUses = Array.from(workflows.matchAll(/uses:\s+([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)@([^\s#]+)/gu));
const expectedActionRevisions = [
  "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd",
  "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
  "actions/setup-python@a309ff8b426b58ec0e2a45f0f869d46889d02405",
  "pnpm/action-setup@ac6db6d3c1f721f886538a378a2d73e85697340a",
  "pypa/gh-action-pypi-publish@cef221092ed1bacb1cc03d23a2d87d1d172e277b",
];

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
    ok: publish.includes("uses: pypa/gh-action-pypi-publish@cef221092ed1bacb1cc03d23a2d87d1d172e277b"),
  },
  {
    label: "workflows do not reference long-lived registry tokens",
    ok: !/(NODE_AUTH_TOKEN|NPM_TOKEN|PYPI_API_TOKEN|TWINE_PASSWORD)/u.test(workflows),
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
    label: "CI verifies clean package installs",
    ok:
      /verify-clean-installs\.mjs --package typescript --mode artifact/u.test(ci) &&
      /verify-clean-installs\.mjs --package python --mode artifact/u.test(ci),
  },
  {
    label: "publish workflow verifies clean package installs",
    ok:
      /verify-clean-installs\.mjs --package typescript --mode artifact/u.test(publish) &&
      /verify-clean-installs\.mjs --package python --mode artifact/u.test(publish),
  },
  {
    label: "workflows use frozen TypeScript lockfile installs",
    ok:
      /pnpm install --frozen-lockfile/u.test(ci) &&
      /pnpm install --frozen-lockfile/u.test(publish) &&
      !/lockfile=false/u.test(workflows),
  },
  {
    label: "workflows use pinned Python build tooling",
    ok:
      /pip install -r python\/requirements-dev\.txt/u.test(ci) &&
      /pip install -r python\/requirements-dev\.txt/u.test(publish) &&
      !/pip install --upgrade build pytest twine/u.test(workflows),
  },
  {
    label: "CI verifies SDK version synchronization",
    ok: /verify-version-sync\.mjs/u.test(ci),
  },
  {
    label: "publish workflow verifies SDK version synchronization",
    ok: /verify-version-sync\.mjs/u.test(publish),
  },
  {
    label: "publish workflow defaults to dry-run",
    ok: /dry_run:[\s\S]*?default:\s*true/u.test(publish),
  },
  {
    label: "real publish requires version confirmation",
    ok:
      /confirm_version:/u.test(publish) &&
      /verify-publish-dispatch\.mjs/u.test(publish),
  },
  {
    label: "publish jobs are branch-locked to main",
    ok:
      /github\.ref\s*==\s*'refs\/heads\/main'/u.test(publishNpmJob) &&
      /github\.ref\s*==\s*'refs\/heads\/main'/u.test(publishPypiJob),
  },
  {
    label: "workflow actions are SHA pinned",
    ok:
      actionUses.length > 0 &&
      actionUses.every(([, , ref]) => /^[a-f0-9]{40}$/u.test(ref)),
  },
  {
    label: "workflows pin expected Node 24 compatible action revisions",
    ok: expectedActionRevisions.every((action) => workflows.includes(`uses: ${action}`)),
  },
];

const failed = checks.filter((check) => !check.ok);
for (const check of checks) {
  console.log(`${check.ok ? "[OK]" : "[FAIL]"} ${check.label}`);
}

if (failed.length) {
  process.exit(1);
}

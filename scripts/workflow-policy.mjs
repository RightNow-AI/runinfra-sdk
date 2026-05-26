const expectedActionRevisions = [
  "actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd",
  "actions/setup-node@48b55a011bda9f5d6aeb4c2d9c7362e8dae4041e",
  "actions/setup-python@a309ff8b426b58ec0e2a45f0f869d46889d02405",
  "pnpm/action-setup@ac6db6d3c1f721f886538a378a2d73e85697340a",
  "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
  "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
  "pypa/gh-action-pypi-publish@cef221092ed1bacb1cc03d23a2d87d1d172e277b",
];

function jobBlock(workflow, jobName) {
  const start = workflow.indexOf(`  ${jobName}:`);
  if (start === -1) return "";
  const rest = workflow.slice(start + `  ${jobName}:`.length);
  const nextJob = rest.search(/\r?\n  [a-zA-Z0-9_-]+:\r?\n/u);
  return nextJob === -1 ? rest : rest.slice(0, nextJob);
}

function jobHasEnvironment(job, environment) {
  return new RegExp(`(^|\\r?\\n)    environment:\\s*${environment}\\s*(?:\\r?\\n|$)`, "u").test(job);
}

function jobHasOidcPermission(job) {
  return /(^|\r?\n)    permissions:\r?\n(?:      [a-zA-Z0-9_-]+:\s*\S+\r?\n)*?      id-token:\s*write\s*(?:\r?\n|$)/u.test(job);
}

function jobPermissions(job) {
  const match = job.match(/(^|\r?\n)    permissions:\r?\n((?:      [a-zA-Z0-9_-]+:\s*\S+\r?\n)+)/u);
  if (!match) return new Map();
  return new Map(
    Array.from(match[2].matchAll(/^      ([a-zA-Z0-9_-]+):\s*(\S+)\s*$/gmu))
      .map(([, key, value]) => [key, value]),
  );
}

function jobHasReadOnlyContentsPermission(job, allowedExtraReadPermissions = []) {
  const permissions = jobPermissions(job);
  if (permissions.get("contents") !== "read") return false;
  const allowed = new Set(["contents", ...allowedExtraReadPermissions]);
  return Array.from(permissions.entries()).every(([permission, access]) =>
    allowed.has(permission) && access === "read",
  );
}

function jobNeeds(job, jobName) {
  return new RegExp(`needs:\\s*(?:\\[[^\\]]*\\b${jobName}\\b[^\\]]*\\]|${jobName})`, "u").test(job);
}

function jobHasCommandBetween(job, command, afterMarker, beforeMarkers) {
  const commandIndex = job.indexOf(command);
  const afterIndex = job.indexOf(afterMarker);
  if (commandIndex === -1 || afterIndex === -1 || commandIndex <= afterIndex) return false;

  return beforeMarkers.every((marker) => {
    const markerIndex = job.indexOf(marker);
    return markerIndex === -1 || commandIndex < markerIndex;
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
}

function jobHasMatrixVersions(job, key, expectedVersions) {
  const valuePattern = expectedVersions
    .map((version) => `"?${escapeRegExp(version)}"?`)
    .join("\\s*,\\s*");
  const matrixPattern = new RegExp(`${escapeRegExp(key)}:\\s*\\[\\s*${valuePattern}\\s*\\]`, "u");
  const setupPattern = new RegExp(`${escapeRegExp(key)}:\\s*\\$\\{\\{\\s*matrix\\.${escapeRegExp(key)}\\s*\\}\\}`, "u");
  return matrixPattern.test(job) && setupPattern.test(job);
}

function stepBlockForCommand(job, command) {
  const commandIndex = job.indexOf(command);
  if (commandIndex === -1) return "";
  const stepStart = job.lastIndexOf("\n      - ", commandIndex);
  const nextStep = job.indexOf("\n      - ", commandIndex);
  const start = stepStart === -1 ? 0 : stepStart;
  const end = nextStep === -1 ? job.length : nextStep;
  return job.slice(start, end);
}

function stepCommandHasGithubToken(job, command) {
  const step = stepBlockForCommand(job, command);
  return /(^|\r?\n)        env:\r?\n(?:          [A-Z0-9_]+:\s*.*\r?\n)*?          GITHUB_TOKEN:\s*\$\{\{\s*github\.token\s*\}\}\s*(?:\r?\n|$)/u.test(step);
}

function actionUses(workflows) {
  const usesValues = Array.from(
    workflows.matchAll(/^\s*-?\s*uses:\s*(?:"([^"]+)"|'([^']+)'|([^\s#]+))/gmu),
  ).map(([, doubleQuoted, singleQuoted, unquoted]) => doubleQuoted ?? singleQuoted ?? unquoted);
  return usesValues
    .filter((value) =>
      !value.startsWith("./") &&
      !value.startsWith("../") &&
      !value.startsWith("docker://")
    )
    .map((value) => {
      const atIndex = value.lastIndexOf("@");
      return {
        value,
        action: atIndex === -1 ? value : value.slice(0, atIndex),
        ref: atIndex === -1 ? "" : value.slice(atIndex + 1),
      };
    });
}

export function evaluateWorkflowPolicy({ publish, ci, hasCustomCodeqlWorkflow }) {
  const ciTypeScriptJob = jobBlock(ci, "typescript");
  const ciPythonJob = jobBlock(ci, "python");
  const buildArtifactsJob = jobBlock(publish, "build-artifacts");
  const promotionGateJob = jobBlock(publish, "promotion-gate");
  const publishNpmJob = jobBlock(publish, "publish-npm");
  const publishPypiJob = jobBlock(publish, "publish-pypi");
  const workflows = `${publish}\n${ci}`;
  const actions = actionUses(workflows);
  const promotionReportCommand =
    "node scripts/verify-promotion-reports.mjs --readiness artifacts/sdk/live-canary-readiness.json --live artifacts/sdk/live-canary.json --artifacts-root .";
  const strictReadinessCommand =
    "node scripts/run-sdk-live-canaries.mjs --preflight --strict --report artifacts/sdk/live-canary-readiness.json";
  const strictArtifactCommand =
    "node scripts/run-sdk-live-canaries.mjs --package-source artifact --strict --report artifacts/sdk/live-canary.json";
  const pythonArtifactCleanInstallWithSdist =
    /verify-clean-installs\.mjs[\s\S]*?--package (?:both|python)[\s\S]*?--mode artifact[\s\S]*?--python-wheel artifacts\/python-local\/runinfra-\*-py3-none-any\.whl[\s\S]*?--python-sdist artifacts\/python-local\/runinfra-\*\.tar\.gz/u;
  const promotedArtifactLayoutCommand = "node scripts/verify-promoted-artifacts.mjs artifacts";
  const downloadPromotedArtifactsAction = "uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093";
  const githubSecurityStatusCommand = "node scripts/verify-github-security-status.mjs --repo RightNow-AI/runinfra-sdk";

  return [
    {
      label: "publish workflow uses npm environment",
      ok: jobHasEnvironment(publishNpmJob, "npm"),
    },
    {
      label: "publish workflow uses pypi environment",
      ok: jobHasEnvironment(publishPypiJob, "pypi"),
    },
    {
      label: "publish jobs request OIDC id-token permission",
      ok: jobHasOidcPermission(publishNpmJob) && jobHasOidcPermission(publishPypiJob),
    },
    {
      label: "repository relies on GitHub default CodeQL setup",
      ok: !hasCustomCodeqlWorkflow,
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
      ok: !/RUNINFRA_SDK_BYPASS_LIVE_CANARY|bypass_live_canary/u.test(workflows),
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
      label: "Python artifact clean installs exercise wheel and sdist",
      ok:
        pythonArtifactCleanInstallWithSdist.test(buildArtifactsJob) &&
        pythonArtifactCleanInstallWithSdist.test(publishPypiJob),
    },
    {
      label: "publish workflow verifies published registry installs",
      ok:
        /Verify published npm install\/import[\s\S]*?github\.event\.inputs\.dry_run != 'true'[\s\S]*?verify-clean-installs\.mjs --package typescript --mode registry/u.test(publishNpmJob) &&
        /Verify published PyPI install\/import[\s\S]*?github\.event\.inputs\.dry_run != 'true'[\s\S]*?verify-clean-installs\.mjs --package python --mode registry/u.test(publishPypiJob),
    },
    {
      label: "publish workflow gates real publishes on strict promotion reports",
      ok:
        jobNeeds(publishNpmJob, "promotion-gate") &&
        jobNeeds(publishPypiJob, "promotion-gate") &&
        promotionGateJob.includes("github.event.inputs.dry_run != 'true'") &&
        promotionGateJob.includes(strictReadinessCommand) &&
        promotionGateJob.includes(strictArtifactCommand) &&
        promotionGateJob.includes(promotionReportCommand),
    },
    {
      label: "promotion gate stages every promoted artifact for strict canaries",
      ok:
        jobHasCommandBetween(promotionGateJob, "cp artifacts/npm-local/runinfra-sdk-*.tgz typescript/", "Prepare exact artifacts and canary fixtures", [
          strictArtifactCommand,
        ]) &&
        jobHasCommandBetween(promotionGateJob, "cp artifacts/python-local/runinfra-*-py3-none-any.whl python/dist/", "Prepare exact artifacts and canary fixtures", [
          strictArtifactCommand,
        ]) &&
        jobHasCommandBetween(promotionGateJob, "cp artifacts/python-local/runinfra-*.tar.gz python/dist/", "Prepare exact artifacts and canary fixtures", [
          strictArtifactCommand,
        ]),
    },
    {
      label: "promotion gate verifies GitHub code scanning has no open high/critical alerts",
      ok:
        jobPermissions(promotionGateJob).get("security-events") === "read" &&
        jobHasReadOnlyContentsPermission(promotionGateJob, ["security-events"]) &&
        stepCommandHasGithubToken(promotionGateJob, githubSecurityStatusCommand) &&
        jobHasCommandBetween(promotionGateJob, githubSecurityStatusCommand, downloadPromotedArtifactsAction, [
          strictReadinessCommand,
          strictArtifactCommand,
          promotionReportCommand,
        ]),
    },
    {
      label: "publish jobs use the exact promoted package artifacts",
      ok:
        jobNeeds(publishNpmJob, "build-artifacts") &&
        jobNeeds(publishPypiJob, "build-artifacts") &&
        buildArtifactsJob.includes("uses: actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02") &&
        buildArtifactsJob.includes("name: runinfra-sdk-promoted-artifacts") &&
        buildArtifactsJob.includes("artifacts/npm-local/runinfra-sdk-*.tgz") &&
        buildArtifactsJob.includes("artifacts/python-local/runinfra-*.whl") &&
        buildArtifactsJob.includes("artifacts/python-local/runinfra-*.tar.gz") &&
        promotionGateJob.includes("uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093") &&
        promotionGateJob.includes("name: runinfra-sdk-promoted-artifacts") &&
        publishNpmJob.includes("uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093") &&
        publishNpmJob.includes("name: runinfra-sdk-promoted-artifacts") &&
        publishNpmJob.includes("npm publish artifacts/npm-local/runinfra-sdk-*.tgz --access public --provenance") &&
        !/pnpm pack/u.test(publishNpmJob) &&
        publishPypiJob.includes("uses: actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093") &&
        publishPypiJob.includes("name: runinfra-sdk-promoted-artifacts") &&
        publishPypiJob.includes("packages-dir: artifacts/python-local") &&
        !/python -m build/u.test(publishPypiJob),
    },
    {
      label: "non-publishing promotion jobs use read-only contents permission",
      ok:
        jobHasReadOnlyContentsPermission(buildArtifactsJob) &&
        jobHasReadOnlyContentsPermission(promotionGateJob, ["security-events"]),
    },
    {
      label: "publish workflow verifies downloaded promoted artifact layout",
      ok:
        jobHasCommandBetween(promotionGateJob, promotedArtifactLayoutCommand, downloadPromotedArtifactsAction, [
          "Prepare exact artifacts and canary fixtures",
          strictArtifactCommand,
        ]) &&
        jobHasCommandBetween(publishNpmJob, promotedArtifactLayoutCommand, downloadPromotedArtifactsAction, [
          "Verify exact npm artifact contents (no leaks)",
          "npm publish artifacts/npm-local/runinfra-sdk-*.tgz --access public --provenance",
        ]) &&
        jobHasCommandBetween(publishPypiJob, promotedArtifactLayoutCommand, downloadPromotedArtifactsAction, [
          "Verify exact Python artifacts (no leaks)",
          "packages-dir: artifacts/python-local",
        ]),
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
      label: "CI tests every supported Node major",
      ok: jobHasMatrixVersions(ciTypeScriptJob, "node-version", ["18", "20", "22", "24"]),
    },
    {
      label: "CI tests every supported Python minor",
      ok: jobHasMatrixVersions(ciPythonJob, "python-version", ["3.9", "3.10", "3.11", "3.12", "3.13", "3.14"]),
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
        actions.length > 0 &&
        actions.every(({ ref }) => /^[a-f0-9]{40}$/u.test(ref)),
    },
    {
      label: "workflows pin expected Node 24 compatible action revisions",
      ok: expectedActionRevisions.every((action) => workflows.includes(`uses: ${action}`)),
    },
  ];
}

const npmPackageName = "@runinfra/sdk";
const pypiPackageName = "runinfra";
const npmVersionBaseUrl = "https://registry.npmjs.org/%40runinfra%2Fsdk";
const pypiVersionBaseUrl = "https://pypi.org/pypi/runinfra";

export function registryVersionChecks(version, packageSelection) {
  const checks = [];
  if (packageSelection === "both" || packageSelection === "typescript") {
    checks.push({
      label: "npm",
      packageName: npmPackageName,
      version,
      url: `${npmVersionBaseUrl}/${encodeURIComponent(version)}`,
    });
  }
  if (packageSelection === "both" || packageSelection === "python") {
    checks.push({
      label: "PyPI",
      packageName: pypiPackageName,
      version,
      url: `${pypiVersionBaseUrl}/${encodeURIComponent(version)}/json`,
    });
  }
  return checks;
}

export async function registryAvailabilityErrors(checks, packageExists = defaultRegistryPackageExists) {
  const errors = [];
  for (const check of checks) {
    let exists = false;
    try {
      exists = await packageExists(check.url);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push(`${check.label} package ${packageSpec(check)} availability check failed: ${message}`);
      continue;
    }
    if (!exists) {
      errors.push(`${check.label} package ${packageSpec(check)} is not available from the canonical registry.`);
    }
  }
  return errors;
}

async function defaultRegistryPackageExists(url) {
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (response.status === 404) return false;
  if (response.ok) return true;
  throw new Error(`HTTP ${response.status}`);
}

function packageSpec(check) {
  return check.label === "PyPI"
    ? `${check.packageName}==${check.version}`
    : `${check.packageName}@${check.version}`;
}

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

// npm lists a just-published version a few minutes after `npm publish` returns
// (0.3.2: published 19:44:51Z, listed 19:47:28Z), so a check right after a
// publish waits for the listing instead of failing a release that went out.
export async function waitForRegistryAvailability(checks, {
  attempts,
  delayMs,
  packageExists = defaultRegistryPackageExists,
  sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, ms)),
  log = (message) => console.log(message),
}) {
  let pending = checks;
  let errors = [];
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const results = await Promise.all(pending.map(async (check) => ({
      check,
      errors: await registryAvailabilityErrors([check], packageExists),
    })));
    pending = results.filter((result) => result.errors.length).map((result) => result.check);
    errors = results.flatMap((result) => result.errors);
    if (!errors.length) return [];
    if (attempt < attempts) {
      log(`Registry version preflight attempt ${attempt}/${attempts} is waiting on ${pending.map(packageSpec).join(", ")}; checking again in ${delayMs}ms.`);
      await sleep(delayMs);
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

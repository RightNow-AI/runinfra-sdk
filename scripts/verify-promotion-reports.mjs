#!/usr/bin/env node
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { productionBaseURL } from "./canary-report-base-url.mjs";
import { expectedRows as canonicalExpectedRows } from "./live-canary-matrix.mjs";
import { sourceDigestFileLabels as canonicalSourceDigestFileLabels } from "./live-canary-source-files.mjs";
import { publicSurfaceCoverage as canonicalPublicSurfaceCoverage } from "./live-canary-surface-coverage.mjs";
import { findForbiddenContent } from "./secret-scan-policy.mjs";

const readinessPath = optionValue("--readiness") ?? "artifacts/sdk/live-canary-readiness.json";
const livePath = optionValue("--live") ?? "artifacts/sdk/live-canary.json";
const artifactsRoot = optionValue("--artifacts-root");
const hasArtifactsRoot = typeof artifactsRoot === "string" && artifactsRoot.trim() !== "" && !artifactsRoot.startsWith("--");
const expectedSdkVersion = readExpectedSdkVersion();
const canonicalSurfaceCoverageSurfaces = canonicalPublicSurfaceCoverage.map((entry) => entry.surface);
const canonicalSourceFileCount = canonicalSourceDigestFileLabels.length;
const canonicalSourceDigestSha256 = currentSourceDigestSha256();
const errors = [];

const readiness = readReport(readinessPath, "readiness report");
const live = readReport(livePath, "live canary report");

if (!hasArtifactsRoot) errors.push("artifacts-root is required to verify staged package artifacts");
errors.push(...forbiddenReportErrors("readiness report", readiness));
errors.push(...forbiddenReportErrors("live canary report", live));
errors.push(...baseReportErrors("readiness report", readiness));
errors.push(...baseReportErrors("live canary report", live));
errors.push(...candidateErrors("readiness report", readiness, { artifactDigests: "not_checked" }));
errors.push(...candidateErrors("live canary report", live, { artifactDigests: "required" }));
errors.push(...sameCandidateErrors(readiness, live));
errors.push(...expectedRowsErrors(readiness, live));
errors.push(...readinessErrors(readiness));
errors.push(...liveCanaryErrors(live));

if (errors.length) {
  console.error("Promotion report verification failed:");
  for (const error of [...new Set(errors)]) console.error(`- ${error}`);
  process.exit(1);
}

console.log(`Verified promotion reports for SDK ${expectedSdkVersion}`);

function optionValue(name) {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function readExpectedSdkVersion() {
  const packageJson = JSON.parse(readFileSync(new URL("../typescript/package.json", import.meta.url), "utf8"));
  if (typeof packageJson.version !== "string" || !packageJson.version.trim()) {
    throw new Error("typescript/package.json is missing a package version.");
  }
  return packageJson.version;
}

function currentSourceDigestSha256() {
  const digest = createHash("sha256");
  for (const label of canonicalSourceDigestFileLabels) {
    digest.update(label);
    digest.update("\0");
    digest.update(readFileSync(new URL(`../${label}`, import.meta.url)));
    digest.update("\0");
  }
  return digest.digest("hex");
}

function readReport(path, label) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    errors.push(`${label} could not be read or parsed: ${message}`);
    return {};
  }
}

function forbiddenReportErrors(label, report) {
  const serialized = JSON.stringify(report);
  const matchedPattern = findForbiddenContent(serialized);
  const reportErrors = matchedPattern ? [`${label} contains forbidden content: ${matchedPattern.label}`] : [];
  const matchedAbsolutePath = findAbsolutePrivatePath(serialized);
  if (matchedAbsolutePath) {
    reportErrors.push(`${label} contains absolute private path: ${matchedAbsolutePath.label}`);
  }
  const leakedEnvValue = sensitiveEnvValues().find((value) => serialized.includes(value));
  if (leakedEnvValue) reportErrors.push(`${label} contains a sensitive environment value`);
  return reportErrors;
}

function findAbsolutePrivatePath(content) {
  const patterns = [
    {
      label: "Windows absolute path",
      regex: /\b[A-Z]:[\\/]+[^\s"'<>]+(?:[\\/]+[^\s"'<>]+)*/iu,
    },
    {
      label: "file URL",
      regex: /file:\/\/\/?(?:[A-Z]:)?[A-Za-z0-9._~:/?#\[\]@!$&()*+,;=%-]+/iu,
    },
    {
      label: "UNC absolute path",
      regex: /(?:^|[\s"'(:=])\\{2,}[^\\\s"'<>]+\\+[^\\\s"'<>]+(?:\\+[^\\\s"'<>]+)*/iu,
    },
    {
      label: "UNC absolute path",
      regex: /(?:^|[\s"'(=])\/\/[^/\s"'<>]+\/[^/\s"'<>]+(?:\/[^/\s"'<>]+)*/iu,
    },
    {
      label: "Unix absolute private path",
      regex: /(?:^|[\s"'(:=])\/(?!v\d+\/)(?:[^/\s"'<>]+\/){1,}private\/[^\s"'<>]+(?:\/[^\s"'<>]+)*/u,
    },
    {
      label: "Unix absolute private path",
      regex: /(?:^|[\s"'(:=])\/(?:root|home|Users|private|tmp|var|opt|srv|mnt|etc|workspace|workspaces|app|code|runner|github|builds)\/[^\s"'<>]+(?:\/[^\s"'<>]+)*/u,
    },
  ];
  return patterns.find(({ regex }) => regex.test(content));
}

function sensitiveEnvValues() {
  return Object.entries(process.env)
    .filter(([name, value]) =>
      typeof value === "string" &&
      value.length >= 8 &&
      /(API[_-]?KEY|TOKEN|SECRET|PASSWORD|NPM|PYPI|TWINE)/iu.test(name)
    )
    .map(([, value]) => value);
}

function baseReportErrors(label, report) {
  const reportErrors = [];
  const surfaceCoverage = report?.surfaceCoverage;
  if (report?.schemaVersion !== 1) reportErrors.push(`${label} schemaVersion must be 1`);
  if (report?.strict !== true) reportErrors.push(`${label} must be strict`);
  if (report?.packageSource !== "artifact") reportErrors.push(`${label} packageSource must be artifact`);
  if (surfaceCoverage?.status !== "passed") reportErrors.push(`${label} surface coverage must pass`);
  if (!Array.isArray(surfaceCoverage?.errors) || surfaceCoverage.errors.length !== 0) {
    reportErrors.push(`${label} surface coverage errors must be empty`);
  }
  if (!Array.isArray(surfaceCoverage?.uncoveredSurfaces) || surfaceCoverage.uncoveredSurfaces.length !== 0) {
    reportErrors.push(`${label} uncovered surfaces must be empty`);
  }
  if (!Array.isArray(surfaceCoverage?.uncoveredRows) || surfaceCoverage.uncoveredRows.length !== 0) {
    reportErrors.push(`${label} uncovered rows must be empty`);
  }
  const surfaces = arrayOrEmpty(surfaceCoverage?.surfaces);
  reportErrors.push(...rowNameErrors(`${label} surface coverage surface`, surfaces));
  if (!sameStringArray(surfaces, canonicalSurfaceCoverageSurfaces)) {
    reportErrors.push(`${label} surface coverage surfaces must match the canonical public surface coverage manifest`);
  }
  if (surfaceCoverage?.surfaceCount !== canonicalSurfaceCoverageSurfaces.length) {
    reportErrors.push(`${label} surface coverage surfaceCount must be ${canonicalSurfaceCoverageSurfaces.length}`);
  }
  if (surfaceCoverage?.rowCount !== canonicalExpectedRows.length) {
    reportErrors.push(`${label} surface coverage rowCount must be ${canonicalExpectedRows.length}`);
  }
  return reportErrors;
}

function candidateErrors(label, report, options) {
  const reportErrors = [];
  const candidate = report?.candidate;
  if (!candidate || typeof candidate !== "object") return [`${label} candidate is missing`];
  if (candidate.sdkVersion !== expectedSdkVersion) {
    reportErrors.push(`${label} candidate sdkVersion must be ${expectedSdkVersion}`);
  }
  if (candidate.packageSource !== "artifact") {
    reportErrors.push(`${label} candidate packageSource must be artifact`);
  }
  if (!isSha256(candidate.sourceDigestSha256)) {
    reportErrors.push(`${label} candidate sourceDigestSha256 must be a SHA-256 hex digest`);
  } else if (candidate.sourceDigestSha256 !== canonicalSourceDigestSha256) {
    reportErrors.push(`${label} candidate source digest must match the current canonical promotion source digest`);
  }
  if (!Number.isInteger(candidate.sourceFileCount) || candidate.sourceFileCount <= 0) {
    reportErrors.push(`${label} candidate sourceFileCount must be a positive integer`);
  } else if (candidate.sourceFileCount !== canonicalSourceFileCount) {
    reportErrors.push(`${label} candidate sourceFileCount must match the canonical live canary source file count (${canonicalSourceFileCount})`);
  }
  if (options.artifactDigests === "required") {
    reportErrors.push(...artifactCandidateErrors(label, candidate));
  } else {
    if (candidate.artifactDigestsChecked !== false) {
      reportErrors.push(`${label} preflight must not check artifact digests`);
    }
    if (!Array.isArray(candidate.artifacts) || candidate.artifacts.length !== 0) {
      reportErrors.push(`${label} preflight candidate artifacts must be empty`);
    }
  }
  return reportErrors;
}

function artifactCandidateErrors(label, candidate) {
  const reportErrors = [];
  const expectedArtifactFileNames = new Map([
    ["npm", `runinfra-sdk-${expectedSdkVersion}.tgz`],
    ["pythonWheel", `runinfra-${expectedSdkVersion}-py3-none-any.whl`],
    ["pythonSdist", `runinfra-${expectedSdkVersion}.tar.gz`],
  ]);
  const expectedArtifactPaths = new Map([
    ["npm", ["typescript", `runinfra-sdk-${expectedSdkVersion}.tgz`]],
    ["pythonWheel", ["python", "dist", `runinfra-${expectedSdkVersion}-py3-none-any.whl`]],
    ["pythonSdist", ["python", "dist", `runinfra-${expectedSdkVersion}.tar.gz`]],
  ]);
  if (candidate.artifactDigestsChecked !== true) {
    reportErrors.push(`${label} artifactDigestsChecked must be true`);
  }
  if (!Array.isArray(candidate.artifacts)) {
    reportErrors.push(`${label} candidate must contain npm, Python wheel, and Python sdist artifacts`);
    return reportErrors;
  }
  if (candidate.artifacts.length !== 3) {
    reportErrors.push(`${label} candidate artifacts must be npm, pythonWheel, and pythonSdist`);
  }
  const artifactNames = candidate.artifacts.map((artifact) => artifact?.name).sort();
  if (artifactNames.join(",") !== "npm,pythonSdist,pythonWheel") {
    reportErrors.push(`${label} candidate artifacts must be npm, pythonWheel, and pythonSdist`);
  }
  for (const artifact of candidate.artifacts) {
    if (typeof artifact?.fileName !== "string" || !artifact.fileName.trim()) {
      reportErrors.push(`${label} candidate artifact fileName is missing`);
      continue;
    }
    if (/[\\/]/u.test(artifact.fileName)) {
      reportErrors.push(`${label} candidate artifact fileName must not contain path separators`);
    }
    const expectedFileName = expectedArtifactFileNames.get(artifact?.name);
    if (expectedFileName && artifact.fileName !== expectedFileName) {
      reportErrors.push(`${label} candidate artifact ${artifact.name} fileName must be ${expectedFileName}`);
    }
    if (!isSha256(artifact?.sha256)) {
      reportErrors.push(`${label} candidate artifact ${artifact.fileName} sha256 must be a SHA-256 hex digest`);
    } else if (hasArtifactsRoot) {
      const expectedPath = expectedArtifactPaths.get(artifact?.name);
      if (expectedPath) {
        const stagedSha256 = stagedArtifactSha256(expectedPath);
        if (!stagedSha256) {
          reportErrors.push(`${label} candidate artifact ${artifact.name} staged file is missing or unreadable`);
        } else if (artifact.sha256 !== stagedSha256) {
          reportErrors.push(`${label} candidate artifact ${artifact.name} sha256 must match staged artifact file`);
        }
      }
    }
  }
  return reportErrors;
}

function stagedArtifactSha256(pathSegments) {
  try {
    return createHash("sha256")
      .update(readFileSync(resolve(artifactsRoot, ...pathSegments)))
      .digest("hex");
  } catch {
    return null;
  }
}

function sameCandidateErrors(readinessReport, liveReport) {
  const readinessCandidate = readinessReport?.candidate;
  const liveCandidate = liveReport?.candidate;
  if (!readinessCandidate || !liveCandidate) return [];
  const reportErrors = [];
  if (readinessCandidate.sourceDigestSha256 !== liveCandidate.sourceDigestSha256) {
    reportErrors.push("candidate source digest mismatch between readiness and live canary reports");
  }
  if (readinessCandidate.sourceFileCount !== liveCandidate.sourceFileCount) {
    reportErrors.push("candidate source file count mismatch between readiness and live canary reports");
  }
  if (readinessCandidate.sdkVersion !== liveCandidate.sdkVersion) {
    reportErrors.push("candidate SDK version mismatch between readiness and live canary reports");
  }
  return reportErrors;
}

function expectedRowsErrors(readinessReport, liveReport) {
  const readinessRows = arrayOrEmpty(readinessReport?.expectedRows);
  const liveRows = arrayOrEmpty(liveReport?.expectedRows);
  const reportErrors = [];
  reportErrors.push(...rowNameErrors("canonical live canary matrix", canonicalExpectedRows));
  reportErrors.push(...rowNameErrors("readiness report expectedRows", readinessRows));
  reportErrors.push(...rowNameErrors("live canary report expectedRows", liveRows));
  if (!readinessRows.length) reportErrors.push("readiness report expectedRows must be non-empty");
  if (!liveRows.length) reportErrors.push("live canary report expectedRows must be non-empty");
  if (!sameStringArray(readinessRows, liveRows)) {
    reportErrors.push("expectedRows mismatch between readiness and live canary reports");
  }
  if (new Set(readinessRows).size !== readinessRows.length) reportErrors.push("readiness report expectedRows must not contain duplicates");
  if (new Set(liveRows).size !== liveRows.length) reportErrors.push("live canary expectedRows must not contain duplicates");
  if (new Set(canonicalExpectedRows).size !== canonicalExpectedRows.length) {
    reportErrors.push("canonical live canary matrix must not contain duplicates");
  }
  if (!sameStringArray(readinessRows, canonicalExpectedRows) || !sameStringArray(liveRows, canonicalExpectedRows)) {
    reportErrors.push("expectedRows must match the canonical live canary matrix");
  }
  return reportErrors;
}

function readinessErrors(report) {
  const reportErrors = [];
  const expectedRows = arrayOrEmpty(report?.expectedRows);
  if (report?.readiness?.status !== "ready") reportErrors.push("readiness report status must be ready");
  if (!Array.isArray(report?.readiness?.missing) || report.readiness.missing.length !== 0) {
    reportErrors.push("readiness report missing list must be empty");
  }
  if (!Array.isArray(report?.readiness?.rowCoverageErrors) || report.readiness.rowCoverageErrors.length !== 0) {
    reportErrors.push("readiness report row coverage errors must be empty");
  }
  const rows = arrayOrEmpty(report?.readiness?.rows);
  const rowNames = rows.map((row) => row?.name);
  reportErrors.push(...rowNameErrors("readiness row", rowNames));
  if (!sameStringArray(rowNames, expectedRows)) {
    reportErrors.push("readiness rows must exactly match expectedRows");
  }
  const counts = { ready: 0, blocked: 0 };
  for (const row of rows) {
    if (row?.status === "ready" || row?.status === "blocked") {
      counts[row.status] += 1;
    }
    if (row?.status !== "ready") reportErrors.push(`readiness row ${String(row?.name ?? "<unknown>")} must be ready`);
    if (!Array.isArray(row?.missing) || row.missing.length !== 0) {
      reportErrors.push(`readiness row ${String(row?.name ?? "<unknown>")} missing list must be empty`);
    }
  }
  if (!report?.readiness?.summary || typeof report.readiness.summary !== "object") {
    reportErrors.push("readiness summary must be present");
  } else {
    if (report.readiness.summary.ready !== counts.ready) {
      reportErrors.push("readiness summary ready count must match ready rows");
    }
    if (report.readiness.summary.blocked !== counts.blocked) {
      reportErrors.push("readiness summary blocked count must match blocked rows");
    }
    if (report.readiness.summary.ready !== expectedRows.length) {
      reportErrors.push(`readiness summary ready count must be ${expectedRows.length}`);
    }
    if (report.readiness.summary.blocked !== 0) {
      reportErrors.push("readiness summary blocked count must be 0");
    }
  }
  if (!Array.isArray(report?.reports) || report.reports.length !== 0) {
    reportErrors.push("preflight readiness report must not contain child reports");
  }
  return reportErrors;
}

function liveCanaryErrors(report) {
  const reportErrors = [];
  const expectedRows = arrayOrEmpty(report?.expectedRows);
  if (report?.parity?.status !== "passed") reportErrors.push("live canary parity must pass");
  if (!Array.isArray(report?.parity?.errors) || report.parity.errors.length !== 0) {
    reportErrors.push("live canary parity errors must be empty");
  }
  const reports = arrayOrEmpty(report?.reports);
  const languages = reports.map((child) => child?.language).sort();
  if (languages.join(",") !== "python,typescript") {
    reportErrors.push("live canary report must contain exactly TypeScript and Python child reports");
  }
  for (const child of reports) {
    const language = String(child?.language ?? "<unknown>");
    if (child?.sdkVersion !== expectedSdkVersion) {
      reportErrors.push(`${language} child report sdkVersion must be ${expectedSdkVersion}`);
    }
    if (child?.strict !== true) {
      reportErrors.push(`${language} child report must be strict`);
    }
    if (child?.baseURL !== productionBaseURL) {
      reportErrors.push(`${language} child report baseURL must be ${productionBaseURL}`);
    }
    const results = arrayOrEmpty(child?.results);
    const names = results.map((row) => row?.name);
    reportErrors.push(...rowNameErrors(`${language} child report row`, names));
    if (!sameStringArray(names, expectedRows)) {
      reportErrors.push(`${language} child report rows must exactly match expectedRows`);
    }
    for (const result of results) {
      if (result?.status !== "passed") {
        reportErrors.push(`${language} row ${String(result?.name ?? "<unknown>")} must be passed`);
      }
    }
    if (!child?.summary || typeof child.summary !== "object") {
      reportErrors.push(`${language} summary must be present`);
    } else {
      if (child.summary.passed !== expectedRows.length) {
        reportErrors.push(`${language} summary passed count must be ${expectedRows.length}`);
      }
      if (child.summary.failed !== 0) reportErrors.push(`${language} summary failed count must be 0`);
      if (child.summary.skipped !== 0) reportErrors.push(`${language} summary skipped count must be 0`);
    }
  }
  return reportErrors;
}

function arrayOrEmpty(value) {
  return Array.isArray(value) ? value : [];
}

function sameStringArray(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function rowNameErrors(label, rows) {
  const reportErrors = [];
  rows.forEach((row, index) => {
    if (typeof row !== "string" || !row.trim()) {
      reportErrors.push(`${label} ${index} row name must be a non-empty string`);
    } else if (/[\u0000-\u001f\u007f]/u.test(row)) {
      reportErrors.push(`${label} ${index} row name must not contain control characters`);
    }
  });
  return reportErrors;
}

function isSha256(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

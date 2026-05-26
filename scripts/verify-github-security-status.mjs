#!/usr/bin/env node
import { pathToFileURL } from "node:url";

const defaultRepository = "RightNow-AI/runinfra-sdk";
const githubApiBaseURL = "https://api.github.com";

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index === -1) return undefined;
  return process.argv[index + 1];
}

function repositoryFromEnvironment() {
  return process.env.GITHUB_REPOSITORY?.trim() || defaultRepository;
}

function githubTokenFromEnvironment() {
  return process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || "";
}

function codeScanningSeverity(alert) {
  if (!alert || typeof alert !== "object" || Array.isArray(alert)) return "";
  const rule = alert.rule;
  if (!rule || typeof rule !== "object" || Array.isArray(rule)) return "";
  const securitySeverity = rule.security_severity_level;
  return typeof securitySeverity === "string" ? securitySeverity.toLowerCase() : "";
}

function isOpenAlert(alert) {
  return Boolean(alert && typeof alert === "object" && !Array.isArray(alert) && alert.state === "open");
}

export function highOrCriticalCodeScanningAlerts(alerts) {
  return alerts.filter((alert) =>
    isOpenAlert(alert) && ["high", "critical"].includes(codeScanningSeverity(alert)),
  );
}

function alertReference(alert) {
  const number = Number.isInteger(alert?.number) ? `#${alert.number}` : "<unknown>";
  return alert?.html_url && typeof alert.html_url === "string" ? `${number}: ${alert.html_url}` : number;
}

export async function githubSecurityStatusErrors({ repository, fetchCodeScanningAlerts }) {
  const alerts = await fetchCodeScanningAlerts();
  const blockingAlerts = highOrCriticalCodeScanningAlerts(alerts);
  if (blockingAlerts.length === 0) return [];

  return [
    `GitHub code scanning has ${blockingAlerts.length} open high/critical alerts for ${repository}.`,
    ...blockingAlerts.map((alert) => `Open high/critical alert ${alertReference(alert)}`),
  ];
}

function parseLinkHeader(header) {
  if (!header) return {};
  const links = {};
  for (const part of header.split(",")) {
    const match = part.match(/<([^>]+)>;\s*rel="([^"]+)"/u);
    if (match) links[match[2]] = match[1];
  }
  return links;
}

async function fetchJsonPage(url, token) {
  const headers = {
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
  };
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(url, { headers });
  if (!response.ok) {
    const body = await response.text();
    const detail = body ? `: ${body.slice(0, 500)}` : "";
    throw new Error(`GitHub API request failed with ${response.status} ${response.statusText}${detail}`);
  }
  return {
    body: await response.json(),
    next: parseLinkHeader(response.headers.get("link")).next,
  };
}

export async function fetchOpenCodeScanningAlerts(repository, token = githubTokenFromEnvironment()) {
  const encodedRepository = repository.split("/").map(encodeURIComponent).join("/");
  let nextURL = `${githubApiBaseURL}/repos/${encodedRepository}/code-scanning/alerts?state=open&per_page=100`;
  const alerts = [];
  while (nextURL) {
    const page = await fetchJsonPage(nextURL, token);
    if (!Array.isArray(page.body)) {
      throw new Error("GitHub code-scanning alerts response must be an array.");
    }
    alerts.push(...page.body);
    nextURL = page.next;
  }
  return alerts;
}

async function main() {
  const repository = argValue("--repo")?.trim() || repositoryFromEnvironment();
  const errors = await githubSecurityStatusErrors({
    repository,
    fetchCodeScanningAlerts: () => fetchOpenCodeScanningAlerts(repository),
  });

  if (errors.length) {
    console.error(errors.join("\n"));
    process.exit(1);
  }

  console.log(`Verified GitHub code-scanning status: no open high/critical alerts for ${repository}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}

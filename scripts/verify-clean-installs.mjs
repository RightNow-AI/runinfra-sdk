#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalRegistryInstallEnv,
  npmRegistryInstallArgs,
  pypiIndexUrl,
  pythonRegistryInstallArgs,
  pythonRegistrySourceInstallArgs,
} from "./clean-install-policy.mjs";
import { registryAvailabilityErrors, registryVersionChecks } from "./registry-version-preflight.mjs";
import { findForbiddenContent } from "./secret-scan-policy.mjs";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
const mode = args.includes("--registry") ? "registry" : optionValue("--mode") ?? "artifact";
const packageSelection = optionValue("--package") ?? "both";
const keepTmp = args.includes("--keep-tmp");
const version = optionValue("--version") ?? readNpmVersion();
const registryInstallAttempts = parsePositiveInteger(
  optionValue("--registry-attempts") ?? "6",
  "--registry-attempts",
);
const registryRetryDelayMs = parsePositiveInteger(
  optionValue("--registry-retry-delay-ms") ?? "10000",
  "--registry-retry-delay-ms",
);
const maxCleanInstallCommandTimeoutMs = 3_600_000;
const cleanInstallCommandTimeoutMs = parsePositiveInteger(
  process.env.RUNINFRA_CLEAN_INSTALL_COMMAND_TIMEOUT_MS ?? "120000",
  "RUNINFRA_CLEAN_INSTALL_COMMAND_TIMEOUT_MS",
  { max: maxCleanInstallCommandTimeoutMs },
);
const webhookDeliverySurfaceRow = "webhooks.delivery_surface.absent";
const tempRoot = resolve(repoRoot, ".clean-install-tmp");

if (!["artifact", "registry"].includes(mode)) {
  fail(`Unsupported mode "${mode}". Use --mode artifact or --mode registry.`);
}
if (!["both", "typescript", "python"].includes(packageSelection)) {
  fail(`Unsupported package "${packageSelection}". Use --package both, typescript, or python.`);
}

function optionValue(name) {
  const exact = args.find((arg) => arg.startsWith(`${name}=`));
  if (exact) return exact.slice(name.length + 1);
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function readNpmVersion() {
  const packageJson = JSON.parse(readFileSync(resolve(repoRoot, "typescript", "package.json"), "utf8"));
  if (typeof packageJson.version !== "string" || !packageJson.version) {
    fail("typescript/package.json is missing a package version.");
  }
  return packageJson.version;
}

function parsePositiveInteger(value, label, options = {}) {
  if (!/^[1-9][0-9]*$/u.test(value)) {
    fail(`${label} must be a positive integer.`);
  }
  const parsed = Number(value);
  if (typeof options.max === "number" && parsed > options.max) {
    fail(`${label} must be no greater than ${options.max}.`);
  }
  if (!Number.isSafeInteger(parsed)) {
    fail(`${label} must be a safe integer.`);
  }
  return parsed;
}

function fail(message) {
  console.error(message);
  process.exit(1);
}

function newestMatching(dir, pattern, label) {
  const absoluteDir = resolve(repoRoot, dir);
  if (!existsSync(absoluteDir)) {
    throw new Error(`${label} directory does not exist. Build package artifacts first.`);
  }
  const matches = readdirSync(absoluteDir)
    .filter((entry) => pattern.test(entry))
    .map((entry) => {
      const path = join(absoluteDir, entry);
      return { path, mtimeMs: statSync(path).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (matches.length === 0) {
    throw new Error(`${label} artifact not found. Build package artifacts first.`);
  }
  return matches[0].path;
}

function sleepMs(delayMs) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delayMs);
}

function run(command, commandArgs, cwd, options = {}) {
  const childEnv = {
    ...process.env,
    npm_config_audit: "false",
    npm_config_fund: "false",
    PIP_DISABLE_PIP_VERSION_CHECK: "1",
  };
  const env = mode === "registry" || options.canonicalRegistryEnv === true
    ? canonicalRegistryInstallEnv(childEnv)
    : childEnv;
  const captureOutput = options.captureOutput === true;
  const result = spawnSync(command, commandArgs, {
    cwd,
    env,
    stdio: "pipe",
    encoding: "utf8",
    timeout: cleanInstallCommandTimeoutMs,
  });
  if (result.error || result.status !== 0) {
    if (options.allowFailure === true) {
      return false;
    }
    if (isTimeoutError(result.error)) {
      throw new Error(`${timeoutFailureMessage(options)} after ${cleanInstallCommandTimeoutMs}ms`);
    }
    const message = options.failureMessage ?? `Clean install command failed: ${command} ${commandArgs.slice(0, 2).join(" ")}`.trim();
    const summary = captureOutput ? cleanFailureSummary(result.stdout, result.stderr) : "";
    throw new Error(summary ? `${message}: ${summary}` : message);
  }
  if (options.suppressOutputOnSuccess !== true) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  return true;
}

function isTimeoutError(error) {
  return error && typeof error === "object" && "code" in error && error.code === "ETIMEDOUT";
}

function timeoutFailureMessage(options) {
  if (typeof options.timeoutFailureMessage === "string" && options.timeoutFailureMessage) {
    return options.timeoutFailureMessage;
  }
  if (typeof options.failureMessage === "string" && options.failureMessage.endsWith(" failed")) {
    return `${options.failureMessage.slice(0, -" failed".length)} timed out`;
  }
  return "Clean install command timed out";
}

function cleanFailureSummary(stdout, stderr) {
  const output = `${stdout ?? ""}\n${stderr ?? ""}`;
  const candidates = [];
  const errorMatch = output.match(/(?:Error|SystemExit):\s*([^\r\n]+)/u);
  if (errorMatch) candidates.push(errorMatch[1]);
  const systemExitMatch = output.match(/raise SystemExit\((["'])(.*?)\1\)/u);
  if (systemExitMatch) candidates.push(systemExitMatch[2]);
  candidates.push(...String(stderr ?? "").split(/\r?\n/u).reverse());
  for (const candidate of candidates) {
    const summary = safeFailureSummary(candidate);
    if (summary) return summary;
  }
  return "import check failed";
}

function safeFailureSummary(candidate) {
  const summary = String(candidate ?? "").trim();
  if (!summary) return "";
  if (summary.length > 200) return "";
  if (findForbiddenContent(summary)) return "";
  if (/[\\/](?:\.clean-install-tmp|node_modules|AppData|Users)[\\/]/iu.test(summary)) return "";
  if (/[a-z]:[\\/]/iu.test(summary)) return "";
  if (/\bfile:\/\//iu.test(summary)) return "";
  if (/(?:^|[\s"'(])\/(?!\/)[^\s"'<>:]+(?:\/[^\s"'<>:]+)+/u.test(summary)) return "";
  if (/^(?:file|[a-z]:[\\/]|\/)/iu.test(summary)) return "";
  if (/^\s*(?:at |Traceback|File |Node\.js|[-^]+$)/u.test(summary)) return "";
  if (/\b(?:import\.meta|throw new Error|raise SystemExit)\b/u.test(summary)) return "";
  return summary;
}

function runRegistryInstall(command, commandArgs, cwd, label, options = {}) {
  if (mode !== "registry") {
    run(command, commandArgs, cwd, options);
    return;
  }
  for (let attempt = 1; attempt <= registryInstallAttempts; attempt += 1) {
    const isLastAttempt = attempt === registryInstallAttempts;
    const ok = run(command, commandArgs, cwd, { ...options, allowFailure: !isLastAttempt });
    if (ok) {
      return;
    }
    console.error(
      `${label} registry install attempt ${attempt}/${registryInstallAttempts} failed; retrying in ${registryRetryDelayMs}ms.`,
    );
    sleepMs(registryRetryDelayMs);
  }
}

function pythonExecutable(venvDir) {
  return process.platform === "win32"
    ? join(venvDir, "Scripts", "python.exe")
    : join(venvDir, "bin", "python");
}

function createTempWorkspace() {
  mkdirSync(tempRoot, { recursive: true });
  const separator = process.platform === "win32" ? "\\" : "/";
  const workspace = resolve(tempRoot, `${Date.now()}-${process.pid}`);
  if (!workspace.startsWith(`${tempRoot}${separator}`)) {
    fail("Refusing to create clean-install workspace outside .clean-install-tmp.");
  }
  mkdirSync(workspace, { recursive: true });
  return workspace;
}

function cleanupTempWorkspace(workspace) {
  rmSync(workspace, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  try {
    if (existsSync(tempRoot) && readdirSync(tempRoot).length === 0) {
      rmdirSync(tempRoot);
    }
  } catch {
    // Another verifier process may still be using the temp root.
  }
}

function npmCommand() {
  const npmCli = join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js");
  if (existsSync(npmCli)) {
    return { command: process.execPath, prefixArgs: [npmCli] };
  }
  return { command: process.platform === "win32" ? "npm.cmd" : "npm", prefixArgs: [] };
}

function verifyNpm(workspace) {
  const npmDir = join(workspace, "npm-consumer");
  mkdirSync(npmDir, { recursive: true });
  writeFileSync(
    join(npmDir, "package.json"),
    JSON.stringify({ private: true, type: "module", dependencies: {} }, null, 2),
  );

  const installSpec = mode === "registry"
    ? `@runinfra/sdk@${version}`
    : resolve(optionValue("--npm-tarball") ?? newestMatching("typescript", /^runinfra-sdk-.+\.tgz$/u, "npm"));

  const npm = npmCommand();
  const installArgs = mode === "registry"
    ? npmRegistryInstallArgs(version)
    : [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        installSpec,
      ];
  runRegistryInstall(npm.command, [...npm.prefixArgs, ...installArgs], npmDir, "npm", {
    failureMessage: "npm clean install failed",
  });
  run(process.execPath, ["--input-type=module", "-e", `
import { RUNINFRA_SDK_VERSION, RunInfra } from "@runinfra/sdk";
if (RUNINFRA_SDK_VERSION !== "${version}") {
  throw new Error(\`unexpected npm SDK version: \${RUNINFRA_SDK_VERSION}\`);
}
const client = new RunInfra({
  apiKey: "sk-ri-clean-install-test",
  baseURL: "http://localhost:1/v1",
  maxRetries: 0,
});
const webhookDeliverySurfaceRow = "${webhookDeliverySurfaceRow}";
if (typeof client.chat.completions.create !== "function") throw new Error("chat.completions.create missing");
if (typeof client.responses.create !== "function") throw new Error("responses.create missing");
if (typeof client.embeddings.create !== "function") throw new Error("embeddings.create missing");
if (typeof client.images.generate !== "function") throw new Error("images.generate missing");
if (typeof client.audio.speech.create !== "function") throw new Error("audio.speech.create missing");
if (typeof client.audio.transcriptions.create !== "function") throw new Error("audio.transcriptions.create missing");
if (typeof client.voice.pipeline.create !== "function") throw new Error("voice.pipeline.create missing");
if (typeof client.webhooks.create !== "undefined") throw new Error("webhooks.create must not be public");
if (typeof client.webhooks.list !== "undefined") throw new Error("webhooks.list must not be public");
if (typeof client.webhooks.verifySignature !== "function") throw new Error("webhooks.verifySignature missing");
if (typeof client.webhooks.constructEvent !== "function") throw new Error("webhooks.constructEvent missing");
if (webhookDeliverySurfaceRow !== "webhooks.delivery_surface.absent") throw new Error("webhook delivery surface row mismatch");
console.log("Verified npm clean install/import");
`], npmDir, { captureOutput: true, failureMessage: "npm clean import check failed" });
}

function verifyPythonInstall(workspace, installLabel, installArgs, options = {}) {
  const pythonDir = join(workspace, `python-${installLabel}-consumer`);
  const venvDir = join(pythonDir, "venv");
  mkdirSync(pythonDir, { recursive: true });
  const hostPython = optionValue("--python") ?? "python";
  run(hostPython, ["-m", "venv", venvDir], pythonDir, {
    failureMessage: `Python ${installLabel} venv creation failed`,
  });
  const python = pythonExecutable(venvDir);
  if (mode === "registry") {
    runRegistryInstall(python, installArgs, pythonDir, "PyPI", options);
  } else {
    run(python, installArgs, pythonDir, options);
  }
  run(python, ["-c", `
from runinfra import RunInfra, __version__
if __version__ != "${version}":
    raise SystemExit(f"unexpected Python SDK version: {__version__}")
client = RunInfra(api_key="sk-ri-clean-install-test", base_url="http://localhost:1/v1", max_retries=0)
webhook_delivery_surface_row = "${webhookDeliverySurfaceRow}"
for label, value in {
    "chat.completions.create": client.chat.completions.create,
    "responses.create": client.responses.create,
    "embeddings.create": client.embeddings.create,
    "images.generate": client.images.generate,
    "audio.speech.create": client.audio.speech.create,
    "audio.transcriptions.create": client.audio.transcriptions.create,
    "voice.pipeline.create": client.voice.pipeline.create,
}.items():
    if not callable(value):
        raise SystemExit(f"{label} missing")
if hasattr(client.webhooks, "create"):
    raise SystemExit("webhooks.create must not be public")
if hasattr(client.webhooks, "list"):
    raise SystemExit("webhooks.list must not be public")
if not callable(client.webhooks.verify_signature):
    raise SystemExit("webhooks.verify_signature missing")
if not callable(client.webhooks.construct_event):
    raise SystemExit("webhooks.construct_event missing")
if webhook_delivery_surface_row != "webhooks.delivery_surface.absent":
    raise SystemExit("webhook delivery surface row mismatch")
print("Verified Python ${installLabel} clean install/import")
`], pythonDir, { captureOutput: true, failureMessage: `Python ${installLabel} clean import check failed` });
}

function verifyPython(workspace) {
  if (mode === "registry") {
    verifyPythonInstall(workspace, "registry", pythonRegistryInstallArgs(version), {
      captureOutput: true,
      failureMessage: "Python registry clean install failed",
      suppressOutputOnSuccess: true,
    });
    verifyPythonInstall(workspace, "registry-sdist", pythonRegistrySourceInstallArgs(version), {
      captureOutput: true,
      failureMessage: "Python registry sdist clean install failed",
      suppressOutputOnSuccess: true,
    });
    return;
  }

  verifyPythonInstall(workspace, "wheel", [
    "-m",
    "pip",
    "install",
    "--no-index",
    "--no-deps",
    resolve(optionValue("--python-wheel") ?? newestMatching("python/dist", /^runinfra-.+\.whl$/u, "Python wheel")),
  ], {
    captureOutput: true,
    failureMessage: "Python wheel clean install failed",
    suppressOutputOnSuccess: true,
  });

  verifyPythonInstall(workspace, "sdist", [
    "-m",
    "pip",
    "install",
    "--index-url",
    pypiIndexUrl,
    "--no-deps",
    resolve(optionValue("--python-sdist") ?? newestMatching("python/dist", /^runinfra-.+\.tar\.gz$/u, "Python sdist")),
  ], {
    canonicalRegistryEnv: true,
    captureOutput: true,
    failureMessage: "Python sdist clean install failed",
    suppressOutputOnSuccess: true,
  });
}

async function preflightRegistryAvailability() {
  if (mode !== "registry") return;
  const checks = registryVersionChecks(version, packageSelection);
  const errors = await registryAvailabilityErrors(checks);
  if (errors.length) {
    fail(`Registry version preflight failed:\n${errors.join("\n")}`);
  }
}

await preflightRegistryAvailability();

const workspace = createTempWorkspace();
let completed = false;
try {
  if (packageSelection === "both" || packageSelection === "typescript") {
    verifyNpm(workspace);
  }
  if (packageSelection === "both" || packageSelection === "python") {
    verifyPython(workspace);
  }
  completed = true;
  console.log(`Verified clean ${mode} ${packageSelection} installs for SDK version ${version}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (!keepTmp) {
    cleanupTempWorkspace(workspace);
  } else if (completed) {
    console.log("Kept clean-install workspace for inspection.");
  }
}

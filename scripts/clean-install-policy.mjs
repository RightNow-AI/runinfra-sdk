export const npmRegistry = "https://registry.npmjs.org/";
export const pypiIndexUrl = "https://pypi.org/simple";

export function canonicalRegistryInstallEnv(baseEnv) {
  const childEnv = { ...baseEnv };
  childEnv.npm_config_registry = npmRegistry;
  childEnv.NPM_CONFIG_REGISTRY = npmRegistry;
  childEnv.PIP_INDEX_URL = pypiIndexUrl;
  childEnv.PIP_EXTRA_INDEX_URL = "";
  delete childEnv.PIP_NO_INDEX;
  delete childEnv.PIP_FIND_LINKS;
  return childEnv;
}

export function npmRegistryInstallArgs(version) {
  return [
    "install",
    "--ignore-scripts",
    "--no-audit",
    "--no-fund",
    "--package-lock=false",
    `--registry=${npmRegistry}`,
    `@runinfra/sdk@${version}`,
  ];
}

export function pythonRegistryInstallArgs(version) {
  return [
    "-m",
    "pip",
    "install",
    "--index-url",
    pypiIndexUrl,
    "--no-deps",
    `runinfra==${version}`,
  ];
}

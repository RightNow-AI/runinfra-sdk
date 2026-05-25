const token = "[A-Za-z0-9_=-]";

export const forbiddenContentPatterns = [
  { label: "Windows user home path", regex: /\b[A-Z]:\\Users\\[^\\\s"'<>]+/iu },
  { label: "macOS user home path", regex: /\/Users\/[^/\s"'<>]+/iu },
  { label: "Linux user home path", regex: /\/home\/[^/\s"'<>]+/iu },
  { label: "RunInfra local workspace path", regex: /RightNow-Full/iu },
  { label: "private key", regex: /BEGIN (?:(?:RSA |OPENSSH |EC |DSA |ENCRYPTED )?PRIVATE KEY|PGP PRIVATE KEY BLOCK)/u },
  { label: "npm token", regex: /npm_[A-Za-z0-9]{20,}/u },
  { label: "PyPI token", regex: /pypi-[A-Za-z0-9_-]{40,}/u },
  { label: "GitHub token", regex: /(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{22,})/u },
  { label: "AWS access key", regex: /(?:A3T[A-Z0-9]|AKIA|ASIA)[A-Z0-9]{16}/u },
  { label: "Stripe secret key", regex: /(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/u },
  { label: "webhook signing secret", regex: /whsec_[A-Za-z0-9]{20,}/u },
  { label: "JWT", regex: new RegExp(`eyJ${token}{10,}\\.${token}{10,}\\.${token}{10,}`, "u") },
  { label: "RunInfra API key", regex: /sk-ri-[A-Za-z0-9_-]{20,}/u },
  { label: "generic secret key", regex: /sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}/u },
  { label: "Google API key", regex: /AIza[0-9A-Za-z_-]{35}/u },
  { label: "Slack token", regex: /xox[baprs]-[A-Za-z0-9-]{20,}/u },
  { label: "source map reference", regex: /sourceMappingURL/u },
  { label: "source URL reference", regex: /sourceURL/u },
  { label: "inline source map content", regex: /sourcesContent/u },
  { label: "webpack source URL", regex: /webpack:\/\//u },
  { label: "npm credential config", regex: /(?:^|\n)\s*(?:\/\/[^\s=]+\/:_authToken|_authToken)\s*=/iu },
  {
    label: "PyPI credential config",
    regex: /(?:^|\n)\s*\[(?:pypi|distutils|server-login)\][\s\S]{0,800}(?:^|\n)\s*(?:username|password)\s*=/iu,
  },
  { label: "netrc credential config", regex: /(?:^|\n)\s*machine\s+\S+[\s\S]{0,400}\b(?:login|password)\s+\S+/iu },
  {
    label: "pip credential config",
    regex: /(?:^|\n)\s*(?:index-url|extra-index-url)\s*=\s*https?:\/\/[^/\s:@]+:[^@\s]+@/iu,
  },
  { label: "environment file", regex: /(?:^|[\\/])\.env(?:\.[A-Za-z0-9_-]+)?(?:$|[\\/\s"'<>])/u },
];

export function findForbiddenContent(content) {
  const serialized = typeof content === "string" ? content : String(content ?? "");
  return forbiddenContentPatterns.find((pattern) => pattern.regex.test(serialized)) ?? null;
}

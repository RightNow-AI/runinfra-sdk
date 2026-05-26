export const productionBaseURL = "https://api.runinfra.ai/v1";

export function reportBaseURL(value, hasCustomBaseURL) {
  if (!hasCustomBaseURL) return value;
  return value === productionBaseURL ? productionBaseURL : "custom_set_redacted";
}

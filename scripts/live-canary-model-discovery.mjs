export const modelDiscoveryEnvNames = [
  "RUNINFRA_LLM_MODEL",
  "RUNINFRA_EMBEDDING_MODEL",
  "RUNINFRA_IMAGE_MODEL",
  "RUNINFRA_TTS_MODEL",
  "RUNINFRA_ASR_MODEL",
];

const modalitySpecs = [
  {
    env: "RUNINFRA_LLM_MODEL",
    modality: "llm",
    pattern: /\b(?:chat(?:[._-]?completions?)?|responses?|completion|text[._ -]?generation|language[._ -]?model|llm|instruct)\b/iu,
  },
  {
    env: "RUNINFRA_EMBEDDING_MODEL",
    modality: "embedding",
    pattern: /\b(?:embedding|embeddings|embed|vector)\b/iu,
  },
  {
    env: "RUNINFRA_IMAGE_MODEL",
    modality: "image",
    pattern: /\b(?:image(?:[._ -]?generation)?|text[._ -]?to[._ -]?image)\b/iu,
  },
  {
    env: "RUNINFRA_TTS_MODEL",
    modality: "tts",
    pattern: /\b(?:tts|text[._ -]?to[._ -]?speech|speech[._ -]?synthesis|audio[._ -]?speech)\b/iu,
  },
  {
    env: "RUNINFRA_ASR_MODEL",
    modality: "asr",
    pattern: /\b(?:asr|transcription|transcriptions|speech[._ -]?to[._ -]?text|speech[._ -]?recognition|whisper)\b/iu,
  },
];

const structuredSignalRoots = new Set([
  "capabilities",
  "metadata",
  "modalities",
  "modality",
  "model_type",
  "pipeline_type",
  "task",
  "tasks",
  "tags",
  "type",
]);

const fallbackSignalRoots = new Set(["id", "name", "display_name", "description", "category"]);

export function emptyModelDiscoveryCandidates() {
  return Object.fromEntries(modelDiscoveryEnvNames.map((name) => [
    name,
    {
      modality: modalitySpecs.find((spec) => spec.env === name)?.modality ?? "unknown",
      status: "missing_candidate",
      candidateIds: [],
      evidence: [],
    },
  ]));
}

export function buildBlockedModelDiscoveryReport({
  baseURL,
  env,
  missing,
  generatedAt = new Date().toISOString(),
}) {
  return {
    status: "blocked",
    generatedAt,
    baseURL,
    note: discoveryNote(),
    env,
    missing,
    catalog: {
      count: 0,
      classifiedCount: 0,
      unclassifiedCount: 0,
      invalidCount: 0,
    },
    candidatesByEnv: emptyModelDiscoveryCandidates(),
  };
}

export function buildFailedModelDiscoveryReport({
  baseURL,
  env,
  error,
  generatedAt = new Date().toISOString(),
}) {
  return {
    status: "failed",
    generatedAt,
    baseURL,
    note: discoveryNote(),
    env,
    error,
    catalog: {
      count: 0,
      classifiedCount: 0,
      unclassifiedCount: 0,
      invalidCount: 0,
    },
    candidatesByEnv: emptyModelDiscoveryCandidates(),
  };
}

export function buildModelDiscoveryReport({
  baseURL,
  models,
  requestId,
  generatedAt = new Date().toISOString(),
}) {
  const candidatesByEnv = emptyModelDiscoveryCandidates();
  let classifiedCount = 0;
  let invalidCount = 0;

  for (const model of models) {
    const id = safeModelId(model);
    if (!id) {
      invalidCount += 1;
      continue;
    }

    const matches = classifyModel(model);
    if (!matches.size) continue;
    classifiedCount += 1;
    for (const [envName, evidence] of matches.entries()) {
      const bucket = candidatesByEnv[envName];
      if (!bucket.candidateIds.includes(id)) bucket.candidateIds.push(id);
      bucket.evidence = sortedUnique([...bucket.evidence, ...evidence]);
      bucket.status = "candidate_found";
    }
  }

  return {
    status: "completed",
    generatedAt,
    baseURL,
    note: discoveryNote(),
    catalog: {
      count: models.length,
      requestId,
      classifiedCount,
      unclassifiedCount: Math.max(0, models.length - classifiedCount - invalidCount),
      invalidCount,
    },
    candidatesByEnv,
  };
}

function discoveryNote() {
  return "Catalog candidates are informational hints only. They do not prove endpoint callability or make strict preflight ready.";
}

function safeModelId(model) {
  if (!isRecord(model)) return undefined;
  const id = model.id;
  return typeof id === "string" && id.trim() ? id.trim() : undefined;
}

function classifyModel(model) {
  const structuredSignals = collectSignals(model, structuredSignalRoots);
  const signals = structuredSignals.length ? structuredSignals : collectSignals(model, fallbackSignalRoots);
  const matches = new Map();
  for (const spec of modalitySpecs) {
    const evidence = signals
      .filter((signal) => spec.pattern.test(signal.value))
      .map((signal) => signal.evidence);
    if (evidence.length) matches.set(spec.env, sortedUnique(evidence));
  }
  return matches;
}

function collectSignals(value, allowedRoots, path = []) {
  if (Array.isArray(value)) {
    return value.flatMap((entry) => collectSignals(entry, allowedRoots, path));
  }
  if (isRecord(value)) {
    return Object.entries(value).flatMap(([key, nested]) => collectSignals(nested, allowedRoots, [...path, key]));
  }
  if (!["string", "number", "boolean"].includes(typeof value)) return [];
  const root = path[0];
  if (!root || !allowedRoots.has(root)) return [];
  return [{
    value: `${path.join(" ")} ${String(value)}`,
    evidence: evidencePath(path),
  }];
}

function evidencePath(path) {
  if (path[0] === "metadata" && path[1]) return `metadata.${path[1]}`;
  return path[0];
}

function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function sortedUnique(values) {
  return [...new Set(values)].sort();
}

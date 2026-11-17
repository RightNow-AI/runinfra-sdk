import { createHmac, timingSafeEqual } from "node:crypto";

export const RUNINFRA_SDK_VERSION = "0.3.1";
/**
 * The longest wait the API may name (`Retry-After-Ms`, `Retry-After`) that the
 * SDK sleeps for before it asks again. A longer wait is raised at once, with
 * the wait on the error.
 */
const MAX_AUTOMATIC_RETRY_AFTER_MS = 60_000;
/**
 * The timeout of a non-streamed call when the caller names none. The API
 * allows a whole response up to 740 seconds, so the default sits just above.
 */
const DEFAULT_TIMEOUT_MS = 750_000;
/**
 * The timeout of a streamed call when the caller names none: the wait for the
 * response headers, and for each later read. The API allows a stream up to
 * 180 seconds to its first token, so the default sits just above.
 */
const DEFAULT_STREAM_TIMEOUT_MS = 190_000;

export interface RunInfraOptions {
  apiKey: string;
  pipelineId?: string;
  baseURL?: string;
  /**
   * The timeout of every call, in milliseconds. Left out, a non-streamed call
   * is given 750 seconds, and a streamed call 190 seconds to its response
   * headers and to each later read.
   */
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  fetch?: typeof fetch;
  dangerouslyAllowBrowser?: boolean;
}

export interface RunInfraRequestOptions {
  clientRequestId?: string;
  idempotencyKey?: string;
  /** The timeout of this call, in milliseconds. It wins over the client's `timeoutMs` and over the defaults. */
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
}

/** One call the model asks for, on an assistant message's `tool_calls`. */
export interface ChatCompletionMessageToolCall {
  /** The call's id. The `tool` message that answers the call repeats it as `tool_call_id`. */
  id: string;
  type: "function";
  function: {
    name: string;
    /** The arguments as a JSON string. Parse and check them before you run the tool. */
    arguments: string;
  };
}

/**
 * One message of a chat. `system`, `developer` and `user` messages carry
 * `content`. An `assistant` message carries `content`, a non-empty
 * `tool_calls`, or both. A `tool` message carries `content` and the
 * `tool_call_id` of the call it answers; `ChatToolMessage` types that one.
 */
export interface ChatMessage {
  role: "system" | "developer" | "user" | "assistant" | "tool" | string;
  /** `null` or left out on an assistant message that carries only `tool_calls`. */
  content?: string | Array<Record<string, unknown>> | null;
  name?: string;
  /** On a `tool` message: the `id` of the call this message answers. */
  tool_call_id?: string;
  /** On an `assistant` message: the calls the model asked for. */
  tool_calls?: ChatCompletionMessageToolCall[];
  /** On an answered `assistant` message: the model's thinking, when the model reports it. */
  reasoning?: string | null;
}

/** The message that answers one tool call: the result as `content`, and the call's id. */
export interface ChatToolMessage extends ChatMessage {
  role: "tool";
  content: string | Array<Record<string, unknown>>;
  tool_call_id: string;
}

export interface ChatCompletionRequest {
  model: string;
  messages: ChatMessage[];
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  stop?: string | string[];
  presence_penalty?: number;
  frequency_penalty?: number;
  user?: string;
  metadata?: Record<string, unknown>;
  stream_options?: { include_usage?: boolean } & Record<string, unknown>;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: string | Record<string, unknown>;
  response_format?: Record<string, unknown>;
  seed?: number;
  logprobs?: boolean;
  top_logprobs?: number;
  /** `-1` or `0` turns it off. */
  top_k?: number;
  min_p?: number;
  repetition_penalty?: number;
  /** How many choices to generate. */
  n?: number;
  best_of?: number;
  logit_bias?: Record<string, number>;
  /** `false` asks for one tool call at a time. Whether it is honored depends on the model. */
  parallel_tool_calls?: boolean;
  /** How much the model reasons, such as `"none"`, `"low"` or `"high"`. The accepted values depend on the model. */
  reasoning_effort?: string;
  /** The reasoning object some routers send. Do not send it beside a `reasoning_effort` that disagrees. */
  reasoning?: { effort?: string; enabled?: boolean; exclude?: boolean } & Record<string, unknown>;
  /** `false` hides the model's reasoning from the answer. */
  include_reasoning?: boolean;
  /** A cache-affinity hint for requests that share a prompt prefix. */
  prompt_cache_key?: string;
  service_tier?: string;
  store?: boolean;
  safety_identifier?: string;
  modalities?: string[];
  audio?: Record<string, unknown>;
  prediction?: Record<string, unknown>;
  verbosity?: string;
  web_search_options?: Record<string, unknown>;
  moderation?: unknown;
  /** The older spelling of `tools`. Prefer `tools`. */
  functions?: Array<Record<string, unknown>>;
  /** The older spelling of `tool_choice`. Prefer `tool_choice`. */
  function_call?: string | Record<string, unknown>;
}

/**
 * The chat request fields that `extraBody` has always refused, because the
 * request type names them.
 */
const CHAT_COMPLETION_EXTRA_BODY_CLOSED_KEYS = new Set([
  "model",
  "messages",
  "stream",
  "temperature",
  "top_p",
  "max_tokens",
  "max_completion_tokens",
  "stop",
  "presence_penalty",
  "frequency_penalty",
  "user",
  "metadata",
  "stream_options",
  "tools",
  "tool_choice",
  "response_format",
  "seed",
  "logprobs",
  "top_logprobs",
]);

/**
 * Every field a chat request may carry. The fields typed since 0.3.1 are
 * accepted here and stay accepted in `extraBody`, where callers had to put
 * them before; naming one in both places is refused.
 */
const CHAT_COMPLETION_REQUEST_KEYS = new Set([
  ...CHAT_COMPLETION_EXTRA_BODY_CLOSED_KEYS,
  "top_k",
  "min_p",
  "repetition_penalty",
  "n",
  "best_of",
  "logit_bias",
  "parallel_tool_calls",
  "reasoning_effort",
  "reasoning",
  "include_reasoning",
  "prompt_cache_key",
  "service_tier",
  "store",
  "safety_identifier",
  "modalities",
  "audio",
  "prediction",
  "verbosity",
  "web_search_options",
  "moderation",
  "functions",
  "function_call",
]);

/** One piece of a tool call on a stream. Pieces of the same call share `index`; join their `arguments`. */
export interface ChatCompletionStreamToolCallDelta {
  index: number;
  /** On the first piece of a call. */
  id?: string;
  type?: "function";
  function?: {
    /** On the first piece of a call. */
    name?: string;
    /** The next piece of the arguments' JSON string. */
    arguments?: string;
  };
}

export interface ChatCompletionStreamEvent extends Record<string, unknown> {
  choices?: Array<
    {
      index?: number;
      delta?: {
        role?: string;
        content?: string | null;
        /** The next piece of the model's thinking, when the model reports it. */
        reasoning?: string | null;
        tool_calls?: ChatCompletionStreamToolCallDelta[];
      } & Record<string, unknown>;
      finish_reason?: string | null;
    } & Record<string, unknown>
  >;
}

export interface RunInfraRequestMetadata extends Record<string, unknown> {
  _request_id?: string;
  _idempotent_replay?: boolean;
}

export interface ChatCompletionResponse extends RunInfraRequestMetadata {
  id?: string;
  object?: string;
  created?: number;
  model?: string;
  choices?: Array<
    {
      index?: number;
      message?: ChatMessage & Record<string, unknown>;
      finish_reason?: string | null;
    } & Record<string, unknown>
  >;
  usage?: Record<string, unknown>;
}

export interface ChatCompletionsCreate {
  (
    request: ChatCompletionRequest & { stream: true },
    options?: RunInfraRequestOptions,
  ): Promise<RunInfraStream<ChatCompletionStreamEvent>>;
  (
    request: ChatCompletionRequest & { stream?: false | undefined },
    options?: RunInfraRequestOptions,
  ): Promise<ChatCompletionResponse>;
  (
    request: ChatCompletionRequest,
    options?: RunInfraRequestOptions,
  ): Promise<ChatCompletionResponse | RunInfraStream<ChatCompletionStreamEvent>>;
}

/**
 * Request shape for the current RunInfra Responses compatibility adapter.
 * The gateway maps supported fields onto chat completions and rewraps the
 * result; this is not a full stateful OpenAI Responses implementation.
 */
export interface ResponsesCreateRequest {
  model: string;
  input: string | Array<Record<string, unknown>>;
  instructions?: string;
  max_output_tokens?: number;
  stream?: boolean;
  temperature?: number;
  top_p?: number;
  tools?: Array<Record<string, unknown>>;
  tool_choice?: string | Record<string, unknown>;
  response_format?: Record<string, unknown>;
}

const RESPONSES_CREATE_REQUEST_KEYS = new Set([
  "model",
  "input",
  "instructions",
  "max_output_tokens",
  "stream",
  "temperature",
  "top_p",
  "tools",
  "tool_choice",
  "response_format",
]);

export interface ResponsesStreamEvent extends Record<string, unknown> {
  type?: string;
  delta?: string;
}

export interface ResponsesCreateResponse extends RunInfraRequestMetadata {
  id?: string;
  object?: string;
  created_at?: number;
  status?: string;
  model?: string;
  output_text?: string;
  output?: Array<Record<string, unknown>>;
  usage?: Record<string, unknown>;
}

export interface ResponsesCreate {
  (
    request: ResponsesCreateRequest & { stream: true },
    options?: RunInfraRequestOptions,
  ): Promise<RunInfraStream<ResponsesStreamEvent>>;
  (
    request: ResponsesCreateRequest & { stream?: false | undefined },
    options?: RunInfraRequestOptions,
  ): Promise<ResponsesCreateResponse>;
  (
    request: ResponsesCreateRequest,
    options?: RunInfraRequestOptions,
  ): Promise<ResponsesCreateResponse | RunInfraStream<ResponsesStreamEvent>>;
}

export interface EmbeddingRequest {
  model: string;
  input: string | string[];
  encoding_format?: "float" | string;
  dimensions?: number;
  user?: string;
}

const EMBEDDING_REQUEST_KEYS = new Set([
  "model",
  "input",
  "encoding_format",
  "dimensions",
  "user",
]);

export interface EmbeddingObject extends Record<string, unknown> {
  object?: string;
  embedding: number[];
  index: number;
}

export interface EmbeddingResponse extends RunInfraRequestMetadata {
  object?: string;
  model?: string;
  data: EmbeddingObject[];
  usage?: Record<string, unknown>;
}

export interface SpeechRequest {
  model: string;
  input: string;
  voice?: string;
  ref_audio?: string;
  ref_text?: string;
  task_type?: string;
  response_format?: string;
  speed?: number;
}

const SPEECH_REQUEST_KEYS = new Set([
  "model",
  "input",
  "voice",
  "ref_audio",
  "ref_text",
  "task_type",
  "response_format",
  "speed",
]);

export interface TranscriptionRequest {
  model: string;
  file: Blob;
  filename?: string;
  language?: string;
  prompt?: string;
  response_format?: "json" | "verbose_json" | string;
  temperature?: number;
}

const TRANSCRIPTION_REQUEST_KEYS = new Set([
  "model",
  "file",
  "filename",
  "language",
  "prompt",
  "response_format",
  "temperature",
]);

export interface TranscriptionResponse extends RunInfraRequestMetadata {
  text?: string;
  language?: string;
  duration?: number;
  segments?: Array<Record<string, unknown>>;
}

export interface ImageGenerateRequest {
  model: string;
  prompt: string;
  n?: number;
  size?: string;
  response_format?: "url" | "b64_json" | string;
  quality?: string;
  style?: string;
  user?: string;
}

const IMAGE_GENERATE_REQUEST_KEYS = new Set([
  "model",
  "prompt",
  "n",
  "size",
  "response_format",
  "quality",
  "style",
  "user",
]);

export interface ImageObject extends Record<string, unknown> {
  url?: string;
  b64_json?: string;
  revised_prompt?: string;
}

export interface ImageGenerationResponse extends RunInfraRequestMetadata {
  created?: number;
  data: ImageObject[];
}

export interface VoicePipelineRequest {
  audio: Blob | ArrayBuffer | Uint8Array;
  mimeType?: string;
}

const VOICE_PIPELINE_REQUEST_KEYS = new Set([
  "audio",
  "mimeType",
]);

export interface VoicePipelineResponse extends RunInfraRequestMetadata {
  object?: string;
  modality?: "voice-pipeline" | string;
  model?: string;
  upstream_model?: string;
  transcript?: string;
  text?: string;
  responseText?: string;
  response?: string;
  response_text?: string;
  outputText?: string;
  output_text?: string;
  audio_base64?: string;
  content_type?: string;
  usage?: Record<string, unknown>;
  latency_ms?: number;
}

export interface ModelObject extends RunInfraRequestMetadata {
  id: string;
  object?: string;
  created?: number;
  owned_by?: string;
}

export interface ModelListResponse extends RunInfraRequestMetadata {
  object?: string;
  data: ModelObject[];
}

/**
 * The state of a batch job. A job starts in `validating` while its input file
 * is read, then moves by itself through `checked` and `queued` to `running`.
 * `completed`, `expired`, `cancelled`, and `failed` are final.
 */
export type BatchState =
  | "validating"
  | "checked"
  | "queued"
  | "running"
  | "paused"
  | "cancelling"
  | "completed"
  | "expired"
  | "cancelled"
  | "failed";

/** Why a paused job waits. Set exactly when `batch_state` is `paused`. */
export type BatchPauseReason = "funds" | "destination" | "source" | "key_limit" | "daily_room";

/** Why a job ended. `null` while the job is open. */
export type BatchEndReason =
  | "all_done"
  | "max_cost_reached"
  | "cancel_asked"
  | "key_revoked"
  | "account_deleted"
  | "window_ended"
  | "model_withdrawn"
  | "not_flex"
  | "not_started"
  | "check_failed";

/** Why a job's input file was refused. Set only when `end_reason` is `check_failed`. */
export type BatchCheckError =
  | "url_not_public"
  | "link_expires_too_soon"
  | "file_too_large"
  | "link_changed"
  | "link_not_supported";

/** A notice about a job: data only. */
export type BatchNotice = "batch_ended" | "batch_paused" | "batch_expires_soon";

/** Why a line of the input file was refused when the file was read. */
export type BatchLineCheckCode =
  | "invalid_json"
  | "line_too_large"
  | "invalid_request"
  | "media_not_supported"
  | "prompt_too_large";

/** The code of a line that failed after its job started, as an error delivery carries it. */
export type BatchDeliveryErrorCode = "invalid_request" | "prompt_too_large" | "model_error" | "link_changed";

/** Why batch is not available, on a `flex_not_available` refusal (`error.reason`). */
export type BatchUnavailableReason = "model" | "partner" | "price";

/**
 * The refusal codes a caller of the batch routes can receive, as
 * `RunInfraError.code` carries them. Codes every route can answer
 * (`invalid_api_key` on 401, `rate_limit_exceeded` on 429) are not repeated
 * here.
 */
export type BatchRefusalCode =
  | "batch_not_open"
  | "invalid_request"
  | "not_found"
  | "model_not_sold"
  | "flex_not_available"
  | "url_not_public"
  | "link_expires_too_soon"
  | "destination_unreachable"
  | "needs_funds"
  | "key_spend_limit_reached"
  | "batch_ended"
  | "batches_scope_violation";

/** Where a job's answers go. A webhook address is the only destination. */
export interface BatchDestination {
  type: "webhook";
  /** A public HTTPS address on port 443, at most 8,192 bytes. */
  url: string;
}

export interface BatchCreateRequest {
  /** A model that offers batch. */
  model: string;
  /**
   * A public HTTPS link (port 443, at most 8,192 bytes) to a JSONL file of at
   * most 50 MiB whose host serves byte ranges. A signed link must stay valid
   * until the job's window ends.
   */
  input_url: string;
  destination: BatchDestination;
  /** The most the job may cost, in cents: a whole number from 1 to 100,000,000. */
  max_cost_cents: number;
  /** The job's window in hours. 24 is the only value, and the default. */
  window_hours?: 24;
  /** A label of at most 64 characters. */
  name?: string;
}

const BATCH_CREATE_REQUEST_KEYS = new Set([
  "model",
  "input_url",
  "destination",
  "max_cost_cents",
  "window_hours",
  "name",
]);

export interface BatchListParams {
  /** Page size, from 1 to 50. The gateway's default is 20. */
  limit?: number;
  /** The `next_cursor` of the page before. */
  cursor?: string;
  state?: BatchState;
  /** A model slug. */
  model?: string;
}

const BATCH_LIST_PARAM_KEYS = ["limit", "cursor", "state", "model"] as const;

/**
 * A batch job, as every batch route answers it. `failed` never includes an
 * undelivered line, and once a job has ended the counts `succeeded`,
 * `failed`, `expired`, `cancelled`, `undelivered`, and `lines_invalid` add up
 * to `lines_total`.
 */
export interface BatchJob {
  id: string;
  /** `null` when the model is no longer listed. */
  model_slug: string | null;
  batch_state: BatchState;
  pause_reason: BatchPauseReason | null;
  /** Who started the job: an API key, or a person in the dashboard. Never a name. */
  made_by: { kind: "person" | "key" };
  /** Every line read from the file, the invalid ones included. */
  lines_total: number;
  lines_invalid: number;
  succeeded: number;
  failed: number;
  /** Lines the job had not run when its window ended. They are not charged. */
  expired: number;
  cancelled: number;
  /**
   * Answered lines the address did not acknowledge with a 2xx in time. They
   * are not charged and are not sent again.
   */
  undelivered: number;
  /** What the job's lines were charged so far, in microcents (millionths of a cent). */
  cost_microcents: number;
  max_cost_cents: number | null;
  /** ISO 8601 UTC with milliseconds. */
  created_at: string;
  started_at: string | null;
  /** The end of the job's window. */
  expires_at: string;
  finished_at: string | null;
  destination_type: "webhook" | null;
  notice: BatchNotice | null;
  /** The API key the job runs as. */
  key_id: string | null;
  end_reason: BatchEndReason | null;
  check_error: BatchCheckError | null;
  name: string | null;
}

/** The lines one check code refused: how many, and the first line numbers (1-based, at most five). */
export interface BatchLineCheckErrors {
  code: BatchLineCheckCode;
  count: number;
  first_lines: number[];
}

/** The gateway's estimate of the most a job's lines can cost. */
export interface BatchQuote {
  input_cost_cents: number;
  output_cost_ceiling_cents: number;
  /** `input_cost_cents` plus `output_cost_ceiling_cents`. */
  most_cents: number;
  flex_input_cents_per_million: number;
  flex_output_cents_per_million: number;
  est_input_tokens: number;
  /** An estimate, never a promise. */
  can_finish_in_window: boolean;
  covered_until_after: string | null;
}

/** A job as `batches.retrieve()` answers it: the job, the lines its check refused, and its quote. */
export interface BatchJobDetail extends BatchJob {
  errors: BatchLineCheckErrors[];
  /** `null` while the file is still read, once the job has ended, and when no quote can be made now. */
  quote: BatchQuote | null;
}

export interface BatchCreateResponse extends RunInfraRequestMetadata {
  batch: BatchJob;
}

export interface BatchRetrieveResponse extends RunInfraRequestMetadata {
  batch: BatchJobDetail;
}

export interface BatchListResponse extends RunInfraRequestMetadata {
  /** Newest first. */
  batches: BatchJob[];
  /** Pass it as `cursor` for the next page. `null` on the last page. */
  next_cursor: string | null;
}

export interface BatchCancelResponse extends RunInfraRequestMetadata {
  batch_id: string;
  /** `cancelled` when no line had run; `cancelling` while lines in flight settle. */
  batch_state: "cancelling" | "cancelled";
}

export interface BatchDeliveryUsage {
  prompt_tokens: number;
  completion_tokens: number;
  total_tokens: number;
}

export interface BatchDeliveryCost {
  /** What the line cost, in microcents (millionths of a cent). */
  microcents: number;
}

/**
 * The test delivery a `batches.create()` call sends to the destination before
 * it answers. The address must reply 2xx with a body that CONTAINS `value`.
 */
export interface BatchTestDelivery {
  id: string;
  test: true;
  value: string;
}

/** One answered line. `id` is the same for the same line and attempt. Key your own writes on it. */
export interface BatchAnswerDelivery {
  id: string;
  batch_id: string;
  custom_id: string;
  /** The line's 1-based number in the input file. */
  line: number;
  attempt: number;
  test: false;
  /** The chat completion object. */
  response: Record<string, unknown>;
  error?: undefined;
  usage: BatchDeliveryUsage | null;
  cost: BatchDeliveryCost | null;
}

/** One line that failed after its job started. It carries no usage and no cost. */
export interface BatchErrorDelivery {
  id: string;
  batch_id: string;
  /** `null` when the file changed after it was checked (`link_changed`); `line` names the line then. */
  custom_id: string | null;
  line: number;
  attempt: number;
  test: false;
  error: { code: BatchDeliveryErrorCode };
  response?: undefined;
  usage: null;
  cost: null;
}

export type BatchDelivery = BatchTestDelivery | BatchAnswerDelivery | BatchErrorDelivery;

export interface VerifyBatchDeliveryOptions {
  /** The RAW request body exactly as it arrived: a string or bytes, never a re-serialized object. */
  payload: string | Uint8Array | ArrayBuffer;
  /** The request's headers, in any case: a `Headers` object or a plain object such as Node's `req.headers`. */
  headers: Headers | Record<string, string | string[] | undefined>;
  /** The workspace's batch signing secret as the dashboard shows it: `whsec_` followed by base64. */
  secret: string;
  /**
   * The most the delivery's timestamp may differ from the clock, in seconds.
   * 300 by default, so a captured delivery cannot be replayed later. A number
   * sets another tolerance; `null` turns the check off.
   */
  toleranceSeconds?: number | null;
  /** The clock the timestamp is compared with, in Unix seconds. Defaults to now. */
  now?: number;
}

export interface ConstructWebhookEventOptions {
  payload: string | Uint8Array | ArrayBuffer;
  signatureHeader: string;
  secret: string;
  toleranceSeconds?: number;
  now?: number;
}

export class RunInfraError extends Error {
  readonly status: number;
  readonly type: string;
  readonly requestId?: string;
  /**
   * The wait the API named with the error, in milliseconds: `Retry-After-Ms`
   * when the response carries it, else `Retry-After`. Set on every error whose
   * response named a wait, whatever its status.
   */
  readonly retryAfterMs?: number;
  readonly code?: string;
  readonly param?: string;
  /**
   * The closed cause word of a batch route's refusal, when its error body
   * names one (`error.reason`): `model`, `partner`, or `price` on
   * `flex_not_available`. Other routes do not set it.
   */
  readonly reason?: string;
  /**
   * What the API said about asking again, when it said it: `x-should-retry` on
   * the response, or `retryable` inside the error object. `false` means the
   * same request will fail again. Left unset when the API said nothing.
   */
  readonly retryable?: boolean;
  /**
   * The `X-Client-Request-Id` the SDK sent with the call, set on a timeout.
   * A call that timed out before any response has no server request id, so
   * this is the id to quote to support.
   */
  readonly clientRequestId?: string;

  constructor(message: string, input: {
    status: number;
    type: string;
    requestId?: string;
    retryAfterMs?: number;
    code?: string;
    param?: string;
    reason?: string;
    retryable?: boolean;
    clientRequestId?: string;
  }) {
    super(message);
    this.name = "RunInfraError";
    this.status = input.status;
    this.type = input.type;
    this.requestId = input.requestId;
    this.retryAfterMs = input.retryAfterMs;
    this.code = input.code;
    this.param = input.param;
    this.reason = input.reason;
    this.retryable = input.retryable;
    this.clientRequestId = input.clientRequestId;
  }
}

export class AuthenticationError extends RunInfraError {
  constructor(message: string, status: number, requestId?: string, code?: string, param?: string) {
    super(message, { status, type: "auth_error", requestId, code, param });
    this.name = "AuthenticationError";
  }
}

export class PermissionDeniedError extends RunInfraError {
  // `type` defaults to "permission_denied" but the gateway can supply a more
  // specific discriminator on the 403 body (e.g. "byoc_plan_required" when a
  // workspace below the deploy tier calls a BYOC-deployed endpoint). We thread
  // it onto `.type` so callers can branch — `err instanceof PermissionDeniedError
  // && err.type === "byoc_plan_required"` — instead of regex-scraping the message.
  constructor(message: string, status: number, requestId?: string, code?: string, param?: string, type = "permission_denied") {
    super(message, { status, type, requestId, code, param });
    this.name = "PermissionDeniedError";
  }
}

export class RateLimitError extends RunInfraError {
  constructor(message: string, status: number, requestId?: string, retryAfterMs?: number, code?: string, param?: string) {
    super(message, { status, type: "rate_limit_error", requestId, retryAfterMs, code, param });
    this.name = "RateLimitError";
  }
}

/**
 * A `402` from the gateway. On a batch route, read `code` to tell
 * `needs_funds` (the account has never added funds) from
 * `key_spend_limit_reached` (this API key reached its own monthly limit;
 * raise the key's limit or use another key).
 */
export class InsufficientCreditsError extends RunInfraError {
  /** Remaining workspace balance in cents, when the gateway reports it. */
  readonly currentBalanceCents?: number;
  /** Credits this request needed, in cents, when the gateway reports it. */
  readonly requiredCents?: number;
  /** Where to top up, when the gateway reports it. */
  readonly topupUrl?: string;
  constructor(
    message: string,
    status: number,
    requestId?: string,
    code?: string,
    param?: string,
    details?: { currentBalanceCents?: number; requiredCents?: number; topupUrl?: string },
  ) {
    super(message, { status, type: "insufficient_credits", requestId, code, param });
    this.name = "InsufficientCreditsError";
    this.currentBalanceCents = details?.currentBalanceCents;
    this.requiredCents = details?.requiredCents;
    this.topupUrl = details?.topupUrl;
  }
}

export class DeploymentError extends RunInfraError {
  constructor(message: string, status: number, requestId?: string, code?: string, param?: string) {
    super(message, { status, type: "deployment_error", requestId, code, param });
    this.name = "DeploymentError";
  }
}

export class ModelNotFoundError extends RunInfraError {
  constructor(message: string, status: number, requestId?: string, code?: string, param?: string) {
    super(message, { status, type: "model_not_found", requestId, code, param });
    this.name = "ModelNotFoundError";
  }
}

/**
 * A call that ran out of time. `clientRequestId` holds the
 * `X-Client-Request-Id` the SDK sent with the call; `requestId` is set only
 * when a response had begun. A call is never sent again after a timeout: the
 * API may still be working on it.
 */
export class RunInfraTimeoutError extends RunInfraError {
  constructor(message = "RunInfra request timed out", requestId?: string, clientRequestId?: string) {
    super(message, { status: 0, type: "timeout_error", requestId, clientRequestId });
    this.name = "RunInfraTimeoutError";
  }
}

export class RunInfraConnectionError extends RunInfraError {
  constructor(message = "RunInfra request failed before a response was received", requestId?: string) {
    super(message, { status: 0, type: "connection_error", requestId });
    this.name = "RunInfraConnectionError";
  }
}

export class RunInfraStreamParseError extends RunInfraError {
  constructor(message = "RunInfra stream event payload was not valid JSON", requestId?: string) {
    super(message, { status: 0, type: "stream_parse_error", requestId });
    this.name = "RunInfraStreamParseError";
  }
}

/**
 * The API ended an open stream with a failure: a frame that holds an `error`
 * object, or a `response.failed` event on a Responses stream. `type`, `code`
 * and `param` are the API's own, `retryable` is set when the API marked the
 * failure, and `requestId` is the request id the frame names, else the
 * stream's. `status` is `0`: the failure arrived after the HTTP status. The
 * events before the failure were already yielded. The answer is not whole.
 */
export class RunInfraStreamError extends RunInfraError {
  constructor(message: string, input: {
    type: string;
    requestId?: string;
    code?: string;
    param?: string;
    retryable?: boolean;
  }) {
    super(message, { status: 0, ...input });
    this.name = "RunInfraStreamError";
  }
}

/**
 * A stream's body ended without its end marker: `[DONE]` on a chat stream,
 * `response.completed` on a Responses stream. The connection was cut or the
 * stream was closed early, so the answer is not whole even though the HTTP
 * status was 200. The events before the end were already yielded.
 */
export class RunInfraStreamIncompleteError extends RunInfraError {
  constructor(
    message = "RunInfra stream ended before its end marker; the answer is incomplete",
    requestId?: string,
  ) {
    super(message, { status: 0, type: "stream_incomplete_error", requestId });
    this.name = "RunInfraStreamIncompleteError";
  }
}

export class UnsupportedOperationError extends RunInfraError {
  constructor(message: string) {
    super(message, { status: 400, type: "unsupported_operation" });
    this.name = "UnsupportedOperationError";
  }
}

export class WebhookVerificationError extends RunInfraError {
  constructor(message: string) {
    super(message, { status: 400, type: "webhook_verification_error" });
    this.name = "WebhookVerificationError";
  }
}

const WEBHOOK_SIGNATURE_HEADER_MAX_LENGTH = 8_192;

function webhookPayloadBytes(payload: string | Uint8Array | ArrayBuffer): Uint8Array {
  if (typeof payload === "string") return new TextEncoder().encode(payload);
  if (payload instanceof ArrayBuffer) return new Uint8Array(payload);
  if (payload instanceof Uint8Array) return payload;
  throw new WebhookVerificationError("Webhook payload must be a string, Uint8Array, or ArrayBuffer.");
}

function parseWebhookSignatureHeader(header: string): {
  timestamp: number;
  signatures: string[];
} {
  if (typeof header !== "string") {
    throw new WebhookVerificationError("Webhook signature header must be a string.");
  }
  if (header.length > WEBHOOK_SIGNATURE_HEADER_MAX_LENGTH) {
    throw new WebhookVerificationError("Webhook signature header is too large.");
  }
  const parts = header.split(",").map((part) => part.trim());
  let timestamp: number | null = null;
  const signatures: string[] = [];
  for (const part of parts) {
    const [key, value] = part.split("=", 2);
    if (key === "t" && value) {
      if (!/^[0-9]+$/u.test(value)) {
        throw new WebhookVerificationError("Webhook signature timestamp must be a non-negative integer.");
      }
      const parsed = Number(value);
      if (!Number.isSafeInteger(parsed)) {
        throw new WebhookVerificationError("Webhook signature timestamp must be a non-negative integer.");
      }
      timestamp = parsed;
    }
    if (key === "v1" && value) signatures.push(value);
  }
  if (timestamp === null || signatures.length === 0) {
    throw new WebhookVerificationError(
      "RunInfra webhook signature must include t=<unix_seconds> and v1=<hex_signature>.",
    );
  }
  return { timestamp, signatures };
}

function webhookExpectedSignature(params: {
  payload: Uint8Array;
  secret: string;
  timestamp: number;
}): string {
  const hmac = createHmac("sha256", params.secret);
  hmac.update(`${params.timestamp}.`);
  hmac.update(params.payload);
  return hmac.digest("hex");
}

function timingSafeHexEqual(a: string, b: string): boolean {
  if (a.length !== b.length || a.length % 2 !== 0) return false;
  if (!/^[a-f0-9]+$/iu.test(a) || !/^[a-f0-9]+$/iu.test(b)) return false;
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  return timingSafeEqual(left, right);
}

export function verifyWebhookSignature(options: ConstructWebhookEventOptions): true {
  if (typeof options.secret !== "string" || !options.secret.trim()) {
    throw new WebhookVerificationError("Webhook secret is required.");
  }
  const toleranceSeconds = options.toleranceSeconds ?? 300;
  if (!Number.isFinite(toleranceSeconds) || toleranceSeconds < 0) {
    throw new WebhookVerificationError("Webhook tolerance must be a non-negative number.");
  }
  const { timestamp, signatures } = parseWebhookSignatureHeader(options.signatureHeader);
  const now = options.now ?? Math.floor(Date.now() / 1000);
  if (!Number.isFinite(now) || now < 0) {
    throw new WebhookVerificationError("Webhook verification clock must be a non-negative finite number.");
  }
  if (Math.abs(now - timestamp) > toleranceSeconds) {
    throw new WebhookVerificationError("Webhook signature timestamp is outside the allowed tolerance.");
  }
  const payload = webhookPayloadBytes(options.payload);
  const expected = webhookExpectedSignature({ payload, secret: options.secret, timestamp });
  if (!signatures.some((signature) => timingSafeHexEqual(signature, expected))) {
    throw new WebhookVerificationError("Webhook signature verification failed.");
  }
  return true;
}

export function constructWebhookEvent<T = Record<string, unknown>>(
  options: ConstructWebhookEventOptions,
): T {
  verifyWebhookSignature(options);
  const payloadText =
    typeof options.payload === "string"
      ? options.payload
      : new TextDecoder().decode(webhookPayloadBytes(options.payload));
  try {
    return JSON.parse(payloadText) as T;
  } catch {
    throw new WebhookVerificationError("Webhook payload must be valid JSON.");
  }
}

const BATCH_DELIVERY_SECRET_PREFIX = "whsec_";
/** How far a delivery's timestamp may be from the clock unless the caller says otherwise, as for webhook events. */
const BATCH_DELIVERY_DEFAULT_TOLERANCE_SECONDS = 300;

function batchDeliveryHeader(headers: VerifyBatchDeliveryOptions["headers"], name: string): string {
  let value: unknown;
  if (headers !== null && typeof headers === "object" && typeof (headers as Headers).get === "function") {
    value = (headers as Headers).get(name);
  } else if (isPlainRecord(headers)) {
    const matches = Object.entries(headers).filter(([key]) => key.toLowerCase() === name);
    if (matches.length > 1) {
      throw new WebhookVerificationError(`Batch delivery header ${name} is present more than once.`);
    }
    const found = matches[0]?.[1];
    if (Array.isArray(found) && found.length > 1) {
      throw new WebhookVerificationError(`Batch delivery header ${name} is present more than once.`);
    }
    value = Array.isArray(found) ? found[0] : found;
  } else {
    throw new WebhookVerificationError("Batch delivery headers must be a Headers object or a plain object.");
  }
  if (typeof value !== "string" || !value.trim()) {
    throw new WebhookVerificationError(`Batch delivery header ${name} is missing.`);
  }
  if (value.length > WEBHOOK_SIGNATURE_HEADER_MAX_LENGTH) {
    throw new WebhookVerificationError(`Batch delivery header ${name} is too large.`);
  }
  return value.trim();
}

function batchDeliverySecretKey(secret: unknown): Buffer {
  if (typeof secret !== "string" || !secret.trim()) {
    throw new WebhookVerificationError("Batch signing secret is required.");
  }
  const trimmed = secret.trim();
  const encoded = trimmed.startsWith(BATCH_DELIVERY_SECRET_PREFIX)
    ? trimmed.slice(BATCH_DELIVERY_SECRET_PREFIX.length)
    : trimmed;
  if (encoded.length === 0 || encoded.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    throw new WebhookVerificationError("Batch signing secret must be whsec_ followed by base64.");
  }
  return Buffer.from(encoded, "base64");
}

function timingSafeTextEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  return left.length === right.length && timingSafeEqual(left, right);
}

/**
 * Verifies one batch delivery posted to your own address and returns it parsed
 * and typed: the test delivery of `batches.create()`, one line's answer, or
 * one line's error.
 *
 * Pass the RAW request body, exactly the bytes that arrived, and the request's
 * headers in any case. The signature is the Standard Webhooks one: header
 * `webhook-signature` holds `v1,` followed by the base64 HMAC-SHA-256 of
 * `<webhook-id>.<webhook-timestamp>.<raw body>`, compared in constant time.
 * Parsing the body and serializing it again changes the bytes and fails the
 * check.
 *
 * `secret` is the workspace's batch signing secret as the dashboard shows it:
 * `whsec_` followed by base64. The HMAC key is the base64-DECODED bytes after
 * the prefix, not the text. Header `x-rightnow-signature-version` names the
 * version of the secret that signed; a rotated secret stops verifying.
 *
 * The delivery's `webhook-timestamp` must be within 300 seconds of the clock
 * by default, so a captured delivery cannot be replayed later. A number in
 * `toleranceSeconds` sets another tolerance, `toleranceSeconds: null` turns
 * the check off, and `now` sets the clock it is compared with.
 *
 * ANSWERING THE TEST DELIVERY: `batches.create()` posts
 * `{ id, test: true, value }` to the destination before it answers, and the
 * address passes only when it replies 2xx with a body that CONTAINS the posted
 * `value`. A fixed `200 OK` fails the create with `destination_unreachable`.
 * Line deliveries (`test: false`) are acknowledged by any 2xx. Each answered
 * line is sent to the address once: if the address does not answer 2xx in
 * time, the line is counted `undelivered`, it is not charged, and it is not
 * sent again.
 *
 * Throws `WebhookVerificationError` when a header is missing, the signature
 * does not match, the timestamp is outside the tolerance, or the body is not a
 * delivery. Every failure of this helper is a `WebhookVerificationError`.
 */
export function verifyBatchDelivery(options: VerifyBatchDeliveryOptions): BatchDelivery {
  try {
    return verifiedBatchDelivery(options);
  } catch (error) {
    if (error instanceof WebhookVerificationError) throw error;
    throw new WebhookVerificationError("Batch delivery could not be verified.");
  }
}

function verifiedBatchDelivery(options: VerifyBatchDeliveryOptions): BatchDelivery {
  if (!isPlainRecord(options)) {
    throw new WebhookVerificationError("Batch delivery verification options are required.");
  }
  const key = batchDeliverySecretKey(options.secret);
  const toleranceSeconds = options.toleranceSeconds === undefined
    ? BATCH_DELIVERY_DEFAULT_TOLERANCE_SECONDS
    : options.toleranceSeconds;
  if (
    toleranceSeconds !== null &&
    (typeof toleranceSeconds !== "number" || !Number.isFinite(toleranceSeconds) || toleranceSeconds < 0)
  ) {
    throw new WebhookVerificationError("Batch delivery tolerance must be a non-negative number, or null to turn the check off.");
  }
  const id = batchDeliveryHeader(options.headers, "webhook-id");
  const timestamp = batchDeliveryHeader(options.headers, "webhook-timestamp");
  const signatureHeader = batchDeliveryHeader(options.headers, "webhook-signature");
  if (!/^[0-9]+$/u.test(timestamp) || !Number.isSafeInteger(Number(timestamp))) {
    throw new WebhookVerificationError("Batch delivery timestamp must be a non-negative integer.");
  }
  if (toleranceSeconds !== null) {
    const now = options.now ?? Math.floor(Date.now() / 1000);
    if (!Number.isFinite(now) || now < 0) {
      throw new WebhookVerificationError("Batch delivery verification clock must be a non-negative finite number.");
    }
    if (Math.abs(now - Number(timestamp)) > toleranceSeconds) {
      throw new WebhookVerificationError("Batch delivery timestamp is outside the allowed tolerance.");
    }
  }
  const payload = webhookPayloadBytes(options.payload);
  const hmac = createHmac("sha256", key);
  hmac.update(`${id}.${timestamp}.`);
  hmac.update(payload);
  const expected = `v1,${hmac.digest("base64")}`;
  // Standard Webhooks allows several space-separated signatures; one match is enough.
  const candidates = signatureHeader.split(" ").filter(Boolean);
  let verified = false;
  for (const candidate of candidates) {
    if (timingSafeTextEqual(candidate, expected)) verified = true;
  }
  if (!verified) {
    throw new WebhookVerificationError("Batch delivery signature verification failed.");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(payload));
  } catch {
    throw new WebhookVerificationError("Batch delivery payload must be valid JSON.");
  }
  if (!isPlainRecord(parsed) || typeof parsed.id !== "string" || typeof parsed.test !== "boolean") {
    throw new WebhookVerificationError("Batch delivery payload is not a batch delivery.");
  }
  return parsed as unknown as BatchDelivery;
}

export class RunInfraAudioResponse {
  readonly contentType: string;
  readonly requestId?: string;
  private readonly response: Response;
  private readonly readTimeoutMs?: number;
  private readonly sensitiveValues: readonly string[];

  constructor(response: Response, readTimeoutMs?: number, sensitiveValues: readonly string[] = []) {
    this.response = response;
    this.contentType = response.headers.get("content-type") ?? "application/octet-stream";
    this.requestId = response.headers.get("x-request-id") ?? undefined;
    this.readTimeoutMs = readTimeoutMs;
    this.sensitiveValues = sensitiveValues;
  }

  arrayBuffer(): Promise<ArrayBuffer> {
    return this.readBody(
      () => this.response.arrayBuffer(),
      "RunInfra audio response timed out while reading body",
    );
  }

  blob(): Promise<Blob> {
    return this.readBody(
      () => this.response.blob(),
      "RunInfra audio response timed out while reading body",
    );
  }

  stream(): ReadableStream<Uint8Array> | null {
    return this.response.body;
  }

  private async readBody<T>(
    operation: () => Promise<T>,
    timeoutMessage: string,
  ): Promise<T> {
    const bodyRead = operation();
    bodyRead.catch(() => undefined);
    if (this.readTimeoutMs === undefined) {
      try {
        return await bodyRead;
      } catch (error) {
        throw normalizeTransportError(error, this.requestId, this.sensitiveValues);
      }
    }

    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        bodyRead,
        new Promise<never>((_, reject) => {
          timeout = setTimeout(() => {
            void this.response.body?.cancel().catch(() => undefined);
            reject(new RunInfraTimeoutError(timeoutMessage, this.requestId));
          }, this.readTimeoutMs);
        }),
      ]);
    } catch (error) {
      throw normalizeTransportError(error, this.requestId, this.sensitiveValues);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
    }
  }
}

/**
 * The failure an open stream reported, read from one parsed event: a frame
 * with a top-level `error` object, or a Responses `response.failed` event,
 * whose error sits inside `response`. `undefined` for every other event.
 */
function streamFailure(event: unknown, streamRequestId?: string): RunInfraStreamError | undefined {
  if (!isPlainRecord(event)) return undefined;
  let failure: Record<string, unknown> | undefined;
  if (isPlainRecord(event.error)) {
    failure = event.error;
  } else if (event.type === "response.failed") {
    const response = isPlainRecord(event.response) ? event.response : {};
    failure = isPlainRecord(response.error) ? response.error : {};
  }
  if (!failure) return undefined;
  return new RunInfraStreamError(
    typeof failure.message === "string" && failure.message
      ? failure.message
      : "RunInfra stream ended with an error",
    {
      type: typeof failure.type === "string" ? failure.type : "api_error",
      requestId: typeof event.request_id === "string" && event.request_id ? event.request_id : streamRequestId,
      ...(typeof failure.code === "string" ? { code: failure.code } : {}),
      ...(typeof failure.param === "string" ? { param: failure.param } : {}),
      ...(typeof failure.retryable === "boolean" ? { retryable: failure.retryable } : {}),
    },
  );
}

/**
 * The events of one streamed answer.
 *
 * Iterating yields each event as it arrives. The iteration ends quietly only
 * when the stream carried its end marker: `[DONE]` on a chat stream,
 * `response.completed` on a Responses stream. It throws instead, after
 * yielding every event that came first, when the API reports a failure on the
 * open stream (`RunInfraStreamError`) or when the body ends without the end
 * marker (`RunInfraStreamIncompleteError`). Leaving the loop early throws
 * nothing.
 */
export class RunInfraStream<TEvent extends Record<string, unknown> = Record<string, unknown>>
  implements AsyncIterable<TEvent> {
  readonly response: Response;
  readonly requestId?: string;
  private readonly readTimeoutMs?: number;
  private readonly sensitiveValues: readonly string[];

  constructor(response: Response, readTimeoutMs?: number, sensitiveValues: readonly string[] = []) {
    this.response = response;
    this.requestId = response.headers.get("x-request-id") ?? undefined;
    this.readTimeoutMs = readTimeoutMs;
    this.sensitiveValues = sensitiveValues;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<TEvent> {
    if (!this.response.body) {
      throw new RunInfraStreamIncompleteError(undefined, this.requestId);
    }
    const reader = this.response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let dataLines: string[] = [];
    let readerDone = false;
    // Whether the end marker arrived: `[DONE]`, or a Responses `response.completed` event.
    let completed = false;

    const dispatchEvent = (): TEvent | null => {
      const payload = dataLines.join("\n").trim();
      dataLines = [];
      if (!payload) return null;
      if (payload === "[DONE]") {
        completed = true;
        return null;
      }
      let event: unknown;
      try {
        event = JSON.parse(payload);
      } catch {
        throw new RunInfraStreamParseError(undefined, this.requestId);
      }
      const failure = streamFailure(event, this.requestId);
      if (failure) throw failure;
      if (isPlainRecord(event) && event.type === "response.completed") completed = true;
      return event as TEvent;
    };

    const processLine = (line: string): TEvent | null => {
      const trimmed = line.endsWith("\r") ? line.slice(0, -1) : line;
      if (trimmed === "") return dispatchEvent();
      if (trimmed.startsWith(":")) return null;

      const separatorIndex = trimmed.indexOf(":");
      const field = separatorIndex === -1 ? trimmed : trimmed.slice(0, separatorIndex);
      let value = separatorIndex === -1 ? "" : trimmed.slice(separatorIndex + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "data") dataLines.push(value);
      return null;
    };
    const readChunk = async (): Promise<ReadableStreamReadResult<Uint8Array>> => {
      if (this.readTimeoutMs === undefined) return reader.read();
      let timeout: ReturnType<typeof setTimeout> | undefined;
      try {
        return await Promise.race([
          reader.read(),
          new Promise<never>((_, reject) => {
            timeout = setTimeout(() => {
              reject(new RunInfraTimeoutError(
                "RunInfra stream timed out while waiting for data",
                this.requestId,
              ));
            }, this.readTimeoutMs);
          }),
        ]);
      } finally {
        if (timeout !== undefined) clearTimeout(timeout);
      }
    };

    try {
      while (true) {
        const { done, value } = await readChunk();
        if (done) {
          readerDone = true;
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const parsed = processLine(line);
          if (parsed) yield parsed;
        }
      }

      buffer += decoder.decode();
      // What is left was not ended by a blank line. If it cannot be read and no end marker came before it, the
      // body ended inside an event: that is a cut stream, reported below, not a malformed event.
      const unfinished: TEvent[] = [];
      try {
        const lastLine = buffer ? processLine(buffer) : null;
        if (lastLine) unfinished.push(lastLine);
        const lastEvent = dataLines.length > 0 ? dispatchEvent() : null;
        if (lastEvent) unfinished.push(lastEvent);
      } catch (error) {
        if (!(error instanceof RunInfraStreamParseError) || completed) throw error;
      }
      for (const event of unfinished) yield event;
      // The body is over. Without the end marker the answer was cut short, whatever the HTTP status said.
      if (!completed) throw new RunInfraStreamIncompleteError(undefined, this.requestId);
    } catch (error) {
      throw normalizeTransportError(error, this.requestId, this.sensitiveValues);
    } finally {
      if (!readerDone) {
        try {
          await reader.cancel();
        } catch {
          // The stream may already be errored or closed by the runtime.
        }
      }
      try {
        reader.releaseLock();
      } catch {
        // Some runtimes release the lock while propagating stream errors.
      }
    }
  }
}

interface RequestOptions {
  method?: "GET" | "POST";
  body?: unknown;
  typedBodyKeys?: ReadonlySet<string>;
  rawBody?: BodyInit;
  rawContentType?: string;
  accept?: string;
  formData?: FormData;
  binary?: boolean;
  stream?: boolean;
  idempotentReplaySafe?: boolean;
  /**
   * A batch route. Its refusals keep the gateway's `reason` and `Retry-After`
   * on the typed error. A 409 is a final answer that is never retried, and a
   * 503 that asks for a wait above five seconds is raised at once.
   */
  batch?: boolean;
  /** The smallest timeout this call uses when the caller names none for it. */
  minDefaultTimeoutMs?: number;
}

function baseUrlAlreadyHasPipelineId(baseURL: string, pipelineId: string): boolean {
  const encodedPipelineId = encodeURIComponent(pipelineId);
  try {
    const parsed = new URL(baseURL);
    const lastSegment = stripTrailingSlashes(parsed.pathname).split("/").pop();
    return lastSegment === encodedPipelineId || decodeURIComponent(lastSegment ?? "") === pipelineId;
  } catch {
    const trimmed = stripTrailingSlashes(baseURL);
    return (
      trimmed.endsWith(`/${encodedPipelineId}`) ||
      trimmed.endsWith(`/${pipelineId}`)
    );
  }
}

function stripTrailingSlashes(value: string): string {
  let end = value.length;
  while (end > 0 && value.charCodeAt(end - 1) === 47) {
    end -= 1;
  }
  return end === value.length ? value : value.slice(0, end);
}

function validateBaseURL(baseURL: unknown): string {
  if (typeof baseURL !== "string") {
    throw invalidRequestOption("baseURL must be a string");
  }
  const trimmed = stripTrailingSlashes(baseURL.trim());
  try {
    const parsed = new URL(trimmed);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
      throw new Error("unsupported protocol");
    }
    if (!parsed.host) {
      throw new Error("missing host");
    }
    if (parsed.username || parsed.password) {
      throw new RunInfraError("baseURL must not include credentials", {
        status: 0,
        type: "invalid_request_options",
      });
    }
    if (parsed.search || parsed.hash) {
      throw new RunInfraError("baseURL must not include query strings or fragments", {
        status: 0,
        type: "invalid_request_options",
      });
    }
    if (parsed.protocol === "http:" && !isLocalBaseURLHost(parsed.hostname)) {
      throw new RunInfraError("Remote baseURL must use https", {
        status: 0,
        type: "invalid_request_options",
      });
    }
    return trimmed;
  } catch (error) {
    if (error instanceof RunInfraError) throw error;
    throw new RunInfraError("baseURL must be an http or https URL", {
      status: 0,
      type: "invalid_request_options",
    });
  }
}

function isLocalBaseURLHost(hostname: string): boolean {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/gu, "");
  return (
    normalized === "localhost" ||
    normalized === "127.0.0.1" ||
    normalized === "0.0.0.0" ||
    normalized === "::1"
  );
}

function normalizeBaseURL(baseURL: string, pipelineId?: string | null): string {
  const trimmed = validateBaseURL(baseURL);
  if (pipelineId === undefined || pipelineId === null) return trimmed;
  const validatedPipelineId = validateSdkIdentifierHeader(pipelineId, "pipelineId");
  if (baseUrlAlreadyHasPipelineId(trimmed, validatedPipelineId)) return trimmed;
  return `${trimmed}/${encodeURIComponent(validatedPipelineId)}`;
}

function baseUrlLooksPipelineScoped(baseURL: string): boolean {
  const parsed = new URL(baseURL);
  const segments = parsed.pathname.split("/").filter(Boolean);
  const lastV1 = segments.lastIndexOf("v1");
  if (lastV1 >= 0) return segments.length > lastV1 + 1;
  return segments.length > 0;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status === 500 || status === 502 || status === 503 || status === 504;
}

function validateSdkHeader(value: string, name: string, maxLength = 512): string {
  if (value.length > maxLength || /[^\x20-\x7E]/u.test(value)) {
    throw new RunInfraError(`${name} must be ASCII and ${maxLength} characters or less`, {
      status: 0,
      type: "invalid_request_options",
    });
  }
  return value;
}

function validateSdkIdentifierHeader(value: unknown, name: string, maxLength = 512): string {
  if (typeof value !== "string") {
    throw invalidRequestOption(`${name} must be a string`);
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw new RunInfraError(`${name} must not be blank`, {
      status: 0,
      type: "invalid_request_options",
    });
  }
  return validateSdkHeader(trimmed, name, maxLength);
}

function validateSdkModel(value: unknown): string {
  if (typeof value !== "string") {
    throw invalidRequestOption("model must be a string");
  }
  return validateSdkIdentifierHeader(value, "model");
}

function withValidatedModel<TRequest extends { model: unknown }>(
  request: TRequest,
): Omit<TRequest, "model"> & { model: string } {
  return {
    ...request,
    model: validateSdkModel(request.model),
  };
}

function validateRequestFields(
  request: unknown,
  allowedKeys: ReadonlySet<string>,
  label: string,
): asserts request is Record<string, unknown> {
  if (!isPlainRecord(request)) {
    throw invalidRequestOption(`${label} request must be an object`);
  }
  for (const key of Object.keys(request)) {
    if (!allowedKeys.has(key)) {
      throw invalidRequestOption(`Unknown ${label} request field: ${key}`);
    }
  }
}

function validateNonEmptyStringField(value: unknown, name: string): string {
  if (typeof value !== "string") {
    throw invalidRequestOption(`${name} must be a string`);
  }
  if (!value.trim()) {
    throw invalidRequestOption(`${name} must be a non-empty string`);
  }
  return value;
}

function validateSpeechReference(body: Record<string, unknown>): void {
  const voice = body.voice;
  if (voice !== undefined) {
    validateNonEmptyStringField(voice, "voice");
    return;
  }

  const refAudio = body.ref_audio;
  const refText = body.ref_text;
  if (refAudio !== undefined || refText !== undefined) {
    validateNonEmptyStringField(refAudio, "ref_audio");
    validateNonEmptyStringField(refText, "ref_text");
    return;
  }

  throw invalidRequestOption(
    "speech requests require either voice, or both ref_audio and ref_text",
  );
}

function validateChatMessages(value: unknown): void {
  if (!Array.isArray(value) || value.length === 0) {
    throw invalidRequestOption("messages must be a non-empty array");
  }
  for (const [index, message] of value.entries()) {
    if (
      !isPlainRecord(message) ||
      typeof message.role !== "string" ||
      !message.role.trim()
    ) {
      throw invalidRequestOption(`messages[${index}] must be an object with a non-empty role`);
    }
  }
}

function validateResponsesInput(value: unknown): void {
  if (typeof value === "string" && value.trim()) return;
  if (Array.isArray(value) && value.length > 0) {
    for (const [index, item] of value.entries()) {
      if (!isPlainRecord(item)) {
        throw invalidRequestOption(`input[${index}] must be an object`);
      }
    }
    return;
  }
  throw invalidRequestOption("input must be a non-empty string or array");
}

function validateEmbeddingInput(value: unknown): void {
  if (typeof value === "string" && value.trim()) return;
  if (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((item) => typeof item === "string" && item.trim().length > 0)
  ) {
    return;
  }
  throw invalidRequestOption("input must be a non-empty string or array of strings");
}

function validateEmbeddingResponseOptions(body: Record<string, unknown>): void {
  if (body.encoding_format !== undefined && body.encoding_format !== "float") {
    throw invalidRequestOption(
      "embedding encoding_format must be float for native SDK typed responses",
    );
  }
  if (
    body.dimensions !== undefined &&
    (
      typeof body.dimensions !== "number" ||
      !Number.isSafeInteger(body.dimensions) ||
      body.dimensions <= 0
    )
  ) {
    throw invalidRequestOption("embedding dimensions must be a positive integer");
  }
}

function validateBlobFile(value: unknown): Blob {
  if (!(value instanceof Blob)) {
    throw invalidRequestOption("file must be a Blob");
  }
  if (value.size === 0) {
    throw invalidRequestOption("file must not be empty");
  }
  return value;
}

function validateVoicePipelineAudio(value: unknown): BodyInit {
  if (value instanceof Blob) {
    if (value.size === 0) throw invalidRequestOption("audio must not be empty");
    return value;
  }
  if (value instanceof ArrayBuffer) {
    if (value.byteLength === 0) throw invalidRequestOption("audio must not be empty");
    return value;
  }
  if (value instanceof Uint8Array) {
    if (value.byteLength === 0) throw invalidRequestOption("audio must not be empty");
    const copy = new ArrayBuffer(value.byteLength);
    new Uint8Array(copy).set(value);
    return copy;
  }
  throw invalidRequestOption("audio must be a Blob, ArrayBuffer, or Uint8Array");
}

function validateMimeType(value: unknown, fallback = "audio/wav"): string {
  if (value === undefined) return fallback;
  if (typeof value !== "string") {
    throw invalidRequestOption("mimeType must be a string");
  }
  const trimmed = value.trim();
  if (!trimmed) {
    throw invalidRequestOption("mimeType must not be blank");
  }
  return validateSdkHeader(trimmed, "mimeType", 255);
}

function validateMultipartFilename(value: string): string {
  if (typeof value !== "string") {
    throw invalidRequestOption("filename must be a string");
  }
  if (!value.trim()) {
    throw invalidRequestOption("filename must not be blank");
  }
  validateSdkHeader(value, "filename", 255);
  if (/["\\]/u.test(value)) {
    throw invalidRequestOption("filename must not contain quotes or backslashes");
  }
  return value;
}

function validateMultipartFieldValue(value: unknown): string {
  if (
    typeof value !== "string" &&
    typeof value !== "number" &&
    typeof value !== "boolean"
  ) {
    throw invalidRequestOption("multipart field values must be strings, numbers, or booleans");
  }
  if (typeof value === "number" && !Number.isFinite(value)) {
    throw invalidRequestOption("multipart field values must contain only finite numbers");
  }
  return String(value);
}

function validateTranscriptionResponseFormat(body: { response_format?: unknown }): void {
  const responseFormat = body.response_format;
  if (
    responseFormat !== undefined &&
    responseFormat !== "json" &&
    responseFormat !== "verbose_json"
  ) {
    throw invalidRequestOption(
      "audio transcription response_format must be json or verbose_json for native SDK typed responses",
    );
  }
}

function validateTranscriptionRequestKeys(request: TranscriptionRequest): void {
  for (const key of Object.keys(request as unknown as Record<string, unknown>)) {
    if (!TRANSCRIPTION_REQUEST_KEYS.has(key)) {
      throw invalidRequestOption(`Unknown audio transcription request field: ${key}`);
    }
  }
}

/** `batches.create()` tests the destination before it answers, which can take 20 seconds. */
const BATCH_CREATE_MIN_DEFAULT_TIMEOUT_MS = 30_000;

function validateBatchCreateRequest(body: Record<string, unknown>): void {
  validateNonEmptyStringField(body.input_url, "input_url");
  const destination = body.destination;
  if (!isPlainRecord(destination)) {
    throw invalidRequestOption("destination must be an object");
  }
  validateNonEmptyStringField(destination.type, "destination.type");
  validateNonEmptyStringField(destination.url, "destination.url");
  if (typeof body.max_cost_cents !== "number" || !Number.isSafeInteger(body.max_cost_cents)) {
    throw invalidRequestOption("max_cost_cents must be an integer");
  }
  if (
    body.window_hours !== undefined &&
    (typeof body.window_hours !== "number" || !Number.isSafeInteger(body.window_hours))
  ) {
    throw invalidRequestOption("window_hours must be an integer");
  }
  if (body.name !== undefined && typeof body.name !== "string") {
    throw invalidRequestOption("name must be a string");
  }
}

function batchListQuery(params: unknown): string {
  if (params === undefined) return "";
  if (!isPlainRecord(params)) {
    throw invalidRequestOption("batch list params must be an object");
  }
  for (const key of Object.keys(params)) {
    if (!(BATCH_LIST_PARAM_KEYS as readonly string[]).includes(key)) {
      throw invalidRequestOption(`Unknown batch list param: ${key}`);
    }
  }
  const query = new URLSearchParams();
  for (const key of BATCH_LIST_PARAM_KEYS) {
    const value = params[key];
    if (value === undefined) continue;
    if (key === "limit") {
      if (typeof value !== "number" || !Number.isSafeInteger(value)) {
        throw invalidRequestOption("limit must be an integer");
      }
      query.set(key, String(value));
      continue;
    }
    query.set(key, validateNonEmptyStringField(value, key));
  }
  const text = query.toString();
  return text ? `?${text}` : "";
}

function batchPath(batchId: unknown, suffix = ""): string {
  return `/batches/${encodeURIComponent(validateSdkIdentifierHeader(batchId, "batchId"))}${suffix}`;
}

const JSON_BODY_ERROR = "JSON request body must be JSON-serializable and contain only finite numbers";

function sanitizeJsonValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || typeof value === "string" || typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalidRequestOption(JSON_BODY_ERROR);
    return value;
  }
  if (value === undefined) return undefined;
  if (typeof value === "bigint" || typeof value === "function" || typeof value === "symbol") {
    throw invalidRequestOption(JSON_BODY_ERROR);
  }
  if (Array.isArray(value)) {
    if (seen.has(value)) throw invalidRequestOption(JSON_BODY_ERROR);
    seen.add(value);
    const sanitized = value.map((item) => {
      const sanitized = sanitizeJsonValue(item, seen);
      if (sanitized === undefined) throw invalidRequestOption(JSON_BODY_ERROR);
      return sanitized;
    });
    seen.delete(value);
    return sanitized;
  }
  if (!isPlainRecord(value)) throw invalidRequestOption(JSON_BODY_ERROR);
  if (seen.has(value)) throw invalidRequestOption(JSON_BODY_ERROR);
  seen.add(value);
  const sanitized: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    const sanitizedItem = sanitizeJsonValue(item, seen);
    if (sanitizedItem !== undefined) sanitized[key] = sanitizedItem;
  }
  seen.delete(value);
  return sanitized;
}

function encodeJsonBody(payload: unknown): string {
  return JSON.stringify(sanitizeJsonValue(payload));
}

function mergeExtraJsonBody(
  payload: unknown,
  extraBody: unknown,
  typedKeys: ReadonlySet<string> = new Set(),
): unknown {
  if (extraBody === undefined) return payload;
  if (!isPlainRecord(extraBody)) {
    throw invalidRequestOption("extraBody must be an object");
  }
  if (!isPlainRecord(payload)) {
    throw invalidRequestOption("extraBody can only be used with JSON object request bodies");
  }
  const merged = { ...payload };
  for (const [key, value] of Object.entries(extraBody)) {
    if (!key.trim()) {
      throw invalidRequestOption("extraBody keys must be non-empty strings");
    }
    if (typedKeys.has(key) || key in payload) {
      throw invalidRequestOption(`extraBody must not override typed request field: ${key}`);
    }
    merged[key] = value;
  }
  return merged;
}

function invalidRequestOption(message: string): RunInfraError {
  return new RunInfraError(message, {
    status: 0,
    type: "invalid_request_options",
  });
}

function validatePositiveNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw invalidRequestOption(`${name} must be a positive number`);
  }
  return value;
}

function validateNonNegativeNumber(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw invalidRequestOption(`${name} must be a non-negative number`);
  }
  return value;
}

function validateNonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw invalidRequestOption(`${name} must be a non-negative integer`);
  }
  return value;
}

const SDK_CONTROLLED_HEADERS = new Set([
  "authorization",
  "api-key",
  "connection",
  "content-type",
  "content-length",
  "cookie",
  "forwarded",
  "host",
  "idempotency-key",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
  "via",
  "x-access-token",
  "x-api-key",
  "x-auth-token",
  "x-client-request-id",
  "x-forwarded-for",
  "x-forwarded-host",
  "x-forwarded-proto",
  "x-runinfra-sdk",
  "x-runinfra-sdk-version",
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function validateCustomHeaders(headers: unknown): Record<string, string> {
  if (headers === undefined) return {};
  if (!isPlainRecord(headers)) {
    throw invalidRequestOption("headers must be an object with string names and values");
  }
  const validated: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    const normalizedName = name.trim().toLowerCase();
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name)) {
      throw new RunInfraError(`Invalid custom header name: ${name}`, {
        status: 0,
        type: "invalid_request_options",
      });
    }
    if (SDK_CONTROLLED_HEADERS.has(normalizedName)) {
      throw new RunInfraError(`${name} is controlled by the RunInfra SDK`, {
        status: 0,
        type: "invalid_request_options",
      });
    }
    if (typeof value !== "string") {
      throw new RunInfraError(`${name} header value must be a string`, {
        status: 0,
        type: "invalid_request_options",
      });
    }
    validated[name] = validateSdkHeader(value, name);
  }
  return validated;
}

const REQUEST_OPTION_KEYS = new Set([
  "clientRequestId",
  "idempotencyKey",
  "timeoutMs",
  "maxRetries",
  "retryBaseMs",
  "headers",
  "extraBody",
]);

function validateRequestOptions(requestOptions: unknown): RunInfraRequestOptions {
  if (requestOptions === undefined) return {};
  if (!isPlainRecord(requestOptions)) {
    throw invalidRequestOption("requestOptions must be an object");
  }
  for (const key of Object.keys(requestOptions)) {
    if (!REQUEST_OPTION_KEYS.has(key)) {
      throw invalidRequestOption(`Unknown request option: ${key}`);
    }
  }
  return requestOptions as RunInfraRequestOptions;
}

const RUNINFRA_OPTION_KEYS = new Set([
  "apiKey",
  "pipelineId",
  "baseURL",
  "timeoutMs",
  "maxRetries",
  "retryBaseMs",
  "fetch",
  "dangerouslyAllowBrowser",
]);

function validateRunInfraOptions(options: RunInfraOptions): void {
  for (const key of Object.keys(options)) {
    if (!RUNINFRA_OPTION_KEYS.has(key)) {
      throw invalidRequestOption(`Unknown RunInfra option: ${key}`);
    }
  }
  if (
    options.dangerouslyAllowBrowser !== undefined &&
    typeof options.dangerouslyAllowBrowser !== "boolean"
  ) {
    throw invalidRequestOption("dangerouslyAllowBrowser must be a boolean");
  }
}

function generatedClientRequestId(): string {
  const randomUUID = globalThis.crypto?.randomUUID;
  if (randomUUID) return randomUUID.call(globalThis.crypto);
  return `runinfra-${Date.now()}-${Math.random().toString(16).slice(2)}`;
}

function isBrowserRuntime(): boolean {
  const runtime = globalThis as typeof globalThis & {
    document?: unknown;
    self?: unknown;
    window?: unknown;
    WorkerGlobalScope?: unknown;
  };
  if (
    typeof runtime.window === "object" &&
    runtime.window !== null &&
    typeof runtime.document === "object" &&
    runtime.document !== null
  ) {
    return true;
  }
  const workerGlobalScope = runtime.WorkerGlobalScope;
  if (
    typeof workerGlobalScope !== "function" ||
    typeof runtime.self !== "object" ||
    runtime.self === null
  ) {
    return false;
  }
  const prototype = (workerGlobalScope as { prototype?: unknown }).prototype;
  return typeof prototype === "object" &&
    prototype !== null &&
    Object.prototype.isPrototypeOf.call(prototype, runtime.self);
}

/** `Retry-After-Ms`: the wait in milliseconds, a plain non-negative number. */
function retryAfterMsHeader(response: Response): number | null {
  const value = response.headers.get("retry-after-ms");
  if (!value) return null;
  const trimmed = value.trim();
  if (!/^[0-9]+(?:\.[0-9]+)?$/u.test(trimmed)) return null;
  const milliseconds = Number(trimmed);
  return Number.isFinite(milliseconds) ? Math.ceil(milliseconds) : null;
}

/** `Retry-After`: whole seconds, or an HTTP date. */
function retryAfterHeader(response: Response): number | null {
  const value = response.headers.get("retry-after");
  if (!value) return null;
  const trimmed = value.trim();
  if (/^[0-9]+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (Number.isSafeInteger(seconds)) return seconds * 1000;
    return null;
  }
  if (/^(?:[+-]|\d)/.test(trimmed)) return null;
  const dateMs = Date.parse(trimmed);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return null;
}

/**
 * The wait the API named with a response, in milliseconds. `Retry-After-Ms` is
 * read first, because it can name a wait shorter than a second; `Retry-After`
 * is read when the millisecond header is missing or malformed.
 */
function retryAfterMs(response: Response): number | null {
  return retryAfterMsHeader(response) ?? retryAfterHeader(response);
}

/**
 * What the API said about asking again: the `x-should-retry` header, and
 * `retryable` inside the error object. An explicit `false` from either wins.
 * `undefined` when the API said nothing.
 */
function retryMarker(response: Response, bodyRetryable?: boolean): boolean | undefined {
  const header = response.headers.get("x-should-retry")?.trim().toLowerCase();
  const headerRetryable = header === "true" ? true : header === "false" ? false : undefined;
  if (headerRetryable === false || bodyRetryable === false) return false;
  if (headerRetryable === true || bodyRetryable === true) return true;
  return undefined;
}

/** The SDK's own wait before it asks again when the API named none: exponential, with jitter, at most 30 seconds. */
function backoffDelayMs(attempt: number, baseMs: number): number {
  if (baseMs <= 0) return 0;
  const exponential = baseMs * 2 ** Math.max(0, attempt - 1);
  const jitter = Math.random() * baseMs;
  return Math.min(30_000, exponential + jitter);
}

/** The longest `Retry-After` a batch route's 503 is waited for. A longer wait is the caller's to plan. */
const BATCH_MAX_AUTOMATIC_RETRY_AFTER_MS = 5_000;

/**
 * Whether a failed response may be asked again, for a call that is safe to
 * send again. The API's own word decides when it gave one: `false` never,
 * `true` whatever the status. Without it the status decides. A 409 from a
 * batch route is always final.
 */
function failedResponseMayBeAskedAgain(response: Response, retryable: boolean | undefined, batch: boolean): boolean {
  if (batch && response.status === 409) return false;
  if (retryable !== undefined) return retryable;
  return isRetryableStatus(response.status);
}

/**
 * The longest wait named by the API that the SDK sleeps for before it asks
 * again. A wait above it is raised at once with the wait on the error, so a
 * call never blocks for minutes and never asks again sooner than it was told.
 */
function maxAutomaticRetryAfterMs(response: Response, batch: boolean): number {
  return batch && response.status === 503 ? BATCH_MAX_AUTOMATIC_RETRY_AFTER_MS : MAX_AUTOMATIC_RETRY_AFTER_MS;
}

async function parseError(response: Response): Promise<{
  message: string;
  type: string;
  code?: string;
  param?: string;
  reason?: string;
  retryable?: boolean;
  currentBalanceCents?: number;
  requiredCents?: number;
  topupUrl?: string;
}> {
  try {
    const body = (await response.json()) as {
      error?: {
        message?: unknown;
        type?: unknown;
        code?: unknown;
        param?: unknown;
        reason?: unknown;
        retryable?: unknown;
        current_balance_cents?: unknown;
        required_cents?: unknown;
        topup_url?: unknown;
      };
    };
    const error = body.error ?? {};
    return {
      message:
        typeof error.message === "string"
          ? error.message
          : `RunInfra request failed with status ${response.status}`,
      type: typeof error.type === "string" ? error.type : "api_error",
      ...(typeof error.code === "string" ? { code: error.code } : {}),
      ...(typeof error.param === "string" ? { param: error.param } : {}),
      ...(typeof error.reason === "string" ? { reason: error.reason } : {}),
      ...(typeof error.retryable === "boolean" ? { retryable: error.retryable } : {}),
      // Structured remediation fields the gateway ships on 402 insufficient_credits.
      ...(typeof error.current_balance_cents === "number" && Number.isFinite(error.current_balance_cents)
        ? { currentBalanceCents: error.current_balance_cents }
        : {}),
      ...(typeof error.required_cents === "number" && Number.isFinite(error.required_cents)
        ? { requiredCents: error.required_cents }
        : {}),
      ...(typeof error.topup_url === "string" ? { topupUrl: error.topup_url } : {}),
    };
  } catch {
    return {
      message: `RunInfra request failed with status ${response.status}`,
      type: "api_error",
    };
  }
}

/**
 * Reads a failed response's error body, giving up when the call's own timeout
 * fires first. The body is read before the SDK decides whether to ask again,
 * because the API can mark a failure as retryable or not inside it.
 */
async function parseErrorWithin(
  response: Response,
  signal: AbortSignal,
): Promise<Awaited<ReturnType<typeof parseError>>> {
  if (signal.aborted) throw new DOMException("The operation was aborted.", "AbortError");
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      parseError(response),
      new Promise<never>((_, reject) => {
        onAbort = () => reject(new DOMException("The operation was aborted.", "AbortError"));
        signal.addEventListener("abort", onAbort, { once: true });
      }),
    ]);
  } finally {
    if (onAbort) signal.removeEventListener("abort", onAbort);
  }
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort cleanup: the body may already be read, locked or closed.
  }
}

/**
 * Sets what an error carries beyond its class: the wait the API named, what
 * the API said about asking again, a batch refusal's cause word, and the
 * request id the SDK sent. Assigned after construction so no error class
 * changes its constructor.
 */
function withErrorFacts<TError extends RunInfraError>(
  error: TError,
  facts: { reason?: string; retryAfterMs?: number; retryable?: boolean; clientRequestId?: string },
): TError {
  const target = error as { reason?: string; retryAfterMs?: number; retryable?: boolean; clientRequestId?: string };
  if (facts.reason !== undefined) target.reason = facts.reason;
  if (facts.retryAfterMs !== undefined) target.retryAfterMs = facts.retryAfterMs;
  if (facts.retryable !== undefined) target.retryable = facts.retryable;
  if (facts.clientRequestId !== undefined) target.clientRequestId = facts.clientRequestId;
  return error;
}

/**
 * A batch route's refusal as the SDK's typed error. The class follows the HTTP
 * status as on every route, with one difference: only `model_not_sold` is a
 * `ModelNotFoundError` (an unknown batch id is a plain 404 `RunInfraError`
 * that keeps the gateway's own type).
 */
function batchRefusalError(
  response: Response,
  parsed: Awaited<ReturnType<typeof parseError>>,
  requestId?: string,
): RunInfraError {
  const { message, type, code, param, currentBalanceCents, requiredCents, topupUrl } = parsed;
  const status = response.status;
  if (status === 401) return new AuthenticationError(message, status, requestId, code, param);
  if (status === 403) {
    return new PermissionDeniedError(
      message,
      status,
      requestId,
      code,
      param,
      type !== "api_error" ? type : "permission_denied",
    );
  }
  if (status === 402) {
    return new InsufficientCreditsError(message, status, requestId, code, param, {
      currentBalanceCents,
      requiredCents,
      topupUrl,
    });
  }
  if (status === 404 && code === "model_not_sold") {
    return new ModelNotFoundError(message, status, requestId, code, param);
  }
  if (status === 429) return new RateLimitError(message, status, requestId, undefined, code, param);
  return new RunInfraError(message, { status, type, requestId, code, param });
}

function routeError(
  response: Response,
  parsed: Awaited<ReturnType<typeof parseError>>,
  requestId?: string,
): RunInfraError {
  const { message, type, code, param, currentBalanceCents, requiredCents, topupUrl } = parsed;
  if (response.status === 401) return new AuthenticationError(message, response.status, requestId, code, param);
  if (response.status === 403) {
    // Keep a more specific gateway discriminator (e.g. "byoc_plan_required")
    // on `.type` so callers can branch instead of regex-scraping the message.
    return new PermissionDeniedError(
      message,
      response.status,
      requestId,
      code,
      param,
      type !== "api_error" ? type : "permission_denied",
    );
  }
  if (response.status === 402) {
    return new InsufficientCreditsError(message, response.status, requestId, code, param, {
      currentBalanceCents,
      requiredCents,
      topupUrl,
    });
  }
  if (response.status === 404 || type === "model_not_found") {
    return new ModelNotFoundError(message, response.status, requestId, code, param);
  }
  if (response.status === 429) {
    return new RateLimitError(message, response.status, requestId, undefined, code, param);
  }
  if (type === "deployment_error") return new DeploymentError(message, response.status, requestId, code, param);
  return new RunInfraError(message, { status: response.status, type, requestId, code, param });
}

/**
 * A failed response as the SDK's typed error. Whatever its class and status,
 * the error keeps the wait the API named (`Retry-After-Ms`, else
 * `Retry-After`) and what the API said about asking again (`x-should-retry`,
 * `error.retryable`). A batch route's refusal also keeps its cause word.
 */
function errorFromResponse(
  response: Response,
  parsed: Awaited<ReturnType<typeof parseError>>,
  batch: boolean,
): RunInfraError {
  const requestId = response.headers.get("x-request-id") ?? undefined;
  const error = batch ? batchRefusalError(response, parsed, requestId) : routeError(response, parsed, requestId);
  return withErrorFacts(error, {
    reason: batch ? parsed.reason : undefined,
    retryAfterMs: retryAfterMs(response) ?? undefined,
    retryable: retryMarker(response, parsed.retryable),
  });
}

async function parseJsonResponse<TResponse>(
  response: Response,
  sensitiveValues: readonly string[] = [],
): Promise<TResponse> {
  const requestId = response.headers.get("x-request-id") ?? undefined;
  const idempotentReplay =
    response.headers.get("x-runinfra-idempotent-replay")?.trim().toLowerCase() === "true";
  let payload: unknown;
  try {
    payload = await response.json();
  } catch (error) {
    throw new ResponseBodyReadError(normalizeTransportError(error, requestId, sensitiveValues));
  }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return {
      ...(payload as Record<string, unknown>),
      ...(requestId ? { _request_id: requestId } : {}),
      ...(idempotentReplay ? { _idempotent_replay: true } : {}),
    } as TResponse;
  }
  throw new RunInfraError(
    `RunInfra JSON response shape error: expected object, got ${jsonPayloadKind(payload)}.`,
    {
      status: response.status,
      type: "response_shape_error",
      requestId,
    },
  );
}

function jsonPayloadKind(payload: unknown): string {
  if (payload === null) return "null";
  if (Array.isArray(payload)) return "array";
  return typeof payload;
}

class ResponseBodyReadError extends Error {
  readonly error: RunInfraError;

  constructor(error: RunInfraError) {
    super(error.message);
    this.name = "ResponseBodyReadError";
    this.error = error;
  }
}

function redactSensitiveValues(message: string, sensitiveValues: readonly string[] = []): string {
  let redacted = message;
  for (const value of sensitiveValues) {
    if (value) redacted = redacted.split(value).join("[redacted]");
  }
  return redacted;
}

function redactRunInfraError(error: RunInfraError, sensitiveValues: readonly string[]): RunInfraError {
  const redacted = redactedRunInfraErrorCopy(error, sensitiveValues);
  // The wait, the retry marker, a batch refusal's cause and the request id the SDK sent ride every error
  // class; the copy rebuilds each class from its own constructor, which names none of them for most.
  return withErrorFacts(redacted, {
    reason: error.reason === undefined ? undefined : redactSensitiveValues(error.reason, sensitiveValues),
    retryAfterMs: redacted.retryAfterMs === undefined ? error.retryAfterMs : undefined,
    retryable: redacted.retryable === undefined ? error.retryable : undefined,
    clientRequestId: redacted.clientRequestId === undefined ? error.clientRequestId : undefined,
  });
}

function redactedRunInfraErrorCopy(error: RunInfraError, sensitiveValues: readonly string[]): RunInfraError {
  const message = redactSensitiveValues(error.message, sensitiveValues);
  const code = error.code === undefined ? undefined : redactSensitiveValues(error.code, sensitiveValues);
  const param = error.param === undefined ? undefined : redactSensitiveValues(error.param, sensitiveValues);
  if (error instanceof AuthenticationError) {
    return new AuthenticationError(message, error.status, error.requestId, code, param);
  }
  if (error instanceof PermissionDeniedError) {
    // Preserve the gateway discriminator (e.g. "byoc_plan_required") through redaction.
    return new PermissionDeniedError(message, error.status, error.requestId, code, param, error.type);
  }
  if (error instanceof RateLimitError) {
    return new RateLimitError(message, error.status, error.requestId, error.retryAfterMs, code, param);
  }
  if (error instanceof InsufficientCreditsError) {
    // Carry the structured top-up fields through redaction (they hold no secrets).
    return new InsufficientCreditsError(message, error.status, error.requestId, code, param, {
      currentBalanceCents: error.currentBalanceCents,
      requiredCents: error.requiredCents,
      topupUrl: error.topupUrl,
    });
  }
  if (error instanceof DeploymentError) {
    return new DeploymentError(message, error.status, error.requestId, code, param);
  }
  if (error instanceof ModelNotFoundError) {
    return new ModelNotFoundError(message, error.status, error.requestId, code, param);
  }
  if (error instanceof RunInfraTimeoutError) return new RunInfraTimeoutError(message, error.requestId);
  if (error instanceof RunInfraConnectionError) return new RunInfraConnectionError(message, error.requestId);
  if (error instanceof RunInfraStreamParseError) return new RunInfraStreamParseError(message, error.requestId);
  if (error instanceof RunInfraStreamIncompleteError) {
    return new RunInfraStreamIncompleteError(message, error.requestId);
  }
  if (error instanceof RunInfraStreamError) {
    return new RunInfraStreamError(message, { type: error.type, requestId: error.requestId, code, param });
  }
  if (error instanceof UnsupportedOperationError) return new UnsupportedOperationError(message);
  if (error instanceof WebhookVerificationError) return new WebhookVerificationError(message);
  return new RunInfraError(message, {
    status: error.status,
    type: error.type,
    requestId: error.requestId,
    retryAfterMs: error.retryAfterMs,
    code,
    param,
  });
}

function normalizeTransportError(
  error: unknown,
  requestId?: string,
  sensitiveValues: readonly string[] = [],
): RunInfraError {
  if (error instanceof RunInfraError) return redactRunInfraError(error, sensitiveValues);
  if (
    error instanceof DOMException &&
    error.name === "AbortError"
  ) {
    return new RunInfraTimeoutError(redactSensitiveValues(error.message, sensitiveValues), requestId);
  }
  if (error instanceof Error && error.name === "AbortError") {
    return new RunInfraTimeoutError(redactSensitiveValues(error.message, sensitiveValues), requestId);
  }
  const message = redactSensitiveValues(error instanceof Error ? error.message : String(error), sensitiveValues);
  return new RunInfraConnectionError(message, requestId);
}

export class RunInfra {
  readonly chat: {
    completions: {
      create: ChatCompletionsCreate;
    };
  };

  readonly embeddings: {
    create: (request: EmbeddingRequest, options?: RunInfraRequestOptions) => Promise<EmbeddingResponse>;
  };

  readonly responses: {
    create: ResponsesCreate;
  };

  /**
   * Audio surfaces (text-to-speech + speech-to-text).
   *
   * Preview helpers for deployed RunInfra audio routes. The HTTP envelope
   * matches the OpenAI Audio API contract and the request/response shapes are
   * stable. Supported voices, reference-audio modes, and response formats are
   * deployment-specific.
   */
  readonly audio: {
    speech: {
      create: (request: SpeechRequest, options?: RunInfraRequestOptions) => Promise<RunInfraAudioResponse>;
    };
    transcriptions: {
      create: (request: TranscriptionRequest, options?: RunInfraRequestOptions) => Promise<TranscriptionResponse>;
    };
  };

  readonly models: {
    list: (options?: RunInfraRequestOptions) => Promise<ModelListResponse>;
    retrieve: (model: string, options?: RunInfraRequestOptions) => Promise<ModelObject>;
  };

  /**
   * Image generation surface.
   *
   * Preview helper for deployed RunInfra image routes. The HTTP envelope
   * matches the OpenAI Images API contract. Supported size, response format,
   * quality, style, and user fields depend on the selected deployment.
   */
  readonly images: {
    generate: (request: ImageGenerateRequest, options?: RunInfraRequestOptions) => Promise<ImageGenerationResponse>;
  };

  /**
   * Batch jobs.
   *
   * Preview. A job takes a JSONL file of chat completion requests and posts
   * each answer, signed, to your webhook address. A job has a window of 24
   * hours. Lines run when the model has spare capacity. A line the job has
   * not run when its window ends is counted `expired` and is not charged. Use
   * a workspace-scoped key; verify deliveries with `verifyBatchDelivery`.
   */
  readonly batches: {
    /**
     * Creates a job, which then starts by itself. The gateway first posts a
     * signed test delivery to `destination.url`, so this call can take 20
     * seconds: its default timeout is never below 30 seconds. Pass
     * `idempotencyKey` to make the call safe to retry; without one it is sent
     * once. Sending the same create again with the same key and the same body
     * answers the earlier job as a normal success: no error and no second
     * job. The same key with a different body is refused with 409.
     */
    create: (request: BatchCreateRequest, options?: RunInfraRequestOptions) => Promise<BatchCreateResponse>;
    /** Lists the workspace's jobs, newest first. Page with `next_cursor`. */
    list: (params?: BatchListParams, options?: RunInfraRequestOptions) => Promise<BatchListResponse>;
    /** Reads one job with the lines its check refused and its quote. */
    retrieve: (batchId: string, options?: RunInfraRequestOptions) => Promise<BatchRetrieveResponse>;
    /** Cancels a job: `cancelled` when no line had run, else `cancelling` while lines in flight settle. Sent once, never retried. */
    cancel: (batchId: string, options?: RunInfraRequestOptions) => Promise<BatchCancelResponse>;
  };

  readonly webhooks: {
    verifySignature: typeof verifyWebhookSignature;
    constructEvent: typeof constructWebhookEvent;
  };

  /**
   * Voice pipeline surface.
   *
   * Preview helper for co-located voice pipelines. It requires a
   * pipeline-scoped client and posts binary audio to `/pipeline`; transcript
   * and response behavior depends on the selected deployment.
   */
  readonly voice: {
    pipeline: {
      create: (request: VoicePipelineRequest, options?: RunInfraRequestOptions) => Promise<VoicePipelineResponse>;
    };
  };

  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly hasPipelineScope: boolean;
  /** The caller's own client timeout. Left unset, each call uses the default of its kind. */
  private readonly timeoutMs?: number;
  private readonly maxRetries: number;
  private readonly retryBaseMs: number;
  private readonly fetcher: typeof fetch;

  constructor(options: RunInfraOptions) {
    if (!options || typeof options !== "object") {
      throw invalidRequestOption("RunInfra options are required");
    }
    validateRunInfraOptions(options);
    if (typeof options.apiKey !== "string") {
      throw invalidRequestOption("apiKey must be a string");
    }
    const apiKey = options.apiKey.trim();
    if (!apiKey) {
      throw new AuthenticationError("apiKey is required", 401);
    }
    const validatedApiKey = validateSdkHeader(apiKey, "apiKey");
    if (isBrowserRuntime() && !options.dangerouslyAllowBrowser) {
      throw new RunInfraError(
        "RunInfra SDK is intended for server-side environments because API keys are bearer secrets. Pass dangerouslyAllowBrowser: true only if you understand the risk.",
        { status: 0, type: "invalid_runtime" },
      );
    }
    this.apiKey = validatedApiKey;
    const normalizedBaseURL = normalizeBaseURL(
      options.baseURL ?? "https://api.runinfra.ai/v1",
      options.pipelineId,
    );
    this.baseURL = normalizedBaseURL;
    this.hasPipelineScope = Boolean(options.pipelineId) || baseUrlLooksPipelineScoped(normalizedBaseURL);
    this.timeoutMs = options.timeoutMs === undefined || options.timeoutMs === null
      ? undefined
      : validatePositiveNumber(options.timeoutMs, "timeoutMs");
    this.maxRetries = validateNonNegativeInteger(options.maxRetries ?? 2, "maxRetries");
    this.retryBaseMs = validateNonNegativeNumber(options.retryBaseMs ?? 250, "retryBaseMs");
    if (options.fetch !== undefined && typeof options.fetch !== "function") {
      throw invalidRequestOption("fetch must be a function");
    }
    this.fetcher = options.fetch ?? fetch;

    const createChatCompletion = ((
      request: ChatCompletionRequest,
      requestOptions?: RunInfraRequestOptions,
    ) => {
      validateRequestFields(request, CHAT_COMPLETION_REQUEST_KEYS, "chat completion");
      const body = withValidatedModel(request);
      validateChatMessages(body.messages);
      return this.request("/chat/completions", {
        method: "POST",
        body,
        typedBodyKeys: CHAT_COMPLETION_EXTRA_BODY_CLOSED_KEYS,
        stream: body.stream === true,
        idempotentReplaySafe: true,
      }, requestOptions);
    }) as ChatCompletionsCreate;

    this.chat = {
      completions: {
        create: createChatCompletion,
      },
    };
    this.embeddings = {
      create: (request, requestOptions) => {
        validateRequestFields(request, EMBEDDING_REQUEST_KEYS, "embedding");
        const body = withValidatedModel(request);
        validateEmbeddingInput(body.input);
        validateEmbeddingResponseOptions(body);
        return this.request("/embeddings", {
          method: "POST",
          body,
          typedBodyKeys: EMBEDDING_REQUEST_KEYS,
        }, requestOptions);
      },
    };
    this.responses = {
      create: ((request: ResponsesCreateRequest, requestOptions?: RunInfraRequestOptions) => {
        validateRequestFields(request, RESPONSES_CREATE_REQUEST_KEYS, "responses");
        const body = withValidatedModel(request);
        validateResponsesInput(body.input);
        return this.request("/responses", {
          method: "POST",
          body,
          typedBodyKeys: RESPONSES_CREATE_REQUEST_KEYS,
          stream: body.stream === true,
          idempotentReplaySafe: true,
        }, requestOptions);
      }) as ResponsesCreate,
    };
    this.audio = {
      speech: {
        create: async (request, requestOptions) => {
          validateRequestFields(request, SPEECH_REQUEST_KEYS, "audio speech");
          const body = withValidatedModel(request);
          validateNonEmptyStringField(body.input, "input");
          validateSpeechReference(body);
          const response = await this.rawRequest("/audio/speech", {
            method: "POST",
            body,
            typedBodyKeys: SPEECH_REQUEST_KEYS,
            binary: true,
          }, requestOptions);
          return new RunInfraAudioResponse(response, this.requestTimeoutMs(requestOptions), [this.apiKey]);
        },
      },
      transcriptions: {
        create: (request, requestOptions) => {
          validateTranscriptionRequestKeys(request);
          validateTranscriptionResponseFormat(request);
          const formData = new FormData();
          formData.append("model", validateSdkModel(request.model));
          formData.append(
            "file",
            validateBlobFile(request.file),
            validateMultipartFilename(request.filename ?? "audio.wav"),
          );
          for (const key of ["language", "prompt", "response_format", "temperature"] as const) {
            const value = request[key];
            if (value !== undefined && value !== null) {
              formData.append(key, validateMultipartFieldValue(value));
            }
          }
          return this.request("/audio/transcriptions", {
            method: "POST",
            formData,
          }, requestOptions);
        },
      },
    };
    this.models = {
      list: (requestOptions) => this.request("/models", { method: "GET" }, requestOptions),
      retrieve: async (model, requestOptions) =>
        this.request(
          `/models/${encodeURIComponent(validateSdkIdentifierHeader(model, "model"))}`,
          { method: "GET" },
          requestOptions,
        ),
    };
    this.images = {
      generate: (request, requestOptions) => {
        validateRequestFields(request, IMAGE_GENERATE_REQUEST_KEYS, "image generation");
        const body = withValidatedModel(request);
        validateNonEmptyStringField(body.prompt, "prompt");
        return this.request("/images/generations", {
          method: "POST",
          body,
          typedBodyKeys: IMAGE_GENERATE_REQUEST_KEYS,
        }, requestOptions);
      },
    };
    this.batches = {
      create: async (request, requestOptions) => {
        validateRequestFields(request, BATCH_CREATE_REQUEST_KEYS, "batch");
        const body = withValidatedModel(request);
        validateBatchCreateRequest(body);
        return this.request("/batches", {
          method: "POST",
          body,
          typedBodyKeys: BATCH_CREATE_REQUEST_KEYS,
          idempotentReplaySafe: true,
          batch: true,
          minDefaultTimeoutMs: BATCH_CREATE_MIN_DEFAULT_TIMEOUT_MS,
        }, requestOptions);
      },
      list: async (params, requestOptions) =>
        this.request(`/batches${batchListQuery(params)}`, { method: "GET", batch: true }, requestOptions),
      retrieve: async (batchId, requestOptions) =>
        this.request(batchPath(batchId), { method: "GET", batch: true }, requestOptions),
      cancel: async (batchId, requestOptions) =>
        this.request(batchPath(batchId, "/cancel"), { method: "POST", batch: true }, requestOptions),
    };
    this.webhooks = {
      verifySignature: verifyWebhookSignature,
      constructEvent: constructWebhookEvent,
    };
    this.voice = {
      pipeline: {
        create: (request, requestOptions) => {
          if (!this.hasPipelineScope) {
            throw invalidRequestOption(
              "voice pipeline requests require pipelineId or a pipeline-scoped baseURL",
            );
          }
          validateRequestFields(request, VOICE_PIPELINE_REQUEST_KEYS, "voice pipeline");
          const audio = validateVoicePipelineAudio(request?.audio);
          return this.request("/pipeline", {
            method: "POST",
            rawBody: audio,
            rawContentType: validateMimeType(request.mimeType),
            accept: "application/json",
          }, requestOptions);
        },
      },
    };
  }

  private async request(
    path: string,
    options: RequestOptions & { stream: true },
    requestOptions?: RunInfraRequestOptions,
  ): Promise<RunInfraStream>;
  private async request<TResponse>(
    path: string,
    options: RequestOptions & { stream?: false | undefined },
    requestOptions?: RunInfraRequestOptions,
  ): Promise<TResponse>;
  private async request<TResponse>(
    path: string,
    options: RequestOptions,
    requestOptions?: RunInfraRequestOptions,
  ): Promise<TResponse | RunInfraStream>;
  private async request<TResponse>(
    path: string,
    options: RequestOptions,
    requestOptions?: RunInfraRequestOptions,
  ): Promise<TResponse | RunInfraStream> {
    if (options.stream) {
      const response = await this.rawRequest(path, options, requestOptions);
      return new RunInfraStream(response, this.requestTimeoutMs(requestOptions, true), [this.apiKey]);
    }
    return this.sendWithRetry(path, options, requestOptions, parseJsonResponse<TResponse>);
  }

  /**
   * The timeout of one call. The caller's own setting wins: the call's
   * `timeoutMs`, else the client's. With neither, a non-streamed call is given
   * 750 seconds for the whole call, and a streamed call 190 seconds to its
   * response headers and to each later read. `minDefaultTimeoutMs` is the
   * least a call uses when the caller names no timeout for that call.
   */
  private requestTimeoutMs(
    requestOptions: RunInfraRequestOptions = {},
    stream = false,
    minDefaultTimeoutMs = 0,
  ): number {
    const validatedRequestOptions = validateRequestOptions(requestOptions);
    const defaultTimeoutMs = stream ? DEFAULT_STREAM_TIMEOUT_MS : DEFAULT_TIMEOUT_MS;
    return validatePositiveNumber(
      validatedRequestOptions.timeoutMs ?? Math.max(this.timeoutMs ?? defaultTimeoutMs, minDefaultTimeoutMs),
      "timeoutMs",
    );
  }

  private async rawRequest(
    path: string,
    options: RequestOptions,
    requestOptions: RunInfraRequestOptions = {},
  ): Promise<Response> {
    return this.sendWithRetry(path, options, requestOptions, async (response) => response);
  }

  private async sendWithRetry<TResponse>(
    path: string,
    options: RequestOptions,
    requestOptions: RunInfraRequestOptions = {},
    consumeResponse: (response: Response, sensitiveValues: readonly string[]) => Promise<TResponse>,
  ): Promise<TResponse> {
    const validatedRequestOptions = validateRequestOptions(requestOptions);
    const clientRequestId = validateSdkIdentifierHeader(
      validatedRequestOptions.clientRequestId ?? generatedClientRequestId(),
      "clientRequestId",
    );
    const headers: Record<string, string> = {
      ...validateCustomHeaders(validatedRequestOptions.headers),
      Authorization: `Bearer ${this.apiKey}`,
      "X-RunInfra-SDK": "typescript",
      "X-RunInfra-SDK-Version": RUNINFRA_SDK_VERSION,
      "X-Client-Request-Id": clientRequestId,
    };
    if (validatedRequestOptions.idempotencyKey !== undefined) {
      headers["Idempotency-Key"] = validateSdkIdentifierHeader(
        validatedRequestOptions.idempotencyKey,
        "idempotencyKey",
        255,
      );
    }

    let body: BodyInit | undefined;
    if (options.formData) {
      if (validatedRequestOptions.extraBody !== undefined) {
        throw invalidRequestOption("extraBody can only be used with JSON request bodies");
      }
      body = options.formData;
    } else if (options.rawBody !== undefined) {
      if (validatedRequestOptions.extraBody !== undefined) {
        throw invalidRequestOption("extraBody can only be used with JSON request bodies");
      }
      body = options.rawBody;
      headers["Content-Type"] = options.rawContentType ?? "application/octet-stream";
      if (options.accept) headers.Accept = options.accept;
    } else if (options.body !== undefined) {
      headers["Content-Type"] = "application/json";
      body = encodeJsonBody(
        mergeExtraJsonBody(
          options.body,
          validatedRequestOptions.extraBody,
          options.typedBodyKeys,
        ),
      );
    } else if (validatedRequestOptions.extraBody !== undefined) {
      throw invalidRequestOption("extraBody can only be used with JSON request bodies");
    }

    let attempt = 0;
    const method = options.method ?? "POST";
    const hasReplayableJsonBody =
      options.body !== undefined &&
      !options.stream &&
      !options.binary &&
      !options.formData &&
      options.idempotentReplaySafe === true;
    const canRetry =
      method === "GET" ||
      (Boolean(validatedRequestOptions.idempotencyKey) && hasReplayableJsonBody);
    const maxRetries = validateNonNegativeInteger(
      validatedRequestOptions.maxRetries ?? this.maxRetries,
      "maxRetries",
    );
    const retryBaseMs = validateNonNegativeNumber(
      validatedRequestOptions.retryBaseMs ?? this.retryBaseMs,
      "retryBaseMs",
    );
    const timeoutMs = this.requestTimeoutMs(
      validatedRequestOptions,
      options.stream === true,
      options.minDefaultTimeoutMs,
    );
    const batch = options.batch === true;
    while (true) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      let serverRequestId: string | undefined;
      let waitMs: number;
      try {
        const response = await this.fetcher(`${this.baseURL}${path}`, {
          method,
          headers,
          body,
          signal: controller.signal,
        });
        serverRequestId = response.headers.get("x-request-id") ?? undefined;
        if (response.ok) return await consumeResponse(response, [this.apiKey]);
        // The error body is read before the SDK decides anything: the API can say inside it whether asking again helps.
        const parsed = await parseErrorWithin(response, controller.signal);
        await discardResponseBody(response);
        // The timer may fire just as the body read ends: a call that ran out of time is not judged by a body cut short.
        if (controller.signal.aborted) throw new DOMException("The operation was aborted.", "AbortError");
        const failure = errorFromResponse(response, parsed, batch);
        if (
          !canRetry ||
          attempt >= maxRetries ||
          !failedResponseMayBeAskedAgain(response, failure.retryable, batch)
        ) {
          throw failure;
        }
        // A wait longer than the SDK sleeps for is the caller's to plan: raise now, with the wait on the error.
        if (
          failure.retryAfterMs !== undefined &&
          failure.retryAfterMs > maxAutomaticRetryAfterMs(response, batch)
        ) {
          throw failure;
        }
        waitMs = failure.retryAfterMs ?? backoffDelayMs(attempt + 1, retryBaseMs);
      } catch (error) {
        // Whether the SDK's own timer ended this attempt.
        const timedOut = controller.signal.aborted;
        // A call that ran out of time is never sent again: the API may still be working on it, and a second
        // send could run and charge it twice. The timeout names the request id the SDK sent.
        const asTimeout = (failure: RunInfraError): RunInfraError =>
          withErrorFacts(
            failure instanceof RunInfraTimeoutError
              ? failure
              : new RunInfraTimeoutError(undefined, failure.requestId ?? serverRequestId),
            { clientRequestId },
          );
        if (error instanceof ResponseBodyReadError) {
          const bodyError = normalizeTransportError(error.error, error.error.requestId, [this.apiKey]);
          if (timedOut || bodyError instanceof RunInfraTimeoutError) throw asTimeout(bodyError);
          if (!canRetry || attempt >= maxRetries) throw bodyError;
          waitMs = backoffDelayMs(attempt + 1, retryBaseMs);
        } else if (error instanceof RunInfraError) {
          // The API's own answer, or an error the injected fetch raised as the SDK's: final either way.
          const raised = normalizeTransportError(error, error.requestId, [this.apiKey]);
          throw raised instanceof RunInfraTimeoutError ? asTimeout(raised) : raised;
        } else {
          const transportError = normalizeTransportError(error, serverRequestId, [this.apiKey]);
          if (timedOut || transportError instanceof RunInfraTimeoutError) throw asTimeout(transportError);
          if (!canRetry || attempt >= maxRetries) throw transportError;
          waitMs = backoffDelayMs(attempt + 1, retryBaseMs);
        }
      } finally {
        clearTimeout(timeout);
      }
      attempt += 1;
      await sleep(waitMs);
    }
  }
}

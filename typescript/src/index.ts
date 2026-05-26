import { createHmac, timingSafeEqual } from "node:crypto";

export const RUNINFRA_SDK_VERSION = "0.1.4";
const MAX_AUTOMATIC_RETRY_AFTER_MS = 60_000;

export interface RunInfraOptions {
  apiKey: string;
  pipelineId?: string;
  baseURL?: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  fetch?: typeof fetch;
  dangerouslyAllowBrowser?: boolean;
}

export interface RunInfraRequestOptions {
  clientRequestId?: string;
  idempotencyKey?: string;
  timeoutMs?: number;
  maxRetries?: number;
  retryBaseMs?: number;
  headers?: Record<string, string>;
  extraBody?: Record<string, unknown>;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool" | string;
  content: string | Array<Record<string, unknown>>;
  name?: string;
  tool_call_id?: string;
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
}

const CHAT_COMPLETION_REQUEST_KEYS = new Set([
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

export interface ChatCompletionStreamEvent extends Record<string, unknown> {
  choices?: Array<
    {
      delta?: {
        content?: string;
      } & Record<string, unknown>;
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
  readonly retryAfterMs?: number;

  constructor(message: string, input: {
    status: number;
    type: string;
    requestId?: string;
    retryAfterMs?: number;
  }) {
    super(message);
    this.name = "RunInfraError";
    this.status = input.status;
    this.type = input.type;
    this.requestId = input.requestId;
    this.retryAfterMs = input.retryAfterMs;
  }
}

export class AuthenticationError extends RunInfraError {
  constructor(message: string, status: number, requestId?: string) {
    super(message, { status, type: "auth_error", requestId });
    this.name = "AuthenticationError";
  }
}

export class PermissionDeniedError extends RunInfraError {
  constructor(message: string, status: number, requestId?: string) {
    super(message, { status, type: "permission_denied", requestId });
    this.name = "PermissionDeniedError";
  }
}

export class RateLimitError extends RunInfraError {
  constructor(message: string, status: number, requestId?: string, retryAfterMs?: number) {
    super(message, { status, type: "rate_limit_error", requestId, retryAfterMs });
    this.name = "RateLimitError";
  }
}

export class InsufficientCreditsError extends RunInfraError {
  constructor(message: string, status: number, requestId?: string) {
    super(message, { status, type: "insufficient_credits", requestId });
    this.name = "InsufficientCreditsError";
  }
}

export class DeploymentError extends RunInfraError {
  constructor(message: string, status: number, requestId?: string) {
    super(message, { status, type: "deployment_error", requestId });
    this.name = "DeploymentError";
  }
}

export class ModelNotFoundError extends RunInfraError {
  constructor(message: string, status: number, requestId?: string) {
    super(message, { status, type: "model_not_found", requestId });
    this.name = "ModelNotFoundError";
  }
}

export class RunInfraTimeoutError extends RunInfraError {
  constructor(message = "RunInfra request timed out", requestId?: string) {
    super(message, { status: 0, type: "timeout_error", requestId });
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
    if (!this.response.body) return;
    const reader = this.response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let dataLines: string[] = [];
    let readerDone = false;

    const dispatchEvent = (): TEvent | null => {
      const payload = dataLines.join("\n").trim();
      dataLines = [];
      if (!payload || payload === "[DONE]") return null;
      try {
        return JSON.parse(payload) as TEvent;
      } catch {
        throw new RunInfraStreamParseError(undefined, this.requestId);
      }
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
      if (buffer) {
        const parsed = processLine(buffer);
        if (parsed) yield parsed;
      }
      if (dataLines.length > 0) {
        const parsed = dispatchEvent();
        if (parsed) yield parsed;
      }
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

function retryAfterMs(response: Response): number | null {
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

function automaticRetryAfterMs(response: Response): number | null {
  const delay = retryAfterMs(response);
  if (delay === null || delay > MAX_AUTOMATIC_RETRY_AFTER_MS) return null;
  return delay;
}

function retryDelayMs(attempt: number, baseMs: number, response?: Response): number {
  if (response) {
    const retryAfter = automaticRetryAfterMs(response);
    if (retryAfter !== null) return retryAfter;
  }
  if (baseMs <= 0) return 0;
  const exponential = baseMs * 2 ** Math.max(0, attempt - 1);
  const jitter = Math.random() * baseMs;
  return Math.min(30_000, exponential + jitter);
}

async function parseError(response: Response): Promise<{ message: string; type: string }> {
  try {
    const body = (await response.json()) as {
      error?: { message?: unknown; type?: unknown };
    };
    return {
      message:
        typeof body.error?.message === "string"
          ? body.error.message
          : `RunInfra request failed with status ${response.status}`,
      type: typeof body.error?.type === "string" ? body.error.type : "api_error",
    };
  } catch {
    return {
      message: `RunInfra request failed with status ${response.status}`,
      type: "api_error",
    };
  }
}

async function discardResponseBody(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // Best-effort cleanup before retrying a failed response.
  }
}

async function raiseForStatus(response: Response): Promise<void> {
  if (response.ok) return;
  const { message, type } = await parseError(response);
  const requestId = response.headers.get("x-request-id") ?? undefined;
  if (response.status === 401) throw new AuthenticationError(message, response.status, requestId);
  if (response.status === 403) throw new PermissionDeniedError(message, response.status, requestId);
  if (response.status === 402) throw new InsufficientCreditsError(message, response.status, requestId);
  if (response.status === 404 || type === "model_not_found") {
    throw new ModelNotFoundError(message, response.status, requestId);
  }
  if (response.status === 429) {
    throw new RateLimitError(
      message,
      response.status,
      requestId,
      retryAfterMs(response) ?? undefined,
    );
  }
  if (type === "deployment_error") throw new DeploymentError(message, response.status, requestId);
  throw new RunInfraError(message, { status: response.status, type, requestId });
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
  const message = redactSensitiveValues(error.message, sensitiveValues);
  if (error instanceof AuthenticationError) return new AuthenticationError(message, error.status, error.requestId);
  if (error instanceof PermissionDeniedError) return new PermissionDeniedError(message, error.status, error.requestId);
  if (error instanceof RateLimitError) {
    return new RateLimitError(message, error.status, error.requestId, error.retryAfterMs);
  }
  if (error instanceof InsufficientCreditsError) return new InsufficientCreditsError(message, error.status, error.requestId);
  if (error instanceof DeploymentError) return new DeploymentError(message, error.status, error.requestId);
  if (error instanceof ModelNotFoundError) return new ModelNotFoundError(message, error.status, error.requestId);
  if (error instanceof RunInfraTimeoutError) return new RunInfraTimeoutError(message, error.requestId);
  if (error instanceof RunInfraConnectionError) return new RunInfraConnectionError(message, error.requestId);
  if (error instanceof RunInfraStreamParseError) return new RunInfraStreamParseError(message, error.requestId);
  if (error instanceof UnsupportedOperationError) return new UnsupportedOperationError(message);
  if (error instanceof WebhookVerificationError) return new WebhookVerificationError(message);
  return new RunInfraError(message, {
    status: error.status,
    type: error.type,
    requestId: error.requestId,
    retryAfterMs: error.retryAfterMs,
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
   * @experimental As of v0.1.4, these methods have NOT been verified end-to-end
   * against a live deployed pipeline in our canary suite. The HTTP envelope
   * matches the OpenAI Audio API contract and the request/response shapes are
   * stable, but you should test against your own deployed model before using
   * in production. Live-canary verification is tracked for v1.0.0 GA.
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
   * @experimental As of v0.1.4, this method has NOT been verified end-to-end
   * against a live deployed pipeline in our canary suite. The HTTP envelope
   * matches the OpenAI Images API contract, but you should test against your
   * own deployed model before using in production. Live-canary verification
   * is tracked for v1.0.0 GA.
   */
  readonly images: {
    generate: (request: ImageGenerateRequest, options?: RunInfraRequestOptions) => Promise<ImageGenerationResponse>;
  };

  readonly webhooks: {
    verifySignature: typeof verifyWebhookSignature;
    constructEvent: typeof constructWebhookEvent;
  };

  /**
   * Voice pipeline surface.
   *
   * @experimental As of v0.1.4, this method has NOT been verified end-to-end
   * against a live deployed pipeline in our canary suite. It requires a
   * pipeline-scoped client and posts binary audio to `/pipeline`, but you
   * should test against your own deployed pipeline before using in production.
   * Live-canary verification is tracked for v1.0.0 GA.
   */
  readonly voice: {
    pipeline: {
      create: (request: VoicePipelineRequest, options?: RunInfraRequestOptions) => Promise<VoicePipelineResponse>;
    };
  };

  private readonly apiKey: string;
  private readonly baseURL: string;
  private readonly hasPipelineScope: boolean;
  private readonly timeoutMs: number;
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
    this.timeoutMs = validatePositiveNumber(options.timeoutMs ?? 120_000, "timeoutMs");
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
        typedBodyKeys: CHAT_COMPLETION_REQUEST_KEYS,
        stream: body.stream === true,
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
      return new RunInfraStream(response, this.requestTimeoutMs(requestOptions), [this.apiKey]);
    }
    return this.sendWithRetry(path, options, requestOptions, parseJsonResponse<TResponse>);
  }

  private requestTimeoutMs(requestOptions: RunInfraRequestOptions = {}): number {
    const validatedRequestOptions = validateRequestOptions(requestOptions);
    return validatePositiveNumber(
      validatedRequestOptions.timeoutMs ?? this.timeoutMs,
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
      options.body !== undefined && !options.stream && !options.binary && !options.formData;
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
    const timeoutMs = validatePositiveNumber(
      validatedRequestOptions.timeoutMs ?? this.timeoutMs,
      "timeoutMs",
    );
    while (true) {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const response = await this.fetcher(`${this.baseURL}${path}`, {
          method,
          headers,
          body,
          signal: controller.signal,
        });
        if (
          canRetry &&
          !response.ok &&
          isRetryableStatus(response.status) &&
          attempt < maxRetries
        ) {
          attempt += 1;
          await discardResponseBody(response);
          await sleep(retryDelayMs(attempt, retryBaseMs, response));
          continue;
        }
        await raiseForStatus(response);
        return await consumeResponse(response, [this.apiKey]);
      } catch (error) {
        if (error instanceof ResponseBodyReadError) {
          if (canRetry && attempt < maxRetries) {
            attempt += 1;
            await sleep(retryDelayMs(attempt, retryBaseMs));
            continue;
          }
          throw normalizeTransportError(error.error, error.error.requestId, [this.apiKey]);
        }
        if (error instanceof RunInfraError) throw normalizeTransportError(error, error.requestId, [this.apiKey]);
        if (!canRetry || attempt >= maxRetries) throw normalizeTransportError(error, undefined, [this.apiKey]);
        attempt += 1;
        await sleep(retryDelayMs(attempt, retryBaseMs));
      } finally {
        clearTimeout(timeout);
      }
    }
  }
}

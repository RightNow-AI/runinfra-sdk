from __future__ import annotations

import base64
import codecs
import json
import hashlib
import hmac
import math
import random
import re
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from collections.abc import Mapping as MappingABC
from typing import Any, Callable, Dict, Iterable, Iterator, List, Literal, Mapping, Optional, Sequence, TypedDict, Union, overload


JsonDict = Dict[str, Any]
Transport = Callable[["RunInfraRequest"], "RunInfraResponse"]
ResponseBody = Union[bytes, Iterable[bytes]]
__version__ = "0.3.1"
# The longest wait the API may name (Retry-After-Ms, Retry-After) that the SDK
# sleeps for before it asks again. A longer wait is raised at once, with the
# wait on the error.
_MAX_AUTOMATIC_RETRY_AFTER_SECONDS = 60.0
# The largest whole number of seconds a Retry-After may name: 2^53 - 1, the
# largest safe integer, the same line in every runtime. A larger value names no
# wait.
_MAX_RETRY_AFTER_HEADER_SECONDS = 9007199254740991
# The timeout of a non-streamed call when the caller names none. The API allows
# a whole response up to 740 seconds, so the default sits just above.
_DEFAULT_TIMEOUT_SECONDS = 750.0
# The timeout of a streamed call when the caller names none: the wait for the
# response headers, and for each later read. The API allows a stream up to 180
# seconds to its first token, so the default sits just above.
_DEFAULT_STREAM_TIMEOUT_SECONDS = 190.0
_WEBHOOK_SIGNATURE_HEADER_MAX_LENGTH = 8192


class RunInfraRequestMetadata(TypedDict, total=False):
    _request_id: str
    _idempotent_replay: bool


class ModelObject(RunInfraRequestMetadata, total=False):
    id: str
    object: str
    created: int
    owned_by: str


class ModelListResponse(RunInfraRequestMetadata, total=False):
    object: str
    data: List[ModelObject]


class ChatCompletionToolCallFunction(TypedDict):
    """The function one tool call names. `arguments` is a JSON string: parse and check it before you run the tool."""

    name: str
    arguments: str


class ChatCompletionMessageToolCall(TypedDict):
    """One call the model asks for, on an assistant message's `tool_calls`.

    The `tool` message that answers the call repeats `id` as `tool_call_id`.
    """

    id: str
    type: Literal["function"]
    function: ChatCompletionToolCallFunction


class _ChatMessageRole(TypedDict):
    role: str


class ChatMessage(_ChatMessageRole, total=False):
    """One message of a chat.

    `system`, `developer` and `user` messages carry `content`. An `assistant`
    message carries `content`, a non-empty `tool_calls`, or both; its `content`
    is None or left out when it carries only `tool_calls`, and `reasoning`
    holds the model's thinking when the model reports it. A `tool` message
    carries `content` and the `tool_call_id` of the call it answers;
    `ChatToolMessage` types that one.
    """

    content: Union[str, List[JsonDict], None]
    name: str
    tool_call_id: str
    tool_calls: List[ChatCompletionMessageToolCall]
    reasoning: Optional[str]


class ChatToolMessage(TypedDict):
    """The message that answers one tool call: the result as `content`, and the call's id."""

    role: Literal["tool"]
    content: Union[str, List[JsonDict]]
    tool_call_id: str


class ChatCompletionChoice(TypedDict, total=False):
    index: int
    message: ChatMessage
    finish_reason: Optional[str]
    logprobs: Optional[JsonDict]


class ChatCompletionResponse(RunInfraRequestMetadata, total=False):
    id: str
    object: str
    created: int
    model: str
    choices: List[ChatCompletionChoice]
    usage: JsonDict


class ChatCompletionStreamToolCallFunction(TypedDict, total=False):
    """`name` comes on the first piece of a call; `arguments` is the next piece of the arguments' JSON string."""

    name: str
    arguments: str


class _ChatCompletionStreamToolCallIndex(TypedDict):
    index: int


class ChatCompletionStreamToolCallDelta(_ChatCompletionStreamToolCallIndex, total=False):
    """One piece of a tool call on a stream.

    Pieces of the same call share `index`; join their `arguments`. `id` comes
    on the first piece of a call.
    """

    id: str
    type: Literal["function"]
    function: ChatCompletionStreamToolCallFunction


class ChatCompletionStreamDelta(TypedDict, total=False):
    """The new part of a choice on one stream event. `reasoning` is the next piece of the model's thinking."""

    role: str
    content: Optional[str]
    reasoning: Optional[str]
    tool_calls: List[ChatCompletionStreamToolCallDelta]


class ChatCompletionStreamChoice(TypedDict, total=False):
    index: int
    delta: ChatCompletionStreamDelta
    finish_reason: Optional[str]


class ChatCompletionStreamEvent(TypedDict, total=False):
    """One event of a chat stream, as iterating a `RunInfraStream` yields it.

    The usage event, when asked for, has an empty `choices` and the `usage`.
    """

    id: str
    object: str
    created: int
    model: str
    choices: List[ChatCompletionStreamChoice]
    usage: Optional[JsonDict]


class ResponsesCreateResponse(RunInfraRequestMetadata, total=False):
    id: str
    object: str
    created_at: int
    status: str
    model: str
    output: List[JsonDict]
    output_text: str
    usage: JsonDict


class EmbeddingObject(TypedDict, total=False):
    object: str
    embedding: List[float]
    index: int


class EmbeddingResponse(RunInfraRequestMetadata, total=False):
    object: str
    model: str
    data: List[EmbeddingObject]
    usage: JsonDict


class TranscriptionResponse(RunInfraRequestMetadata, total=False):
    text: str
    language: str
    duration: float
    segments: List[JsonDict]


class ImageObject(TypedDict, total=False):
    url: str
    b64_json: str
    revised_prompt: str


class ImageGenerationResponse(RunInfraRequestMetadata, total=False):
    created: int
    data: List[ImageObject]


class VoicePipelineResponse(RunInfraRequestMetadata, total=False):
    object: str
    modality: str
    model: str
    upstream_model: str
    transcript: str
    text: str
    responseText: str
    response: str
    response_text: str
    outputText: str
    output_text: str
    audio_base64: str
    content_type: str
    usage: JsonDict
    latency_ms: float


# The state of a batch job. A job starts in "validating" while its input file is
# read, then moves by itself through "checked" and "queued" to "running".
# "completed", "expired", "cancelled", and "failed" are final.
BatchState = Literal[
    "validating",
    "checked",
    "queued",
    "running",
    "paused",
    "cancelling",
    "completed",
    "expired",
    "cancelled",
    "failed",
]
# Why a paused job waits. Set exactly when batch_state is "paused".
BatchPauseReason = Literal["funds", "destination", "source", "key_limit", "daily_room"]
# Why a job ended. None while the job is open.
BatchEndReason = Literal[
    "all_done",
    "max_cost_reached",
    "cancel_asked",
    "key_revoked",
    "account_deleted",
    "window_ended",
    "model_withdrawn",
    "not_flex",
    "not_started",
    "check_failed",
]
# Why a job's input file was refused. Set only when end_reason is "check_failed".
BatchCheckError = Literal[
    "url_not_public",
    "link_expires_too_soon",
    "file_too_large",
    "link_changed",
    "link_not_supported",
]
# A notice about a job: data only.
BatchNotice = Literal["batch_ended", "batch_paused", "batch_expires_soon"]
# Why a line of the input file was refused when the file was read.
BatchLineCheckCode = Literal[
    "invalid_json",
    "line_too_large",
    "invalid_request",
    "media_not_supported",
    "prompt_too_large",
]
# The code of a line that failed after its job started, as an error delivery carries it.
BatchDeliveryErrorCode = Literal["invalid_request", "prompt_too_large", "model_error", "link_changed"]
# Why batch is not available, on a flex_not_available refusal (error.reason).
BatchUnavailableReason = Literal["model", "partner", "price"]
# The refusal codes a caller of the batch routes can receive, as
# RunInfraError.code carries them. Codes every route can answer (invalid_api_key
# on 401, rate_limit_exceeded on 429) are not repeated here.
BatchRefusalCode = Literal[
    "batch_not_open",
    "invalid_request",
    "not_found",
    "model_not_sold",
    "flex_not_available",
    "url_not_public",
    "link_expires_too_soon",
    "destination_unreachable",
    "needs_funds",
    "key_spend_limit_reached",
    "batch_ended",
    "batches_scope_violation",
]


class BatchDestination(TypedDict):
    """Where a job's answers go. A webhook address is the only destination."""

    type: Literal["webhook"]
    url: str


class BatchMadeBy(TypedDict):
    """Who started a job: an API key, or a person in the dashboard. Never a name."""

    kind: Literal["person", "key"]


class BatchJob(TypedDict):
    """A batch job, as every batch route answers it.

    Counts are whole numbers. `lines_total` counts every line read from the
    file, the invalid ones included. `expired` counts the lines the job had not
    run when its window ended; they are not charged. `undelivered` counts the
    answered lines the address did not acknowledge with a 2xx in time; they are
    not charged and are not sent again. `failed` never includes an undelivered
    line, and once a job has ended the counts `succeeded`, `failed`, `expired`,
    `cancelled`, `undelivered`, and `lines_invalid` add up to `lines_total`.
    `cost_microcents` is what the job's lines were charged so far, in
    millionths of a cent. Times are ISO 8601 UTC with milliseconds;
    `expires_at` is the end of the job's window.
    """

    id: str
    model_slug: Optional[str]
    batch_state: BatchState
    pause_reason: Optional[BatchPauseReason]
    made_by: BatchMadeBy
    lines_total: int
    lines_invalid: int
    succeeded: int
    failed: int
    expired: int
    cancelled: int
    undelivered: int
    cost_microcents: int
    max_cost_cents: Optional[int]
    created_at: str
    started_at: Optional[str]
    expires_at: str
    finished_at: Optional[str]
    destination_type: Optional[Literal["webhook"]]
    notice: Optional[BatchNotice]
    key_id: Optional[str]
    end_reason: Optional[BatchEndReason]
    check_error: Optional[BatchCheckError]
    name: Optional[str]


class BatchLineCheckErrors(TypedDict):
    """The lines one check code refused: how many, and the first line numbers (1-based, at most five)."""

    code: BatchLineCheckCode
    count: int
    first_lines: List[int]


class BatchQuote(TypedDict):
    """The gateway's estimate of the most a job's lines can cost."""

    input_cost_cents: int
    output_cost_ceiling_cents: int
    most_cents: int
    flex_input_cents_per_million: int
    flex_output_cents_per_million: int
    est_input_tokens: int
    can_finish_in_window: bool
    covered_until_after: Optional[str]


class BatchJobDetail(BatchJob):
    """A job as `batches.retrieve()` answers it: the job, the lines its check refused, and its quote.

    `quote` is None while the file is still read, once the job has ended, and
    when no quote can be made now.
    """

    errors: List[BatchLineCheckErrors]
    quote: Optional[BatchQuote]


class BatchCreateResponse(RunInfraRequestMetadata, total=False):
    batch: BatchJob


class BatchRetrieveResponse(RunInfraRequestMetadata, total=False):
    batch: BatchJobDetail


class BatchListResponse(RunInfraRequestMetadata, total=False):
    """One page of jobs, newest first. Pass `next_cursor` as `cursor` for the next page; None on the last."""

    batches: List[BatchJob]
    next_cursor: Optional[str]


class BatchCancelResponse(RunInfraRequestMetadata, total=False):
    """`batch_state` is "cancelled" when no line had run, and "cancelling" while lines in flight settle."""

    batch_id: str
    batch_state: Literal["cancelling", "cancelled"]


class BatchDeliveryUsage(TypedDict):
    prompt_tokens: int
    completion_tokens: int
    total_tokens: int


class BatchDeliveryCost(TypedDict):
    """What a line cost, in microcents (millionths of a cent)."""

    microcents: int


class BatchTestDelivery(TypedDict):
    """The test delivery a `batches.create()` call sends to the destination before it answers.

    The address must reply 2xx with a body that CONTAINS `value`.
    """

    id: str
    test: Literal[True]
    value: str


class BatchAnswerDelivery(TypedDict):
    """One answered line. `id` is the same for the same line and attempt. Key your own writes on it.

    `line` is the line's 1-based number in the input file, and `response` is
    the chat completion object.
    """

    id: str
    batch_id: str
    custom_id: str
    line: int
    attempt: int
    test: Literal[False]
    response: JsonDict
    usage: Optional[BatchDeliveryUsage]
    cost: Optional[BatchDeliveryCost]


class BatchDeliveryError(TypedDict):
    code: BatchDeliveryErrorCode


class BatchErrorDelivery(TypedDict):
    """One line that failed after its job started. It carries no usage and no cost.

    `custom_id` is None when the file changed after it was checked
    (`link_changed`); `line` names the line then.
    """

    id: str
    batch_id: str
    custom_id: Optional[str]
    line: int
    attempt: int
    test: Literal[False]
    error: BatchDeliveryError
    usage: None
    cost: None


BatchDelivery = Union[BatchTestDelivery, BatchAnswerDelivery, BatchErrorDelivery]


@dataclass
class RunInfraRequest:
    method: str
    url: str
    headers: Dict[str, str]
    body: Optional[bytes]
    stream: bool = False
    timeout_seconds: Optional[float] = None


@dataclass
class RunInfraResponse:
    status: int
    headers: Mapping[str, str]
    body: ResponseBody

    def json(self) -> Any:
        body = self.body if isinstance(self.body, bytes) else b"".join(self.body)
        if not body:
            return None
        return json.loads(body.decode("utf-8"))


class RunInfraError(Exception):
    """The base of every error the SDK raises.

    `retry_after_seconds` is the wait the API named with the error
    (`Retry-After-Ms` when the response carries it, else `Retry-After`). It is
    set on every error whose response named a wait, whatever its status.
    """

    def __init__(
        self,
        message: str,
        *,
        status: int,
        error_type: str,
        request_id: Optional[str] = None,
        retry_after_seconds: Optional[float] = None,
        code: Optional[str] = None,
        param: Optional[str] = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.type = error_type
        self.request_id = request_id
        self.retry_after_seconds = retry_after_seconds
        self.code = code
        self.param = param
        # The closed cause word of a batch route's refusal, when its error body
        # names one (error.reason): "model", "partner", or "price" on
        # flex_not_available. Other routes do not set it.
        self.reason: Optional[str] = None
        # What the API said about asking again, when it said it: x-should-retry
        # on the response, or "retryable" inside the error object. False means
        # the same request will fail again. None when the API said nothing.
        self.retryable: Optional[bool] = None
        # The X-Client-Request-Id the SDK sent with the call, set on a timeout.
        # A call that timed out before any response has no server request id,
        # so this is the id to quote to support.
        self.client_request_id: Optional[str] = None


class AuthenticationError(RunInfraError):
    pass


class PermissionDeniedError(RunInfraError):
    pass


class RateLimitError(RunInfraError):
    pass


class InsufficientCreditsError(RunInfraError):
    """A 402 from the gateway.

    On a batch route, read `code` to tell `needs_funds` (the account has never
    added funds) from `key_spend_limit_reached` (this API key reached its own
    monthly limit; raise the key's limit or use another key).
    """

    def __init__(
        self,
        message: str,
        *,
        status: int,
        error_type: str = "insufficient_credits",
        request_id: Optional[str] = None,
        retry_after_seconds: Optional[float] = None,
        code: Optional[str] = None,
        param: Optional[str] = None,
        current_balance_cents: Optional[int] = None,
        required_cents: Optional[int] = None,
        topup_url: Optional[str] = None,
    ) -> None:
        super().__init__(
            message,
            status=status,
            error_type=error_type,
            request_id=request_id,
            retry_after_seconds=retry_after_seconds,
            code=code,
            param=param,
        )
        # Structured remediation fields the gateway ships on 402; any may be None.
        self.current_balance_cents = current_balance_cents
        self.required_cents = required_cents
        self.topup_url = topup_url


class DeploymentError(RunInfraError):
    pass


class ModelNotFoundError(RunInfraError):
    pass


class RunInfraTimeoutError(RunInfraError):
    """A call that ran out of time.

    `client_request_id` holds the `X-Client-Request-Id` the SDK sent with the
    call; `request_id` is set only when a response had begun. A call is never
    sent again after a timeout: the API may still be working on it.
    """


class RunInfraConnectionError(RunInfraError):
    pass


class RunInfraStreamParseError(RunInfraError):
    def __init__(
        self,
        message: str = "RunInfra stream event payload was not valid JSON",
        request_id: Optional[str] = None,
    ) -> None:
        super().__init__(
            message,
            status=0,
            error_type="stream_parse_error",
            request_id=request_id,
        )


class RunInfraStreamError(RunInfraError):
    """The API ended an open stream with a failure.

    Raised for a frame that holds an `error` object, and for a
    `response.failed` event on a Responses stream. `type`, `code` and `param`
    are the API's own, `retryable` is set when the API marked the failure, and
    `request_id` is the request id the frame names, else the stream's.
    `status` is 0: the failure arrived after the HTTP status. The events before
    the failure were already yielded. The answer is not whole.
    """


class RunInfraStreamIncompleteError(RunInfraError):
    """A stream's body ended without its end marker.

    The end marker is `[DONE]` on a chat stream and `response.completed` on a
    Responses stream. Without it the connection was cut or the stream was
    closed early, so the answer is not whole even though the HTTP status was
    200. The events before the end were already yielded.
    """

    def __init__(
        self,
        message: str = "RunInfra stream ended before its end marker; the answer is incomplete",
        request_id: Optional[str] = None,
    ) -> None:
        super().__init__(
            message,
            status=0,
            error_type="stream_incomplete_error",
            request_id=request_id,
        )


class UnsupportedOperationError(RunInfraError):
    def __init__(self, message: str) -> None:
        super().__init__(message, status=400, error_type="unsupported_operation")


class WebhookVerificationError(RunInfraError):
    def __init__(self, message: str) -> None:
        super().__init__(message, status=400, error_type="webhook_verification_error")


@dataclass
class AudioResponse:
    content: bytes
    content_type: str
    request_id: Optional[str] = None


def _stream_failure(event: Any, stream_request_id: Optional[str]) -> Optional[RunInfraStreamError]:
    """The failure an open stream reported, read from one parsed event.

    A frame with a top-level `error` object is one, and so is a Responses
    `response.failed` event, whose error sits inside `response`. None for every
    other event.
    """
    if not isinstance(event, dict):
        return None
    failure: Optional[Dict[str, Any]] = None
    if isinstance(event.get("error"), dict):
        failure = event["error"]
    elif event.get("type") == "response.failed":
        response = event.get("response")
        nested = response.get("error") if isinstance(response, dict) else None
        failure = nested if isinstance(nested, dict) else {}
    if failure is None:
        return None
    message = failure.get("message")
    error_type = failure.get("type")
    code = failure.get("code")
    param = failure.get("param")
    request_id = event.get("request_id")
    error = RunInfraStreamError(
        message if isinstance(message, str) and message else "RunInfra stream ended with an error",
        status=0,
        error_type=error_type if isinstance(error_type, str) else "api_error",
        request_id=request_id if isinstance(request_id, str) and request_id else stream_request_id,
        code=code if isinstance(code, str) else None,
        param=param if isinstance(param, str) else None,
    )
    if isinstance(failure.get("retryable"), bool):
        error.retryable = failure["retryable"]
    return error


class RunInfraStream:
    """The events of one streamed answer.

    Iterating yields each event as it arrives. The iteration ends quietly only
    when the stream carried its end marker: `[DONE]` on a chat stream,
    `response.completed` on a Responses stream. It raises instead, after
    yielding every event that came first, when the API reports a failure on the
    open stream (`RunInfraStreamError`) or when the body ends without the end
    marker (`RunInfraStreamIncompleteError`). Closing the iterator early raises
    nothing.

    When the API answers the call with one JSON object instead of an event
    stream, the iteration yields that object once and ends quietly. That is the
    answer to a streamed call that repeats an `Idempotency-Key`: the object
    carries `_idempotent_replay` true, as a non-streamed answer does.
    """

    def __init__(
        self,
        body: ResponseBody,
        request_id: Optional[str] = None,
        sensitive_values: Iterable[str] = (),
    ) -> None:
        self._body = body
        self.request_id = request_id
        self._sensitive_values = tuple(sensitive_values)
        # The response, when its body is one JSON object instead of an event stream. Set by the client.
        self._answered_with_json: Optional[RunInfraResponse] = None
        # The X-Client-Request-Id the SDK sent with the call. A timeout while the stream is read names it. Set by
        # the client.
        self._client_request_id: Optional[str] = None

    def __iter__(self) -> Iterator[JsonDict]:
        buffer = ""
        data_lines: List[str] = []
        decoder = codecs.getincrementaldecoder("utf-8")()
        # Whether the end marker arrived: [DONE], or a Responses response.completed event.
        completed = False

        def dispatch_event() -> Optional[JsonDict]:
            nonlocal completed
            payload = "\n".join(data_lines).strip()
            data_lines.clear()
            if not payload:
                return None
            if payload == "[DONE]":
                completed = True
                return None
            try:
                event = json.loads(payload)
            except json.JSONDecodeError as exc:
                raise RunInfraStreamParseError(request_id=self.request_id) from exc
            failure = _stream_failure(event, self.request_id)
            if failure is not None:
                raise failure
            if isinstance(event, dict) and event.get("type") == "response.completed":
                completed = True
            return event

        def parse_line(line: str) -> Optional[JsonDict]:
            line = line[:-1] if line.endswith("\r") else line
            if line == "":
                return dispatch_event()
            if line.startswith(":"):
                return None
            if ":" in line:
                field, value = line.split(":", 1)
                if value.startswith(" "):
                    value = value[1:]
            else:
                field, value = line, ""
            if field == "data":
                data_lines.append(value)
            return None

        chunks: Iterable[bytes]
        close_chunks = None
        if isinstance(self._body, bytes):
            chunks = [self._body]
        else:
            chunks = self._body
            close_chunks = getattr(chunks, "close", None)

        error_to_raise: Optional[RunInfraError] = None
        try:
            if self._answered_with_json is not None:
                # One JSON object, not an event stream: read it whole and yield it as the only event.
                try:
                    answer = json.loads(b"".join(chunks).decode("utf-8"))
                except ValueError as exc:
                    raise RunInfraStreamIncompleteError(
                        "RunInfra answered a streamed call with a JSON body that could not be read; "
                        "the answer is incomplete",
                        request_id=self.request_id,
                    ) from exc
                yield _json_answer_with_metadata(answer, self._answered_with_json)
                return

            for chunk in chunks:
                buffer += decoder.decode(chunk, final=False)
                lines = buffer.split("\n")
                buffer = lines.pop() or ""
                for line in lines:
                    parsed = parse_line(line)
                    if parsed is not None:
                        yield parsed

            try:
                buffer += decoder.decode(b"", final=True)
            except UnicodeDecodeError:
                # The body ended inside a character. What is left is an unfinished event, judged below.
                buffer += "\ufffd"
            # What is left was not ended by a blank line. If it cannot be read and no end marker came before
            # it, the body ended inside an event: that is a cut stream, reported below, not a malformed event.
            unfinished: List[JsonDict] = []
            try:
                parsed = parse_line(buffer)
                if parsed is not None:
                    unfinished.append(parsed)
                if data_lines:
                    parsed = dispatch_event()
                    if parsed is not None:
                        unfinished.append(parsed)
            except RunInfraStreamParseError:
                if completed:
                    raise
            for event in unfinished:
                yield event
            # The body is over. Without the end marker the answer was cut short, whatever the HTTP status said.
            if not completed:
                raise RunInfraStreamIncompleteError(request_id=self.request_id)
        except RunInfraError as exc:
            error_to_raise = _redacted_runinfra_error(exc, self._sensitive_values)
        except Exception as exc:
            error_to_raise = _transport_error(
                exc,
                request_id=self.request_id,
                sensitive_values=self._sensitive_values,
            )
        finally:
            if callable(close_chunks):
                close_chunks()
        if error_to_raise is not None:
            if isinstance(error_to_raise, RunInfraTimeoutError) and self._client_request_id is not None:
                # A timeout while the stream is read names the request id the SDK sent, as a timeout before the
                # stream opened does.
                error_to_raise.client_request_id = self._client_request_id
            raise error_to_raise


def _base_url_already_has_pipeline_id(base_url: str, pipeline_id: str) -> bool:
    encoded_pipeline_id = urllib.parse.quote(pipeline_id, safe="")
    parsed = urllib.parse.urlparse(base_url)
    path = parsed.path.rstrip("/") if parsed.scheme or parsed.netloc else base_url.rstrip("/")
    last_segment = path.rsplit("/", 1)[-1]
    return (
        last_segment == encoded_pipeline_id
        or urllib.parse.unquote(last_segment) == pipeline_id
    )


def _validate_base_url(base_url: Any) -> str:
    if not isinstance(base_url, str):
        raise _invalid_request_option("base_url must be a string")
    base = base_url.strip().rstrip("/")
    parsed = urllib.parse.urlparse(base)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        raise RunInfraError(
            "base_url must be an http or https URL",
            status=0,
            error_type="invalid_request_options",
        )
    if parsed.username or parsed.password:
        raise RunInfraError(
            "base_url must not include credentials",
            status=0,
            error_type="invalid_request_options",
        )
    if parsed.query or parsed.fragment:
        raise RunInfraError(
            "base_url must not include query strings or fragments",
            status=0,
            error_type="invalid_request_options",
        )
    if parsed.scheme == "http" and not _is_local_base_url_host(parsed.hostname):
        raise RunInfraError(
            "Remote base_url must use https",
            status=0,
            error_type="invalid_request_options",
        )
    return base


def _is_local_base_url_host(hostname: Optional[str]) -> bool:
    return (hostname or "").strip().lower().strip("[]") in {
        "localhost",
        "127.0.0.1",
        "0.0.0.0",
        "::1",
    }


def _normalize_base_url(base_url: str, pipeline_id: Optional[str]) -> str:
    base = _validate_base_url(base_url)
    if pipeline_id is None:
        return base
    validated_pipeline_id = _validated_identifier(pipeline_id, "pipeline_id")
    if _base_url_already_has_pipeline_id(base, validated_pipeline_id):
        return base
    return f"{base}/{urllib.parse.quote(validated_pipeline_id, safe='')}"


def _base_url_looks_pipeline_scoped(base_url: str) -> bool:
    parsed = urllib.parse.urlparse(base_url)
    segments = [segment for segment in parsed.path.split("/") if segment]
    try:
        last_v1 = len(segments) - 1 - list(reversed(segments)).index("v1")
    except ValueError:
        return len(segments) > 0
    return len(segments) > last_v1 + 1


def _default_transport(timeout: Optional[float] = None) -> Transport:
    """The standard-library transport.

    `timeout` is the client's own timeout. A request's own `timeout_seconds`
    wins over it. With neither, a non-streamed request is given 750 seconds and
    a streamed request 190 seconds; the timeout bounds the wait for the
    response headers and each later read.
    """

    def send(request: RunInfraRequest) -> RunInfraResponse:
        req = urllib.request.Request(
            request.url,
            data=request.body,
            headers=request.headers,
            method=request.method,
        )
        try:
            response = urllib.request.urlopen(
                req,
                timeout=request.timeout_seconds
                or timeout
                or (_DEFAULT_STREAM_TIMEOUT_SECONDS if request.stream else _DEFAULT_TIMEOUT_SECONDS),
            )
            response_headers = dict(response.headers.items())
            if request.stream:
                def iter_response() -> Iterator[bytes]:
                    try:
                        while True:
                            chunk = response.readline()
                            if not chunk:
                                break
                            yield chunk
                    finally:
                        response.close()

                return RunInfraResponse(
                    response.status,
                    response_headers,
                    iter_response(),
                )
            try:
                with response:
                    body = response.read()
            except Exception as exc:
                raise _TransportBodyReadError(
                    _transport_error(
                        exc,
                        _request_id_from_headers(response_headers),
                    )
                ) from exc
            return RunInfraResponse(
                response.status,
                response_headers,
                body,
            )
        except urllib.error.HTTPError as exc:
            response_headers = dict(exc.headers.items())
            try:
                body = exc.read()
            except Exception as read_exc:
                raise _TransportBodyReadError(
                    _transport_error(
                        read_exc,
                        _request_id_from_headers(response_headers),
                    )
                ) from read_exc
            return RunInfraResponse(exc.code, response_headers, body)

    return send


def _is_retryable(status: int) -> bool:
    return status in {408, 409, 429, 500, 502, 503, 504}


def _header(headers: Mapping[str, str], name: str) -> Optional[str]:
    """One response header by its lower-case name, whatever case the transport kept."""
    for key, value in headers.items():
        if isinstance(key, str) and key.lower() == name and isinstance(value, str):
            return value
    return None


def _retry_after_ms_header_seconds(response: RunInfraResponse) -> Optional[float]:
    """`Retry-After-Ms` in seconds: the wait in milliseconds, a plain non-negative number."""
    value = _header(response.headers, "retry-after-ms")
    if not value:
        return None
    value = value.strip()
    if re.fullmatch(r"[0-9]+(?:\.[0-9]+)?", value) is None:
        return None
    milliseconds = float(value)
    if not math.isfinite(milliseconds):
        return None
    return math.ceil(milliseconds) / 1000.0


def _retry_after_header_seconds(response: RunInfraResponse) -> Optional[float]:
    """`Retry-After` in seconds: whole seconds, or an HTTP date."""
    value = _header(response.headers, "retry-after")
    if not value:
        return None
    value = value.strip()
    if re.fullmatch(r"[0-9]+", value):
        seconds = float(value)
        # A value above the largest safe integer names no wait: the SDK's own backoff applies. More digits than a
        # float holds reads as infinity, which is above that line too.
        return seconds if seconds <= _MAX_RETRY_AFTER_HEADER_SECONDS else None
    if re.match(r"^(?:[+-]|\d)", value):
        return None
    try:
        retry_at = parsedate_to_datetime(value)
        return max(0.0, retry_at.timestamp() - time.time())
    except (TypeError, ValueError, OverflowError):
        return None


def _retry_after_seconds(response: RunInfraResponse) -> Optional[float]:
    """The wait the API named with a response, in seconds.

    `Retry-After-Ms` is read first, because it can name a wait shorter than a
    second; `Retry-After` is read when the millisecond header is missing or
    malformed.
    """
    wait = _retry_after_ms_header_seconds(response)
    return wait if wait is not None else _retry_after_header_seconds(response)


def _retry_marker(response: RunInfraResponse, body_retryable: Optional[bool]) -> Optional[bool]:
    """What the API said about asking again.

    Read from the `x-should-retry` header and from `retryable` inside the error
    object. An explicit False from either wins. None when the API said nothing.
    """
    header = (_header(response.headers, "x-should-retry") or "").strip().lower()
    header_retryable = True if header == "true" else False if header == "false" else None
    if header_retryable is False or body_retryable is False:
        return False
    if header_retryable is True or body_retryable is True:
        return True
    return None


def _backoff_delay_seconds(attempt: int, base_seconds: float) -> float:
    """The SDK's own wait before it asks again when the API named none: exponential, with jitter, at most 30 seconds."""
    if base_seconds <= 0:
        return 0
    exponential = base_seconds * (2 ** max(0, attempt - 1))
    jitter = random.random() * base_seconds
    return min(30.0, exponential + jitter)


def _failed_response_may_be_asked_again(status: int, retryable: Optional[bool], batch: bool) -> bool:
    """Whether a failed response may be asked again, for a call that is safe to send again.

    The API's own word decides when it gave one: False never, True whatever the
    status. Without it the status decides. A 409 from a batch route is always
    final.
    """
    if batch and status == 409:
        return False
    if retryable is not None:
        return retryable
    return _is_retryable(status)


def _max_automatic_retry_after_seconds(status: int, batch: bool) -> float:
    """The longest wait named by the API that the SDK sleeps for before it asks again.

    A wait above it is raised at once with the wait on the error, so a call
    never blocks for minutes and never asks again sooner than it was told.
    """
    if batch and status == 503:
        return _BATCH_MAX_AUTOMATIC_RETRY_AFTER_SECONDS
    return _MAX_AUTOMATIC_RETRY_AFTER_SECONDS


def _read_failed_response_body(
    response: RunInfraResponse,
    sensitive_values: Iterable[str] = (),
) -> Optional[RunInfraError]:
    """Read a failed response's body into memory, once, and close it.

    The body is read before the SDK decides whether to ask again, because the
    API can mark a failure as retryable or not inside it. Returns the timeout
    when reading the body ran out of time, else None; a body that cannot be
    read for another reason is treated as empty.
    """
    if isinstance(response.body, bytes):
        return None
    body = response.body
    timeout: Optional[RunInfraError] = None
    data = b""
    try:
        data = b"".join(body)
    except Exception as exc:
        data = b""
        error = _transport_error(exc, _request_id_from_headers(response.headers), sensitive_values)
        if isinstance(error, RunInfraTimeoutError):
            timeout = error
    finally:
        close_body = getattr(body, "close", None)
        if callable(close_body):
            close_body()
    response.body = data
    return timeout


def _validated_header(value: str, name: str, max_length: int = 512) -> str:
    if len(value) > max_length or any(ord(ch) < 32 or ord(ch) > 126 for ch in value):
        raise RunInfraError(
            f"{name} must be ASCII and {max_length} characters or less",
            status=0,
            error_type="invalid_request_options",
        )
    return value


def _invalid_request_option(message: str) -> RunInfraError:
    return RunInfraError(message, status=0, error_type="invalid_request_options")


def _validated_identifier(value: Any, name: str, max_length: int = 512) -> str:
    if not isinstance(value, str):
        raise _invalid_request_option(f"{name} must be a string")
    parsed = value.strip()
    if not parsed:
        raise _invalid_request_option(f"{name} must not be blank")
    return _validated_header(parsed, name, max_length)


def _validated_model(value: Any) -> str:
    if not isinstance(value, str):
        raise _invalid_request_option("model must be a string")
    return _validated_identifier(value, "model")


def _validated_non_empty_string(value: Any, name: str) -> str:
    if not isinstance(value, str):
        raise _invalid_request_option(f"{name} must be a string")
    if not value.strip():
        raise _invalid_request_option(f"{name} must be a non-empty string")
    return value


def _validate_non_empty_list(value: Any, name: str) -> None:
    if not isinstance(value, list) or not value:
        raise _invalid_request_option(f"{name} must be a non-empty array")


def _validate_chat_messages(value: Any) -> None:
    _validate_non_empty_list(value, "messages")
    for index, message in enumerate(value):
        role = message.get("role") if isinstance(message, MappingABC) else None
        if not isinstance(role, str) or not role.strip():
            raise _invalid_request_option(f"messages[{index}] must be an object with a non-empty role")


def _validate_responses_input(value: Any) -> None:
    if isinstance(value, str) and value.strip():
        return
    if isinstance(value, list) and value:
        for index, item in enumerate(value):
            if not isinstance(item, MappingABC):
                raise _invalid_request_option(f"input[{index}] must be an object")
        return
    raise _invalid_request_option("input must be a non-empty string or array")


def _validate_embedding_input(value: Any) -> None:
    if isinstance(value, str) and value.strip():
        return
    if (
        isinstance(value, Sequence)
        and not isinstance(value, (str, bytes, bytearray))
        and len(value) > 0
        and all(isinstance(item, str) and item.strip() for item in value)
    ):
        return
    raise _invalid_request_option("input must be a non-empty string or array of strings")


def _validate_embedding_response_options(options: Mapping[str, Any]) -> None:
    encoding_format = options.get("encoding_format")
    if encoding_format is not None and encoding_format != "float":
        raise _invalid_request_option(
            "embedding encoding_format must be float for native SDK typed responses"
        )
    dimensions = options.get("dimensions")
    if dimensions is not None and (
        isinstance(dimensions, bool) or not isinstance(dimensions, int) or dimensions <= 0
    ):
        raise _invalid_request_option("embedding dimensions must be a positive integer")


def _json_payload_with_extra(
    fields: Mapping[str, object],
    extra_body: Optional[Mapping[str, object]],
    extra_body_open_keys: Iterable[str] = (),
) -> Dict[str, object]:
    # `extra_body_open_keys` names the fields that became keyword parameters
    # after callers had to put them in `extra_body`. They stay accepted there,
    # as long as the keyword is left out; naming one in both places is refused.
    payload = {key: value for key, value in fields.items() if value is not None}
    typed_keys = set(fields.keys()) - set(extra_body_open_keys)
    if extra_body is None:
        return payload
    if not isinstance(extra_body, MappingABC):
        raise _invalid_request_option("extra_body must be a mapping")
    for key, value in extra_body.items():
        if not isinstance(key, str) or not key.strip():
            raise _invalid_request_option("extra_body keys must be non-empty strings")
        if key in typed_keys or key in payload:
            raise _invalid_request_option(f"extra_body must not override typed request field: {key}")
        payload[key] = value
    return payload


def _validated_audio_file(value: Any) -> bytes:
    if not isinstance(value, (bytes, bytearray)):
        raise _invalid_request_option("file must be bytes or bytearray")
    data = bytes(value)
    if len(data) == 0:
        raise _invalid_request_option("file must not be empty")
    return data


def _validated_audio_bytes(value: Any, name: str = "audio") -> bytes:
    if not isinstance(value, (bytes, bytearray, memoryview)):
        raise _invalid_request_option(f"{name} must be bytes, bytearray, or memoryview")
    data = bytes(value)
    if len(data) == 0:
        raise _invalid_request_option(f"{name} must not be empty")
    return data


def _validated_mime_type(value: Any, name: str = "mime_type", fallback: str = "audio/wav") -> str:
    if value is None:
        return fallback
    if not isinstance(value, str):
        raise _invalid_request_option(f"{name} must be a string")
    parsed = value.strip()
    if not parsed:
        raise _invalid_request_option(f"{name} must not be blank")
    return _validated_header(parsed, name, 255)


def _validate_positive_number(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _invalid_request_option(f"{name} must be a positive number")
    parsed = float(value)
    if not math.isfinite(parsed) or parsed <= 0:
        raise _invalid_request_option(f"{name} must be a positive number")
    return parsed


def _validate_non_negative_number(value: Any, name: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise _invalid_request_option(f"{name} must be a non-negative number")
    parsed = float(value)
    if not math.isfinite(parsed) or parsed < 0:
        raise _invalid_request_option(f"{name} must be a non-negative number")
    return parsed


def _validate_non_negative_integer(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int) or value < 0:
        raise _invalid_request_option(f"{name} must be a non-negative integer")
    return value


_SDK_CONTROLLED_HEADERS = {
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
}


def _validated_custom_headers(headers: Any) -> Dict[str, str]:
    if headers is None:
        return {}
    if not isinstance(headers, MappingABC):
        raise RunInfraError(
            "headers must be a mapping of string names to string values",
            status=0,
            error_type="invalid_request_options",
        )
    validated: Dict[str, str] = {}
    for name, value in headers.items():
        if not isinstance(name, str) or not re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", name):
            raise RunInfraError(
                f"Invalid custom header name: {name}",
                status=0,
                error_type="invalid_request_options",
            )
        if name.strip().lower() in _SDK_CONTROLLED_HEADERS:
            raise RunInfraError(
                f"{name} is controlled by the RunInfra SDK",
                status=0,
                error_type="invalid_request_options",
            )
        if not isinstance(value, str):
            raise RunInfraError(
                f"{name} header value must be a string",
                status=0,
                error_type="invalid_request_options",
            )
        validated[name] = _validated_header(value, name)
    return validated


def _webhook_payload_bytes(payload: Union[str, bytes, bytearray]) -> bytes:
    if isinstance(payload, str):
        return payload.encode("utf-8")
    if isinstance(payload, (bytes, bytearray)):
        return bytes(payload)
    raise WebhookVerificationError("Webhook payload must be a string, bytes, or bytearray.")


def _parse_webhook_signature_header(signature_header: str) -> tuple[int, List[str]]:
    if not isinstance(signature_header, str):
        raise WebhookVerificationError("Webhook signature header must be a string.")
    if len(signature_header) > _WEBHOOK_SIGNATURE_HEADER_MAX_LENGTH:
        raise WebhookVerificationError("Webhook signature header is too large.")
    timestamp: Optional[int] = None
    signatures: List[str] = []
    for part in signature_header.split(","):
        key, separator, value = part.partition("=")
        if not separator:
            continue
        key = key.strip()
        value = value.strip()
        if key == "t":
            if re.fullmatch(r"[0-9]+", value) is None:
                raise WebhookVerificationError("Webhook signature timestamp must be a non-negative integer.")
            try:
                timestamp = int(value)
            except ValueError as exc:
                raise WebhookVerificationError("Webhook signature timestamp is invalid.") from exc
        elif key == "v1" and value:
            signatures.append(value)
    if timestamp is None:
        raise WebhookVerificationError("Webhook signature timestamp is missing.")
    if not signatures:
        raise WebhookVerificationError("Webhook signature is missing.")
    return timestamp, signatures


def _webhook_expected_signature(payload: bytes, timestamp: int, secret: str) -> str:
    signed_payload = str(timestamp).encode("utf-8") + b"." + payload
    return hmac.new(secret.encode("utf-8"), signed_payload, hashlib.sha256).hexdigest()


def verify_webhook_signature(
    *,
    payload: Union[str, bytes, bytearray],
    signature_header: str,
    secret: str,
    tolerance_seconds: float = 300,
    now: Optional[float] = None,
) -> bool:
    if not isinstance(secret, str) or not secret.strip():
        raise WebhookVerificationError("Webhook secret is required.")
    if not isinstance(tolerance_seconds, (int, float)) or not math.isfinite(tolerance_seconds) or tolerance_seconds < 0:
        raise WebhookVerificationError("Webhook tolerance must be a non-negative number.")
    timestamp, signatures = _parse_webhook_signature_header(signature_header)
    current_time = time.time() if now is None else now
    if not isinstance(current_time, (int, float)) or not math.isfinite(current_time) or current_time < 0:
        raise WebhookVerificationError("Webhook verification clock must be a non-negative finite number.")
    if abs(current_time - timestamp) > tolerance_seconds:
        raise WebhookVerificationError("Webhook signature timestamp is outside the allowed tolerance.")
    expected = _webhook_expected_signature(_webhook_payload_bytes(payload), timestamp, secret)
    if not any(hmac.compare_digest(expected, signature.lower()) for signature in signatures):
        raise WebhookVerificationError("Webhook signature verification failed.")
    return True


def construct_webhook_event(
    *,
    payload: Union[str, bytes, bytearray],
    signature_header: str,
    secret: str,
    tolerance_seconds: float = 300,
    now: Optional[float] = None,
) -> Any:
    raw_payload = _webhook_payload_bytes(payload)
    verify_webhook_signature(
        payload=raw_payload,
        signature_header=signature_header,
        secret=secret,
        tolerance_seconds=tolerance_seconds,
        now=now,
    )
    try:
        return json.loads(raw_payload.decode("utf-8"))
    except Exception as exc:
        raise WebhookVerificationError("Webhook payload must be valid JSON.") from exc


_BATCH_DELIVERY_SECRET_PREFIX = "whsec_"
# The longest Retry-After a batch route's 503 is waited for. A longer wait is the caller's to plan.
_BATCH_MAX_AUTOMATIC_RETRY_AFTER_SECONDS = 5.0
# The largest whole number a delivery's timestamp may be: the largest one every runtime holds exactly.
_BATCH_DELIVERY_MAX_TIMESTAMP = 9007199254740991


def _batch_delivery_header(headers: Any, name: str) -> str:
    items = getattr(headers, "items", None)
    if not callable(items):
        raise WebhookVerificationError("Batch delivery headers must be a mapping of header names to values.")
    matches = [value for key, value in items() if isinstance(key, str) and key.lower() == name]
    if len(matches) > 1:
        raise WebhookVerificationError(f"Batch delivery header {name} is present more than once.")
    value = matches[0] if matches else None
    if isinstance(value, (list, tuple)):
        if len(value) > 1:
            raise WebhookVerificationError(f"Batch delivery header {name} is present more than once.")
        value = value[0] if value else None
    if not isinstance(value, str) or not value.strip():
        raise WebhookVerificationError(f"Batch delivery header {name} is missing.")
    if len(value) > _WEBHOOK_SIGNATURE_HEADER_MAX_LENGTH:
        raise WebhookVerificationError(f"Batch delivery header {name} is too large.")
    return value.strip()


def _batch_delivery_secret_key(secret: Any) -> bytes:
    if not isinstance(secret, str) or not secret.strip():
        raise WebhookVerificationError("Batch signing secret is required.")
    encoded = secret.strip()
    if encoded.startswith(_BATCH_DELIVERY_SECRET_PREFIX):
        encoded = encoded[len(_BATCH_DELIVERY_SECRET_PREFIX):]
    if not encoded or len(encoded) % 4 != 0 or re.fullmatch(r"[A-Za-z0-9+/]+={0,2}", encoded) is None:
        raise WebhookVerificationError("Batch signing secret must be whsec_ followed by base64.")
    try:
        return base64.b64decode(encoded, validate=True)
    except ValueError as exc:
        raise WebhookVerificationError("Batch signing secret must be whsec_ followed by base64.") from exc


def verify_batch_delivery(
    *,
    payload: Union[str, bytes, bytearray],
    headers: Mapping[str, Any],
    secret: str,
    tolerance_seconds: Optional[float] = 300,
    now: Optional[float] = None,
) -> BatchDelivery:
    """Verify one batch delivery posted to your own address and return it parsed.

    The result is the test delivery of `batches.create()`, one line's answer,
    or one line's error (`BatchTestDelivery`, `BatchAnswerDelivery`,
    `BatchErrorDelivery`).

    Pass the RAW request body, exactly the bytes that arrived, and the
    request's headers in any case. The signature is the Standard Webhooks one:
    header `webhook-signature` holds `v1,` followed by the base64 HMAC-SHA-256
    of `<webhook-id>.<webhook-timestamp>.<raw body>`, compared in constant
    time. Parsing the body and serializing it again changes the bytes and fails
    the check.

    `secret` is the workspace's batch signing secret as the dashboard shows it:
    `whsec_` followed by base64. The HMAC key is the base64-DECODED bytes after
    the prefix, not the text. Header `x-rightnow-signature-version` names the
    version of the secret that signed; a rotated secret stops verifying.

    The delivery's `webhook-timestamp` must be within 300 seconds of the clock
    by default, so a captured delivery cannot be replayed later. A number in
    `tolerance_seconds` sets another tolerance, `tolerance_seconds=None` turns
    the check off, and `now` sets the clock it is compared with.

    ANSWERING THE TEST DELIVERY: `batches.create()` posts
    `{"id": ..., "test": true, "value": ...}` to the destination before it
    answers, and the address passes only when it replies 2xx with a body that
    CONTAINS the posted `value`. A fixed `200 OK` fails the create with
    `destination_unreachable`. Line deliveries (`test` false) are acknowledged
    by any 2xx. Each answered line is sent to the address once: if the address
    does not answer 2xx in time, the line is counted `undelivered`, it is not
    charged, and it is not sent again.

    Raises `WebhookVerificationError` when a header is missing, the signature
    does not match, the timestamp is outside the tolerance, or the body is not
    a delivery. Every failure of this helper is a `WebhookVerificationError`.
    """
    try:
        return _verified_batch_delivery(payload, headers, secret, tolerance_seconds, now)
    except WebhookVerificationError:
        raise
    except (ArithmeticError, LookupError, TypeError, ValueError) as exc:
        raise WebhookVerificationError("Batch delivery could not be verified.") from exc


def _is_finite_non_negative_number(value: Any) -> bool:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value) and value >= 0
    except OverflowError:
        # A whole number too large for a float: no clock and no tolerance is that large.
        return False


def _verified_batch_delivery(
    payload: Union[str, bytes, bytearray],
    headers: Mapping[str, Any],
    secret: str,
    tolerance_seconds: Optional[float],
    now: Optional[float],
) -> BatchDelivery:
    key = _batch_delivery_secret_key(secret)
    if tolerance_seconds is not None and not _is_finite_non_negative_number(tolerance_seconds):
        raise WebhookVerificationError(
            "Batch delivery tolerance must be a non-negative number, or None to turn the check off."
        )
    delivery_id = _batch_delivery_header(headers, "webhook-id")
    timestamp = _batch_delivery_header(headers, "webhook-timestamp")
    signature_header = _batch_delivery_header(headers, "webhook-signature")
    # Digits only, and no larger than a time can be: a header of hundreds of digits is refused here, before
    # anything is converted or compared.
    timestamp_digits = timestamp.lstrip("0") or "0"
    if (
        re.fullmatch(r"[0-9]+", timestamp) is None
        or len(timestamp_digits) > len(str(_BATCH_DELIVERY_MAX_TIMESTAMP))
        or int(timestamp_digits) > _BATCH_DELIVERY_MAX_TIMESTAMP
    ):
        raise WebhookVerificationError("Batch delivery timestamp must be a non-negative integer.")
    if tolerance_seconds is not None:
        current_time = time.time() if now is None else now
        if not _is_finite_non_negative_number(current_time):
            raise WebhookVerificationError("Batch delivery verification clock must be a non-negative finite number.")
        if abs(current_time - int(timestamp_digits)) > tolerance_seconds:
            raise WebhookVerificationError("Batch delivery timestamp is outside the allowed tolerance.")
    raw_payload = _webhook_payload_bytes(payload)
    signed = delivery_id.encode("utf-8") + b"." + timestamp.encode("utf-8") + b"." + raw_payload
    expected = b"v1," + base64.b64encode(hmac.new(key, signed, hashlib.sha256).digest())
    # Standard Webhooks allows several space-separated signatures; one match is enough.
    verified = False
    for candidate in signature_header.split(" "):
        if candidate and hmac.compare_digest(candidate.encode("utf-8"), expected):
            verified = True
    if not verified:
        raise WebhookVerificationError("Batch delivery signature verification failed.")
    try:
        parsed = json.loads(raw_payload.decode("utf-8"))
    except Exception as exc:
        raise WebhookVerificationError("Batch delivery payload must be valid JSON.") from exc
    if (
        not isinstance(parsed, dict)
        or not isinstance(parsed.get("id"), str)
        or not isinstance(parsed.get("test"), bool)
    ):
        raise WebhookVerificationError("Batch delivery payload is not a batch delivery.")
    return parsed  # type: ignore[return-value]


def _request_option(options: Optional[Mapping[str, Any]], *names: str) -> Any:
    if not options:
        return None
    for name in names:
        if name in options:
            return options[name]
    return None


def _request_option_or(options: Optional[Mapping[str, Any]], default: Any, *names: str) -> Any:
    value = _request_option(options, *names)
    return default if value is None else value


_REQUEST_OPTION_KEYS = {
    "client_request_id",
    "clientRequestId",
    "idempotency_key",
    "idempotencyKey",
    "timeout_seconds",
    "timeoutSeconds",
    "max_retries",
    "maxRetries",
    "retry_base_seconds",
    "retryBaseSeconds",
    "headers",
}


_REQUEST_OPTION_ALIASES = (
    ("client_request_id", "clientRequestId"),
    ("idempotency_key", "idempotencyKey"),
    ("timeout_seconds", "timeoutSeconds"),
    ("max_retries", "maxRetries"),
    ("retry_base_seconds", "retryBaseSeconds"),
)


def _validated_request_options(options: Optional[Mapping[str, Any]]) -> Mapping[str, Any]:
    if options is None:
        return {}
    if not isinstance(options, MappingABC):
        raise _invalid_request_option("request_options must be a mapping")
    for key in options.keys():
        if key not in _REQUEST_OPTION_KEYS:
            raise _invalid_request_option(f"Unknown request option: {key}")
    for primary, alias in _REQUEST_OPTION_ALIASES:
        if primary in options and alias in options:
            raise _invalid_request_option(f"Conflicting request option aliases: {primary}, {alias}")
    return options


def _is_timeout_error(error: BaseException) -> bool:
    if isinstance(error, TimeoutError):
        return True
    reason = getattr(error, "reason", None)
    if isinstance(reason, TimeoutError):
        return True
    message = str(error).lower()
    return "timed out" in message or "timeout" in message


def _redacted_error_message(error: BaseException, sensitive_values: Iterable[str] = ()) -> str:
    message = str(error)
    for value in sensitive_values:
        if value:
            message = message.replace(value, "[redacted]")
    return message


def _redacted_error_metadata(value: Optional[str], sensitive_values: Iterable[str] = ()) -> Optional[str]:
    if value is None:
        return None
    redacted = value
    for sensitive_value in sensitive_values:
        if sensitive_value:
            redacted = redacted.replace(sensitive_value, "[redacted]")
    return redacted


def _redacted_runinfra_error(
    error: RunInfraError,
    sensitive_values: Iterable[str] = (),
) -> RunInfraError:
    sensitive = tuple(sensitive_values)
    redacted = _redacted_runinfra_error_copy(error, sensitive)
    # A batch refusal's cause, the retry marker and the request id the SDK sent
    # ride every error class; the copy rebuilds each class from its own
    # constructor, which names none of them.
    redacted.reason = _redacted_error_metadata(getattr(error, "reason", None), sensitive)
    redacted.retryable = getattr(error, "retryable", None)
    redacted.client_request_id = getattr(error, "client_request_id", None)
    return redacted


def _redacted_runinfra_error_copy(
    error: RunInfraError,
    sensitive_values: Iterable[str] = (),
) -> RunInfraError:
    sensitive = tuple(sensitive_values)
    message = _redacted_error_message(error, sensitive)
    code = _redacted_error_metadata(error.code, sensitive)
    param = _redacted_error_metadata(error.param, sensitive)
    if isinstance(error, RunInfraStreamParseError):
        return RunInfraStreamParseError(message, request_id=error.request_id)
    if isinstance(error, RunInfraStreamIncompleteError):
        return RunInfraStreamIncompleteError(message, request_id=error.request_id)
    if isinstance(error, UnsupportedOperationError):
        return UnsupportedOperationError(message)
    if isinstance(error, WebhookVerificationError):
        return WebhookVerificationError(message)
    if isinstance(error, InsufficientCreditsError):
        # Carry the structured top-up fields through redaction (they hold no secrets).
        return InsufficientCreditsError(
            message,
            status=error.status,
            error_type=error.type,
            request_id=error.request_id,
            retry_after_seconds=error.retry_after_seconds,
            code=code,
            param=param,
            current_balance_cents=error.current_balance_cents,
            required_cents=error.required_cents,
            topup_url=error.topup_url,
        )
    try:
        return error.__class__(
            message,
            status=error.status,
            error_type=error.type,
            request_id=error.request_id,
            retry_after_seconds=error.retry_after_seconds,
            code=code,
            param=param,
        )
    except TypeError:
        return RunInfraError(
            message,
            status=error.status,
            error_type=error.type,
            request_id=error.request_id,
            retry_after_seconds=error.retry_after_seconds,
            code=code,
            param=param,
        )


def _transport_error(
    error: BaseException,
    request_id: Optional[str] = None,
    sensitive_values: Iterable[str] = (),
) -> RunInfraError:
    if isinstance(error, RunInfraError):
        return _redacted_runinfra_error(error, sensitive_values)
    message = _redacted_error_message(error, sensitive_values)
    if _is_timeout_error(error):
        return RunInfraTimeoutError(
            message,
            status=0,
            error_type="timeout_error",
            request_id=request_id,
        )
    return RunInfraConnectionError(
        message,
        status=0,
        error_type="connection_error",
        request_id=request_id,
    )


class _TransportBodyReadError(Exception):
    def __init__(self, error: RunInfraError) -> None:
        super().__init__(str(error))
        self.error = error


def _request_id_from_headers(headers: Mapping[str, str]) -> Optional[str]:
    for key, value in headers.items():
        if key.lower() == "x-request-id":
            return value
    return None


def _idempotent_replay_from_headers(headers: Mapping[str, str]) -> bool:
    for key, value in headers.items():
        if key.lower() == "x-runinfra-idempotent-replay":
            return value.strip().lower() == "true"
    return False


def _batch_refusal_error(
    response: RunInfraResponse,
    *,
    message: str,
    error_type: str,
    code: Optional[str],
    param: Optional[str],
    reason: Optional[str],
    request_id: Optional[str],
    current_balance_cents: Optional[int],
    required_cents: Optional[int],
    topup_url: Optional[str],
) -> RunInfraError:
    """A batch route's refusal as the SDK's typed error.

    The class follows the HTTP status as on every route, with one difference:
    only `model_not_sold` is a `ModelNotFoundError` (an unknown batch id is a
    plain 404 `RunInfraError` that keeps the gateway's own type). The refusal
    also keeps the gateway's cause word as `reason`.
    """
    status = response.status
    retry_after_seconds = _retry_after_seconds(response)
    error: RunInfraError
    if status == 401:
        error = AuthenticationError(
            message,
            status=status,
            error_type="auth_error",
            request_id=request_id,
            retry_after_seconds=retry_after_seconds,
            code=code,
            param=param,
        )
    elif status == 403:
        error = PermissionDeniedError(
            message,
            status=status,
            error_type=error_type if error_type != "api_error" else "permission_denied",
            request_id=request_id,
            retry_after_seconds=retry_after_seconds,
            code=code,
            param=param,
        )
    elif status == 402:
        error = InsufficientCreditsError(
            message,
            status=status,
            error_type="insufficient_credits",
            request_id=request_id,
            retry_after_seconds=retry_after_seconds,
            code=code,
            param=param,
            current_balance_cents=current_balance_cents,
            required_cents=required_cents,
            topup_url=topup_url,
        )
    elif status == 404 and code == "model_not_sold":
        error = ModelNotFoundError(
            message,
            status=status,
            error_type="model_not_found",
            request_id=request_id,
            retry_after_seconds=retry_after_seconds,
            code=code,
            param=param,
        )
    elif status == 429:
        error = RateLimitError(
            message,
            status=status,
            error_type="rate_limit_error",
            request_id=request_id,
            retry_after_seconds=retry_after_seconds,
            code=code,
            param=param,
        )
    else:
        error = RunInfraError(
            message,
            status=status,
            error_type=error_type,
            request_id=request_id,
            retry_after_seconds=retry_after_seconds,
            code=code,
            param=param,
        )
    error.reason = reason
    return error


def _error_from_response(response: RunInfraResponse, batch: bool = False) -> RunInfraError:
    """A failed response as the SDK's typed error.

    Whatever its class and status, the error keeps the wait the API named
    (`Retry-After-Ms`, else `Retry-After`) as `retry_after_seconds`, and what
    the API said about asking again (`x-should-retry`, `error.retryable`) as
    `retryable`. A batch route's refusal also keeps its cause word.
    """
    message = f"RunInfra request failed with status {response.status}"
    error_type = "api_error"
    code: Optional[str] = None
    param: Optional[str] = None
    reason: Optional[str] = None
    body_retryable: Optional[bool] = None
    current_balance_cents: Optional[int] = None
    required_cents: Optional[int] = None
    topup_url: Optional[str] = None
    try:
        body = response.json()
        if isinstance(body, dict) and isinstance(body.get("error"), dict):
            error = body["error"]
            if isinstance(error.get("message"), str):
                message = error["message"]
            if isinstance(error.get("type"), str):
                error_type = error["type"]
            if isinstance(error.get("code"), str):
                code = error["code"]
            if isinstance(error.get("param"), str):
                param = error["param"]
            if isinstance(error.get("reason"), str):
                reason = error["reason"]
            if isinstance(error.get("retryable"), bool):
                body_retryable = error["retryable"]
            # Structured remediation fields the gateway ships on 402.
            # `bool` is a subclass of `int`, so exclude it explicitly.
            if isinstance(error.get("current_balance_cents"), int) and not isinstance(
                error.get("current_balance_cents"), bool
            ):
                current_balance_cents = error["current_balance_cents"]
            if isinstance(error.get("required_cents"), int) and not isinstance(
                error.get("required_cents"), bool
            ):
                required_cents = error["required_cents"]
            if isinstance(error.get("topup_url"), str):
                topup_url = error["topup_url"]
    except Exception:
        pass

    request_id = _request_id_from_headers(response.headers)
    typed_error: RunInfraError
    if batch:
        typed_error = _batch_refusal_error(
            response,
            message=message,
            error_type=error_type,
            code=code,
            param=param,
            reason=reason,
            request_id=request_id,
            current_balance_cents=current_balance_cents,
            required_cents=required_cents,
            topup_url=topup_url,
        )
    elif response.status == 401:
        typed_error = AuthenticationError(
            message,
            status=response.status,
            error_type="auth_error",
            request_id=request_id,
            code=code,
            param=param,
        )
    elif response.status == 403:
        # Default to "permission_denied", but keep a more specific gateway
        # discriminator (e.g. "byoc_plan_required") so callers can branch on
        # `.type` instead of regex-scraping the message.
        typed_error = PermissionDeniedError(
            message,
            status=response.status,
            error_type=error_type if error_type != "api_error" else "permission_denied",
            request_id=request_id,
            code=code,
            param=param,
        )
    elif response.status == 402:
        typed_error = InsufficientCreditsError(
            message,
            status=response.status,
            error_type="insufficient_credits",
            request_id=request_id,
            code=code,
            param=param,
            current_balance_cents=current_balance_cents,
            required_cents=required_cents,
            topup_url=topup_url,
        )
    elif response.status == 404 or error_type == "model_not_found":
        typed_error = ModelNotFoundError(
            message,
            status=response.status,
            error_type="model_not_found",
            request_id=request_id,
            code=code,
            param=param,
        )
    elif response.status == 429:
        typed_error = RateLimitError(
            message,
            status=response.status,
            error_type="rate_limit_error",
            request_id=request_id,
            code=code,
            param=param,
        )
    elif error_type == "deployment_error":
        typed_error = DeploymentError(
            message,
            status=response.status,
            error_type=error_type,
            request_id=request_id,
            code=code,
            param=param,
        )
    else:
        typed_error = RunInfraError(
            message,
            status=response.status,
            error_type=error_type,
            request_id=request_id,
            code=code,
            param=param,
        )
    typed_error.retry_after_seconds = _retry_after_seconds(response)
    typed_error.retryable = _retry_marker(response, body_retryable)
    return typed_error


def _json_body(payload: Mapping[str, Any]) -> bytes:
    try:
        return json.dumps(payload, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, OverflowError) as exc:
        raise _invalid_request_option(
            "JSON request body must be serializable and contain only finite numbers"
        ) from exc


def _json_response(response: RunInfraResponse, sensitive_values: Iterable[str] = ()) -> Any:
    request_id = _request_id_from_headers(response.headers)
    error_to_raise: Optional[RunInfraError] = None
    try:
        payload = response.json()
    except RunInfraError as exc:
        error_to_raise = _redacted_runinfra_error(exc, sensitive_values)
    except Exception as exc:
        error_to_raise = _transport_error(
            exc,
            request_id=request_id,
            sensitive_values=sensitive_values,
        )
    if error_to_raise is not None:
        raise error_to_raise
    return _json_answer_with_metadata(payload, response)


def _json_answer_with_metadata(payload: Any, response: RunInfraResponse) -> Any:
    """A parsed JSON answer as the SDK returns it.

    The object, with `_request_id` and `_idempotent_replay` when the response
    headers carry them. An answer that is not an object is a shape error.
    """
    request_id = _request_id_from_headers(response.headers)
    if isinstance(payload, dict):
        metadata: Dict[str, Any] = {}
        if request_id:
            metadata["_request_id"] = request_id
        if _idempotent_replay_from_headers(response.headers):
            metadata["_idempotent_replay"] = True
        return {**payload, **metadata} if metadata else payload
    raise RunInfraError(
        f"RunInfra JSON response shape error: expected object, got {_json_payload_kind(payload)}.",
        status=response.status,
        error_type="response_shape_error",
        request_id=request_id,
    )


def _stream_answered_with_json(headers: Mapping[str, str]) -> bool:
    """Whether a successful answer to a streamed call is one JSON object instead of an event stream.

    The API answers this way when a streamed call repeats an `Idempotency-Key`
    it has already answered: `Content-Type: application/json`,
    `X-RunInfra-Idempotent-Replay: true` and one object.
    """
    content_type = (_header(headers, "content-type") or "").split(";", 1)[0].strip().lower()
    if content_type == "text/event-stream":
        return False
    if content_type == "application/json" or content_type.endswith("+json"):
        return True
    return _idempotent_replay_from_headers(headers)


def _stream_response(
    response: RunInfraResponse,
    sensitive_values: Iterable[str] = (),
    client_request_id: Optional[str] = None,
) -> RunInfraStream:
    """The stream of a successful answer to a streamed call.

    `client_request_id` is the X-Client-Request-Id the SDK sent with the call.
    """
    stream = RunInfraStream(response.body, _request_id_from_headers(response.headers), sensitive_values)
    stream._client_request_id = client_request_id
    if _stream_answered_with_json(response.headers):
        stream._answered_with_json = response
    return stream


def _json_payload_kind(payload: Any) -> str:
    if payload is None:
        return "null"
    if isinstance(payload, list):
        return "array"
    if isinstance(payload, str):
        return "string"
    return type(payload).__name__


def _validated_multipart_field_name(name: str) -> str:
    if not isinstance(name, str) or re.fullmatch(r"[!#$%&'*+.^_`|~0-9A-Za-z-]+", name) is None:
        raise _invalid_request_option("multipart field names must be ASCII tokens")
    return name


def _validated_multipart_filename(filename: str) -> str:
    if not isinstance(filename, str):
        raise _invalid_request_option("filename must be a string")
    if not filename.strip():
        raise _invalid_request_option("filename must not be blank")
    _validated_header(filename, "filename", 255)
    if any(ch in {'"', "\\"} for ch in filename):
        raise _invalid_request_option("filename must not contain quotes or backslashes")
    return filename


def _validated_multipart_content_type(content_type: str) -> str:
    if not isinstance(content_type, str):
        raise _invalid_request_option("content_type must be a string")
    if not content_type.strip():
        raise _invalid_request_option("content_type must not be blank")
    return _validated_header(content_type, "content_type", 255)


def _validated_multipart_field_value(value: Any) -> str:
    if not isinstance(value, (str, int, float, bool)):
        raise _invalid_request_option("multipart field values must be strings, numbers, or booleans")
    if isinstance(value, float) and not math.isfinite(value):
        raise _invalid_request_option("multipart field values must contain only finite numbers")
    return str(value)


def _validate_transcription_response_format(options: Mapping[str, Any]) -> None:
    response_format = options.get("response_format")
    if response_format is not None and response_format not in {"json", "verbose_json"}:
        raise _invalid_request_option(
            "audio transcription response_format must be json or verbose_json for native SDK typed responses"
        )


def _multipart_body(fields: Mapping[str, str], files: Mapping[str, tuple[str, bytes, str]]) -> tuple[bytes, str]:
    boundary = f"runinfra-{uuid.uuid4().hex}"
    chunks: List[bytes] = []
    for name, value in fields.items():
        name = _validated_multipart_field_name(name)
        chunks.extend(
            [
                f"--{boundary}\r\n".encode("utf-8"),
                f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode("utf-8"),
                value.encode("utf-8"),
                b"\r\n",
            ]
        )
    for name, (filename, content, content_type) in files.items():
        name = _validated_multipart_field_name(name)
        filename = _validated_multipart_filename(filename)
        content_type = _validated_multipart_content_type(content_type)
        chunks.extend(
            [
                f"--{boundary}\r\n".encode("utf-8"),
                (
                    f'Content-Disposition: form-data; name="{name}"; '
                    f'filename="{filename}"\r\n'
                ).encode("utf-8"),
                f"Content-Type: {content_type}\r\n\r\n".encode("utf-8"),
                content,
                b"\r\n",
            ]
        )
    chunks.append(f"--{boundary}--\r\n".encode("utf-8"))
    return b"".join(chunks), f"multipart/form-data; boundary={boundary}"


class _Requester:
    def __init__(
        self,
        *,
        api_key: str,
        base_url: str,
        pipeline_scoped: bool,
        transport: Transport,
        max_retries: int,
        retry_base_seconds: float,
        default_timeout_seconds: Optional[float] = None,
    ) -> None:
        self.api_key = api_key
        self.base_url = base_url
        self.pipeline_scoped = pipeline_scoped
        self.transport = transport
        self.max_retries = max_retries
        self.retry_base_seconds = retry_base_seconds
        self.default_timeout_seconds = default_timeout_seconds

    def request(
        self,
        path: str,
        *,
        method: str = "POST",
        json_payload: Optional[Mapping[str, Any]] = None,
        body: Optional[bytes] = None,
        headers: Optional[Mapping[str, str]] = None,
        stream: bool = False,
        idempotent_replay_safe: bool = False,
        request_options: Optional[Mapping[str, Any]] = None,
        batch: bool = False,
        minimum_default_timeout_seconds: Optional[float] = None,
        sent_client_request_ids: Optional[List[str]] = None,
    ) -> RunInfraResponse:
        # `batch` marks a batch route: its refusals keep the gateway's reason on
        # the typed error. A 409 is a final answer that is never retried, and a
        # 503 that asks for a wait above five seconds is raised at once.
        # `minimum_default_timeout_seconds` is the smallest timeout the call
        # uses when the caller names none for it. `sent_client_request_ids`,
        # when a list is given, receives the X-Client-Request-Id the SDK sends
        # with the call.
        #
        # A call is sent again only when it is safe to: a GET, or a JSON POST
        # that is marked replay-safe, is not streamed and carries an
        # idempotency key. Such a call is asked again after a transport failure
        # and after a failed response the API marks retryable (x-should-retry,
        # error.retryable) or, when the API says nothing, one with a retryable
        # status. It is never asked again after a timeout, after the API said
        # not to, or when the API names a wait longer than the SDK sleeps for.
        request_options = _validated_request_options(request_options)
        client_request_id = _request_option(
            request_options,
            "client_request_id",
            "clientRequestId",
        )
        idempotency_key = _request_option(
            request_options,
            "idempotency_key",
            "idempotencyKey",
        )
        option_headers = _validated_custom_headers(_request_option(request_options, "headers"))
        request_headers = {
            **option_headers,
            "Authorization": f"Bearer {self.api_key}",
            "X-RunInfra-SDK": "python",
            "X-RunInfra-SDK-Version": __version__,
            "X-Client-Request-Id": (
                str(uuid.uuid4())
                if client_request_id is None
                else _validated_identifier(client_request_id, "client_request_id")
            ),
        }
        has_idempotency_key = idempotency_key is not None
        if has_idempotency_key:
            request_headers["Idempotency-Key"] = _validated_identifier(
                idempotency_key,
                "idempotency_key",
                255,
            )
        if headers:
            request_headers.update(headers)
        if json_payload is not None:
            request_headers["Content-Type"] = "application/json"
            body = _json_body(json_payload)

        attempt = 0
        max_retries = _validate_non_negative_integer(
            _request_option_or(request_options, self.max_retries, "max_retries", "maxRetries"),
            "max_retries",
        )
        retry_base_seconds = _validate_non_negative_number(
            _request_option_or(
                request_options,
                self.retry_base_seconds,
                "retry_base_seconds",
                "retryBaseSeconds",
            ),
            "retry_base_seconds",
        )
        timeout_seconds = _request_option(request_options, "timeout_seconds", "timeoutSeconds")
        validated_timeout_seconds = (
            None
            if timeout_seconds is None
            else _validate_positive_number(timeout_seconds, "timeout_seconds")
        )
        if (
            validated_timeout_seconds is None
            and minimum_default_timeout_seconds is not None
            and self.default_timeout_seconds is not None
            and self.default_timeout_seconds < minimum_default_timeout_seconds
        ):
            validated_timeout_seconds = minimum_default_timeout_seconds
        method_name = method.upper()
        has_replayable_json_body = json_payload is not None and not stream and idempotent_replay_safe
        can_retry = method_name in {"GET", "HEAD"} or (
            has_idempotency_key and has_replayable_json_body
        )
        sent_client_request_id = request_headers["X-Client-Request-Id"]
        if sent_client_request_ids is not None:
            sent_client_request_ids.append(sent_client_request_id)
        while True:
            error_to_raise: Optional[RunInfraError] = None
            may_send_again = False
            try:
                response = self.transport(
                    RunInfraRequest(
                        method=method_name,
                        url=f"{self.base_url}{path}",
                        headers=request_headers,
                        body=body,
                        stream=stream,
                        timeout_seconds=validated_timeout_seconds,
                    )
                )
            except _TransportBodyReadError as exc:
                error_to_raise = _redacted_runinfra_error(exc.error, [self.api_key])
                may_send_again = True
            except RunInfraError as exc:
                error_to_raise = _redacted_runinfra_error(exc, [self.api_key])
            except Exception as exc:
                error_to_raise = _transport_error(exc, sensitive_values=[self.api_key])
                may_send_again = True
            if error_to_raise is not None:
                if isinstance(error_to_raise, RunInfraTimeoutError):
                    # The call ran out of time. It is never sent again: the API may still be working on it,
                    # and a second send could run and charge it twice.
                    error_to_raise.client_request_id = sent_client_request_id
                elif may_send_again and can_retry and attempt < max_retries:
                    attempt += 1
                    time.sleep(_backoff_delay_seconds(attempt, retry_base_seconds))
                    continue
                raise error_to_raise

            if 200 <= response.status < 300:
                return response
            # The error body is read before the SDK decides anything: the API can say inside it whether
            # asking again helps.
            body_timeout = _read_failed_response_body(response, [self.api_key])
            if body_timeout is not None:
                body_timeout.client_request_id = sent_client_request_id
                raise body_timeout
            failure = _redacted_runinfra_error(_error_from_response(response, batch), [self.api_key])
            if (
                not can_retry
                or attempt >= max_retries
                or not _failed_response_may_be_asked_again(response.status, failure.retryable, batch)
            ):
                raise failure
            wait_seconds = failure.retry_after_seconds
            # A wait longer than the SDK sleeps for is the caller's to plan: raise now, with the wait on the error.
            if wait_seconds is not None and wait_seconds > _max_automatic_retry_after_seconds(response.status, batch):
                raise failure
            attempt += 1
            time.sleep(
                wait_seconds if wait_seconds is not None else _backoff_delay_seconds(attempt, retry_base_seconds)
            )


class _ChatCompletions:
    def __init__(self, requester: _Requester) -> None:
        self._requester = requester

    @overload
    def create(
        self,
        *,
        model: str,
        messages: Sequence[Union[ChatMessage, Mapping[str, object]]],
        stream: Literal[True],
        temperature: Optional[float] = None,
        top_p: Optional[float] = None,
        max_tokens: Optional[int] = None,
        max_completion_tokens: Optional[int] = None,
        stop: Optional[Union[str, Sequence[str]]] = None,
        presence_penalty: Optional[float] = None,
        frequency_penalty: Optional[float] = None,
        user: Optional[str] = None,
        metadata: Optional[Mapping[str, object]] = None,
        stream_options: Optional[Mapping[str, object]] = None,
        tools: Optional[Sequence[Mapping[str, object]]] = None,
        tool_choice: Optional[Union[str, Mapping[str, object]]] = None,
        response_format: Optional[Mapping[str, object]] = None,
        seed: Optional[int] = None,
        logprobs: Optional[bool] = None,
        top_logprobs: Optional[int] = None,
        top_k: Optional[int] = None,
        min_p: Optional[float] = None,
        repetition_penalty: Optional[float] = None,
        n: Optional[int] = None,
        best_of: Optional[int] = None,
        logit_bias: Optional[Mapping[str, float]] = None,
        parallel_tool_calls: Optional[bool] = None,
        reasoning_effort: Optional[str] = None,
        reasoning: Optional[Mapping[str, object]] = None,
        include_reasoning: Optional[bool] = None,
        prompt_cache_key: Optional[str] = None,
        service_tier: Optional[str] = None,
        store: Optional[bool] = None,
        safety_identifier: Optional[str] = None,
        modalities: Optional[Sequence[str]] = None,
        audio: Optional[Mapping[str, object]] = None,
        prediction: Optional[Mapping[str, object]] = None,
        verbosity: Optional[str] = None,
        web_search_options: Optional[Mapping[str, object]] = None,
        moderation: Optional[object] = None,
        functions: Optional[Sequence[Mapping[str, object]]] = None,
        function_call: Optional[Union[str, Mapping[str, object]]] = None,
        request_options: Optional[Mapping[str, Any]] = None,
        extra_body: Optional[Mapping[str, object]] = None,
    ) -> RunInfraStream: ...

    @overload
    def create(
        self,
        *,
        model: str,
        messages: Sequence[Union[ChatMessage, Mapping[str, object]]],
        stream: Literal[False] = False,
        temperature: Optional[float] = None,
        top_p: Optional[float] = None,
        max_tokens: Optional[int] = None,
        max_completion_tokens: Optional[int] = None,
        stop: Optional[Union[str, Sequence[str]]] = None,
        presence_penalty: Optional[float] = None,
        frequency_penalty: Optional[float] = None,
        user: Optional[str] = None,
        metadata: Optional[Mapping[str, object]] = None,
        stream_options: Optional[Mapping[str, object]] = None,
        tools: Optional[Sequence[Mapping[str, object]]] = None,
        tool_choice: Optional[Union[str, Mapping[str, object]]] = None,
        response_format: Optional[Mapping[str, object]] = None,
        seed: Optional[int] = None,
        logprobs: Optional[bool] = None,
        top_logprobs: Optional[int] = None,
        top_k: Optional[int] = None,
        min_p: Optional[float] = None,
        repetition_penalty: Optional[float] = None,
        n: Optional[int] = None,
        best_of: Optional[int] = None,
        logit_bias: Optional[Mapping[str, float]] = None,
        parallel_tool_calls: Optional[bool] = None,
        reasoning_effort: Optional[str] = None,
        reasoning: Optional[Mapping[str, object]] = None,
        include_reasoning: Optional[bool] = None,
        prompt_cache_key: Optional[str] = None,
        service_tier: Optional[str] = None,
        store: Optional[bool] = None,
        safety_identifier: Optional[str] = None,
        modalities: Optional[Sequence[str]] = None,
        audio: Optional[Mapping[str, object]] = None,
        prediction: Optional[Mapping[str, object]] = None,
        verbosity: Optional[str] = None,
        web_search_options: Optional[Mapping[str, object]] = None,
        moderation: Optional[object] = None,
        functions: Optional[Sequence[Mapping[str, object]]] = None,
        function_call: Optional[Union[str, Mapping[str, object]]] = None,
        request_options: Optional[Mapping[str, Any]] = None,
        extra_body: Optional[Mapping[str, object]] = None,
    ) -> ChatCompletionResponse: ...

    @overload
    def create(
        self,
        *,
        model: str,
        messages: Sequence[Union[ChatMessage, Mapping[str, object]]],
        stream: bool = False,
        temperature: Optional[float] = None,
        top_p: Optional[float] = None,
        max_tokens: Optional[int] = None,
        max_completion_tokens: Optional[int] = None,
        stop: Optional[Union[str, Sequence[str]]] = None,
        presence_penalty: Optional[float] = None,
        frequency_penalty: Optional[float] = None,
        user: Optional[str] = None,
        metadata: Optional[Mapping[str, object]] = None,
        stream_options: Optional[Mapping[str, object]] = None,
        tools: Optional[Sequence[Mapping[str, object]]] = None,
        tool_choice: Optional[Union[str, Mapping[str, object]]] = None,
        response_format: Optional[Mapping[str, object]] = None,
        seed: Optional[int] = None,
        logprobs: Optional[bool] = None,
        top_logprobs: Optional[int] = None,
        top_k: Optional[int] = None,
        min_p: Optional[float] = None,
        repetition_penalty: Optional[float] = None,
        n: Optional[int] = None,
        best_of: Optional[int] = None,
        logit_bias: Optional[Mapping[str, float]] = None,
        parallel_tool_calls: Optional[bool] = None,
        reasoning_effort: Optional[str] = None,
        reasoning: Optional[Mapping[str, object]] = None,
        include_reasoning: Optional[bool] = None,
        prompt_cache_key: Optional[str] = None,
        service_tier: Optional[str] = None,
        store: Optional[bool] = None,
        safety_identifier: Optional[str] = None,
        modalities: Optional[Sequence[str]] = None,
        audio: Optional[Mapping[str, object]] = None,
        prediction: Optional[Mapping[str, object]] = None,
        verbosity: Optional[str] = None,
        web_search_options: Optional[Mapping[str, object]] = None,
        moderation: Optional[object] = None,
        functions: Optional[Sequence[Mapping[str, object]]] = None,
        function_call: Optional[Union[str, Mapping[str, object]]] = None,
        request_options: Optional[Mapping[str, Any]] = None,
        extra_body: Optional[Mapping[str, object]] = None,
    ) -> Union[ChatCompletionResponse, RunInfraStream]: ...

    def create(
        self,
        *,
        model: str,
        messages: Sequence[Union[ChatMessage, Mapping[str, object]]],
        stream: bool = False,
        temperature: Optional[float] = None,
        top_p: Optional[float] = None,
        max_tokens: Optional[int] = None,
        max_completion_tokens: Optional[int] = None,
        stop: Optional[Union[str, Sequence[str]]] = None,
        presence_penalty: Optional[float] = None,
        frequency_penalty: Optional[float] = None,
        user: Optional[str] = None,
        metadata: Optional[Mapping[str, object]] = None,
        stream_options: Optional[Mapping[str, object]] = None,
        tools: Optional[Sequence[Mapping[str, object]]] = None,
        tool_choice: Optional[Union[str, Mapping[str, object]]] = None,
        response_format: Optional[Mapping[str, object]] = None,
        seed: Optional[int] = None,
        logprobs: Optional[bool] = None,
        top_logprobs: Optional[int] = None,
        top_k: Optional[int] = None,
        min_p: Optional[float] = None,
        repetition_penalty: Optional[float] = None,
        n: Optional[int] = None,
        best_of: Optional[int] = None,
        logit_bias: Optional[Mapping[str, float]] = None,
        parallel_tool_calls: Optional[bool] = None,
        reasoning_effort: Optional[str] = None,
        reasoning: Optional[Mapping[str, object]] = None,
        include_reasoning: Optional[bool] = None,
        prompt_cache_key: Optional[str] = None,
        service_tier: Optional[str] = None,
        store: Optional[bool] = None,
        safety_identifier: Optional[str] = None,
        modalities: Optional[Sequence[str]] = None,
        audio: Optional[Mapping[str, object]] = None,
        prediction: Optional[Mapping[str, object]] = None,
        verbosity: Optional[str] = None,
        web_search_options: Optional[Mapping[str, object]] = None,
        moderation: Optional[object] = None,
        functions: Optional[Sequence[Mapping[str, object]]] = None,
        function_call: Optional[Union[str, Mapping[str, object]]] = None,
        request_options: Optional[Mapping[str, Any]] = None,
        extra_body: Optional[Mapping[str, object]] = None,
    ) -> Union[ChatCompletionResponse, RunInfraStream]:
        """Create a chat completion, or open its stream with `stream=True`.

        `messages` follow `ChatMessage`: an assistant message may carry
        `tool_calls` with `content` None or left out, and a `tool` message
        answers one call by its `tool_call_id`. A keyword left at None is not
        sent. Every other keyword is sent as given; whether a model accepts
        one depends on the model.

        A streamed call returns a `RunInfraStream`. Iterating it raises
        `RunInfraStreamError` when the API reports a failure on the open
        stream, and `RunInfraStreamIncompleteError` when the stream ends
        without `[DONE]`. A streamed call that repeats an `idempotency_key`
        the API has already answered yields one object, marked
        `_idempotent_replay`, and ends quietly.
        """
        open_fields: Dict[str, object] = {
            "top_k": top_k,
            "min_p": min_p,
            "repetition_penalty": repetition_penalty,
            "n": n,
            "best_of": best_of,
            "logit_bias": logit_bias,
            "parallel_tool_calls": parallel_tool_calls,
            "reasoning_effort": reasoning_effort,
            "reasoning": reasoning,
            "include_reasoning": include_reasoning,
            "prompt_cache_key": prompt_cache_key,
            "service_tier": service_tier,
            "store": store,
            "safety_identifier": safety_identifier,
            "modalities": modalities,
            "audio": audio,
            "prediction": prediction,
            "verbosity": verbosity,
            "web_search_options": web_search_options,
            "moderation": moderation,
            "functions": functions,
            "function_call": function_call,
        }
        payload = _json_payload_with_extra(
            {
                "model": _validated_model(model),
                "messages": messages,
                "stream": True if stream else None,
                "temperature": temperature,
                "top_p": top_p,
                "max_tokens": max_tokens,
                "max_completion_tokens": max_completion_tokens,
                "stop": stop,
                "presence_penalty": presence_penalty,
                "frequency_penalty": frequency_penalty,
                "user": user,
                "metadata": metadata,
                "stream_options": stream_options,
                "tools": tools,
                "tool_choice": tool_choice,
                "response_format": response_format,
                "seed": seed,
                "logprobs": logprobs,
                "top_logprobs": top_logprobs,
                **open_fields,
            },
            extra_body,
            # Keywords since 0.3.1. Callers had to put them in `extra_body` before, so they stay accepted there.
            extra_body_open_keys=open_fields.keys(),
        )
        _validate_chat_messages(payload.get("messages"))
        is_stream = payload.get("stream") is True
        sent_client_request_ids: List[str] = []
        response = self._requester.request(
            "/chat/completions",
            json_payload=payload,
            stream=is_stream,
            idempotent_replay_safe=True,
            request_options=request_options,
            sent_client_request_ids=sent_client_request_ids,
        )
        if is_stream:
            return _stream_response(response, [self._requester.api_key], sent_client_request_ids[0])
        return _json_response(response, [self._requester.api_key])


class _Chat:
    def __init__(self, requester: _Requester) -> None:
        self.completions = _ChatCompletions(requester)


class _Responses:
    def __init__(self, requester: _Requester) -> None:
        self._requester = requester

    @overload
    def create(
        self,
        *,
        model: str,
        input: Union[str, Sequence[Mapping[str, object]]],
        instructions: Optional[str] = None,
        stream: Literal[True],
        temperature: Optional[float] = None,
        top_p: Optional[float] = None,
        max_output_tokens: Optional[int] = None,
        tools: Optional[Sequence[Mapping[str, object]]] = None,
        tool_choice: Optional[Union[str, Mapping[str, object]]] = None,
        response_format: Optional[Mapping[str, object]] = None,
        request_options: Optional[Mapping[str, Any]] = None,
        extra_body: Optional[Mapping[str, object]] = None,
    ) -> RunInfraStream: ...

    @overload
    def create(
        self,
        *,
        model: str,
        input: Union[str, Sequence[Mapping[str, object]]],
        instructions: Optional[str] = None,
        stream: Literal[False] = False,
        temperature: Optional[float] = None,
        top_p: Optional[float] = None,
        max_output_tokens: Optional[int] = None,
        tools: Optional[Sequence[Mapping[str, object]]] = None,
        tool_choice: Optional[Union[str, Mapping[str, object]]] = None,
        response_format: Optional[Mapping[str, object]] = None,
        request_options: Optional[Mapping[str, Any]] = None,
        extra_body: Optional[Mapping[str, object]] = None,
    ) -> ResponsesCreateResponse: ...

    @overload
    def create(
        self,
        *,
        model: str,
        input: Union[str, Sequence[Mapping[str, object]]],
        instructions: Optional[str] = None,
        stream: bool = False,
        temperature: Optional[float] = None,
        top_p: Optional[float] = None,
        max_output_tokens: Optional[int] = None,
        tools: Optional[Sequence[Mapping[str, object]]] = None,
        tool_choice: Optional[Union[str, Mapping[str, object]]] = None,
        response_format: Optional[Mapping[str, object]] = None,
        request_options: Optional[Mapping[str, Any]] = None,
        extra_body: Optional[Mapping[str, object]] = None,
    ) -> Union[ResponsesCreateResponse, RunInfraStream]: ...

    def create(
        self,
        *,
        model: str,
        input: Union[str, Sequence[Mapping[str, object]]],
        instructions: Optional[str] = None,
        stream: bool = False,
        temperature: Optional[float] = None,
        top_p: Optional[float] = None,
        max_output_tokens: Optional[int] = None,
        tools: Optional[Sequence[Mapping[str, object]]] = None,
        tool_choice: Optional[Union[str, Mapping[str, object]]] = None,
        response_format: Optional[Mapping[str, object]] = None,
        request_options: Optional[Mapping[str, Any]] = None,
        extra_body: Optional[Mapping[str, object]] = None,
    ) -> Union[ResponsesCreateResponse, RunInfraStream]:
        """Create through RunInfra's Responses compatibility adapter.

        The gateway maps supported fields onto chat completions and rewraps
        the result; this is not a full stateful OpenAI Responses implementation.
        """
        payload = _json_payload_with_extra(
            {
                "model": _validated_model(model),
                "input": input,
                "instructions": instructions,
                "stream": True if stream else None,
                "temperature": temperature,
                "top_p": top_p,
                "max_output_tokens": max_output_tokens,
                "tools": tools,
                "tool_choice": tool_choice,
                "response_format": response_format,
            },
            extra_body,
        )
        _validate_responses_input(payload.get("input"))
        is_stream = payload.get("stream") is True
        sent_client_request_ids: List[str] = []
        response = self._requester.request(
            "/responses",
            json_payload=payload,
            stream=is_stream,
            idempotent_replay_safe=True,
            request_options=request_options,
            sent_client_request_ids=sent_client_request_ids,
        )
        if is_stream:
            return _stream_response(response, [self._requester.api_key], sent_client_request_ids[0])
        return _json_response(response, [self._requester.api_key])


class _Embeddings:
    def __init__(self, requester: _Requester) -> None:
        self._requester = requester

    def create(
        self,
        *,
        model: str,
        input: Union[str, Sequence[str]],
        encoding_format: Optional[str] = None,
        dimensions: Optional[int] = None,
        user: Optional[str] = None,
        request_options: Optional[Mapping[str, Any]] = None,
        extra_body: Optional[Mapping[str, object]] = None,
    ) -> EmbeddingResponse:
        _validate_embedding_input(input)
        payload = _json_payload_with_extra(
            {
                "model": _validated_model(model),
                "input": input,
                "encoding_format": encoding_format,
                "dimensions": dimensions,
                "user": user,
            },
            extra_body,
        )
        _validate_embedding_response_options(payload)
        return _json_response(self._requester.request(
            "/embeddings",
            json_payload=payload,
            request_options=request_options,
        ), [self._requester.api_key])


class _Speech:
    def __init__(self, requester: _Requester) -> None:
        self._requester = requester

    def create(
        self,
        *,
        model: str,
        input: str,
        voice: Optional[str] = None,
        response_format: Optional[str] = None,
        speed: Optional[float] = None,
        ref_audio: Optional[str] = None,
        ref_text: Optional[str] = None,
        task_type: Optional[str] = None,
        request_options: Optional[Mapping[str, Any]] = None,
        extra_body: Optional[Mapping[str, object]] = None,
    ) -> AudioResponse:
        validated_input = _validated_non_empty_string(input, "input")
        payload = _json_payload_with_extra(
            {
                "model": _validated_model(model),
                "input": validated_input,
                "voice": voice,
                "response_format": response_format,
                "speed": speed,
                "ref_audio": ref_audio,
                "ref_text": ref_text,
                "task_type": task_type,
            },
            extra_body,
        )
        if voice is not None:
            payload["voice"] = _validated_non_empty_string(voice, "voice")
        elif ref_audio is not None or ref_text is not None:
            payload["ref_audio"] = _validated_non_empty_string(ref_audio, "ref_audio")
            payload["ref_text"] = _validated_non_empty_string(ref_text, "ref_text")
        else:
            raise _invalid_request_option(
                "speech requests require either voice, or both ref_audio and ref_text"
            )
        response = self._requester.request(
            "/audio/speech",
            json_payload=payload,
            idempotent_replay_safe=False,
            request_options=request_options,
        )
        content_type = "application/octet-stream"
        for key, value in response.headers.items():
            if key.lower() == "content-type":
                content_type = value
                break
        request_id = _request_id_from_headers(response.headers)
        return AudioResponse(response.body, content_type, request_id)


class _Transcriptions:
    def __init__(self, requester: _Requester) -> None:
        self._requester = requester

    def create(
        self,
        *,
        model: str,
        file: Union[bytes, bytearray],
        filename: str = "audio.wav",
        content_type: str = "audio/wav",
        language: Optional[str] = None,
        prompt: Optional[str] = None,
        response_format: Optional[str] = None,
        temperature: Optional[float] = None,
        request_options: Optional[Mapping[str, Any]] = None,
    ) -> TranscriptionResponse:
        payload: Dict[str, object] = {"model": _validated_model(model)}
        for key, value in {
            "language": language,
            "prompt": prompt,
            "response_format": response_format,
            "temperature": temperature,
        }.items():
            if value is not None:
                payload[key] = value
        _validate_transcription_response_format(payload)
        fields = {key: _validated_multipart_field_value(value) for key, value in payload.items()}
        body, multipart_type = _multipart_body(
            fields,
            {"file": (filename, _validated_audio_file(file), content_type)},
        )
        return _json_response(self._requester.request(
            "/audio/transcriptions",
            body=body,
            headers={"Content-Type": multipart_type},
            idempotent_replay_safe=False,
            request_options=request_options,
        ), [self._requester.api_key])


class _Audio:
    """Audio surfaces (text-to-speech + speech-to-text).

    Preview helpers for deployed RunInfra audio routes. The HTTP envelope
    matches the OpenAI Audio API contract and the request/response shapes are
    stable. Supported voices, reference-audio modes, and response formats are
    deployment-specific.
    """

    def __init__(self, requester: _Requester) -> None:
        self.speech = _Speech(requester)
        self.transcriptions = _Transcriptions(requester)


class _Models:
    def __init__(self, requester: _Requester) -> None:
        self._requester = requester

    def list(self, *, request_options: Optional[Mapping[str, Any]] = None) -> ModelListResponse:
        return _json_response(self._requester.request(
            "/models",
            method="GET",
            request_options=request_options,
        ), [self._requester.api_key])

    def retrieve(self, model: str, *, request_options: Optional[Mapping[str, Any]] = None) -> ModelObject:
        encoded_model = urllib.parse.quote(_validated_identifier(model, "model"), safe="")
        return _json_response(self._requester.request(
            f"/models/{encoded_model}",
            method="GET",
            request_options=request_options,
        ), [self._requester.api_key])


class _Images:
    """Image generation surface.

    Preview helper for deployed RunInfra image routes. The HTTP envelope
    matches the OpenAI Images API contract. Supported size, response format,
    quality, style, and user fields depend on the selected deployment.
    """

    def __init__(self, requester: _Requester) -> None:
        self._requester = requester

    def generate(
        self,
        *,
        model: str,
        prompt: str,
        n: Optional[int] = None,
        size: Optional[str] = None,
        response_format: Optional[str] = None,
        quality: Optional[str] = None,
        style: Optional[str] = None,
        user: Optional[str] = None,
        request_options: Optional[Mapping[str, Any]] = None,
        extra_body: Optional[Mapping[str, object]] = None,
    ) -> ImageGenerationResponse:
        validated_prompt = _validated_non_empty_string(prompt, "prompt")
        payload = _json_payload_with_extra(
            {
                "model": _validated_model(model),
                "prompt": validated_prompt,
                "n": n,
                "size": size,
                "response_format": response_format,
                "quality": quality,
                "style": style,
                "user": user,
            },
            extra_body,
        )
        return _json_response(self._requester.request(
            "/images/generations",
            json_payload=payload,
            request_options=request_options,
        ), [self._requester.api_key])


# `batches.create()` tests the destination before it answers, which can take 20 seconds.
_BATCH_CREATE_MIN_DEFAULT_TIMEOUT_SECONDS = 30.0


def _validated_integer(value: Any, name: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise _invalid_request_option(f"{name} must be an integer")
    return value


def _batch_path(batch_id: Any, suffix: str = "") -> str:
    encoded = urllib.parse.quote(_validated_identifier(batch_id, "batch_id"), safe="")
    return f"/batches/{encoded}{suffix}"


class _Batches:
    """Batch jobs.

    Preview. A job takes a JSONL file of chat completion requests and posts
    each answer, signed, to your webhook address. A job has a window of 24
    hours. Lines run when the model has spare capacity. A line the job has not
    run when its window ends is counted `expired` and is not charged. Use a
    workspace-scoped key; verify deliveries with `verify_batch_delivery`.
    """

    def __init__(self, requester: _Requester) -> None:
        self._requester = requester

    def create(
        self,
        *,
        model: str,
        input_url: str,
        destination: BatchDestination,
        max_cost_cents: int,
        window_hours: Optional[int] = None,
        name: Optional[str] = None,
        request_options: Optional[Mapping[str, Any]] = None,
        extra_body: Optional[Mapping[str, object]] = None,
    ) -> BatchCreateResponse:
        """Create a job, which then starts by itself.

        `model` is a model that offers batch. `input_url` is a public HTTPS
        link (port 443, at most 8,192 bytes) to a JSONL file of at most 50 MiB
        whose host serves byte ranges; a signed link must stay valid until the
        job's window ends. `destination` is `{"type": "webhook", "url": ...}`
        with a public HTTPS address on port 443. `max_cost_cents` is the most
        the job may cost: a whole number from 1 to 100,000,000. `window_hours`
        is 24, the only value and the default. `name` is a label of at most 64
        characters.

        The gateway first posts a signed test delivery to the destination, so
        this call can take 20 seconds: its default timeout is never below 30
        seconds. Pass `idempotency_key` in `request_options` to make the call
        safe to retry; without one it is sent once. Sending the same create
        again with the same key and the same body answers the earlier job as a
        normal success: no error and no second job. The same key with a
        different body is refused with 409.
        """
        if not isinstance(destination, MappingABC):
            raise _invalid_request_option("destination must be a mapping")
        _validated_non_empty_string(destination.get("type"), "destination.type")
        _validated_non_empty_string(destination.get("url"), "destination.url")
        if name is not None and not isinstance(name, str):
            raise _invalid_request_option("name must be a string")
        payload = _json_payload_with_extra(
            {
                "model": _validated_model(model),
                "input_url": _validated_non_empty_string(input_url, "input_url"),
                "destination": dict(destination),
                "max_cost_cents": _validated_integer(max_cost_cents, "max_cost_cents"),
                "window_hours": None if window_hours is None else _validated_integer(window_hours, "window_hours"),
                "name": name,
            },
            extra_body,
        )
        return _json_response(self._requester.request(
            "/batches",
            json_payload=payload,
            idempotent_replay_safe=True,
            request_options=request_options,
            batch=True,
            minimum_default_timeout_seconds=_BATCH_CREATE_MIN_DEFAULT_TIMEOUT_SECONDS,
        ), [self._requester.api_key])

    def list(
        self,
        *,
        limit: Optional[int] = None,
        cursor: Optional[str] = None,
        state: Optional[BatchState] = None,
        model: Optional[str] = None,
        request_options: Optional[Mapping[str, Any]] = None,
    ) -> BatchListResponse:
        """List the workspace's jobs, newest first.

        `limit` is the page size, from 1 to 50 (the gateway's default is 20).
        `cursor` is the `next_cursor` of the page before. `state` and `model`
        narrow the list.
        """
        query: Dict[str, str] = {}
        if limit is not None:
            query["limit"] = str(_validated_integer(limit, "limit"))
        for key, value in (("cursor", cursor), ("state", state), ("model", model)):
            if value is not None:
                query[key] = _validated_non_empty_string(value, key)
        path = "/batches" + (f"?{urllib.parse.urlencode(query)}" if query else "")
        return _json_response(self._requester.request(
            path,
            method="GET",
            request_options=request_options,
            batch=True,
        ), [self._requester.api_key])

    def retrieve(self, batch_id: str, *, request_options: Optional[Mapping[str, Any]] = None) -> BatchRetrieveResponse:
        """Read one job with the lines its check refused and its quote."""
        return _json_response(self._requester.request(
            _batch_path(batch_id),
            method="GET",
            request_options=request_options,
            batch=True,
        ), [self._requester.api_key])

    def cancel(self, batch_id: str, *, request_options: Optional[Mapping[str, Any]] = None) -> BatchCancelResponse:
        """Cancel a job: "cancelled" when no line had run, else "cancelling" while lines in flight settle.

        Sent once, never retried.
        """
        return _json_response(self._requester.request(
            _batch_path(batch_id, "/cancel"),
            method="POST",
            request_options=request_options,
            batch=True,
        ), [self._requester.api_key])


class _Webhooks:
    def verify_signature(
        self,
        *,
        payload: Union[str, bytes, bytearray],
        signature_header: str,
        secret: str,
        tolerance_seconds: float = 300,
        now: Optional[float] = None,
    ) -> bool:
        return verify_webhook_signature(
            payload=payload,
            signature_header=signature_header,
            secret=secret,
            tolerance_seconds=tolerance_seconds,
            now=now,
        )

    def construct_event(
        self,
        *,
        payload: Union[str, bytes, bytearray],
        signature_header: str,
        secret: str,
        tolerance_seconds: float = 300,
        now: Optional[float] = None,
    ) -> Any:
        return construct_webhook_event(
            payload=payload,
            signature_header=signature_header,
            secret=secret,
            tolerance_seconds=tolerance_seconds,
            now=now,
        )


class _VoicePipeline:
    def __init__(self, requester: _Requester) -> None:
        self._requester = requester

    def create(
        self,
        *,
        audio: Union[bytes, bytearray, memoryview],
        mime_type: str = "audio/wav",
        request_options: Optional[Mapping[str, Any]] = None,
    ) -> VoicePipelineResponse:
        if not self._requester.pipeline_scoped:
            raise _invalid_request_option(
                "voice pipeline requests require pipeline_id or a pipeline-scoped base_url"
            )
        return _json_response(self._requester.request(
            "/pipeline",
            body=_validated_audio_bytes(audio),
            headers={
                "Content-Type": _validated_mime_type(mime_type),
                "Accept": "application/json",
            },
            idempotent_replay_safe=False,
            request_options=request_options,
        ), [self._requester.api_key])


class _Voice:
    """Voice pipeline surface.

    Preview helper for co-located voice pipelines. It requires a
    pipeline-scoped client and posts binary audio to `/pipeline`; transcript
    and response behavior depends on the selected deployment.
    """

    def __init__(self, requester: _Requester) -> None:
        self.pipeline = _VoicePipeline(requester)


class RunInfra:
    """The RunInfra client.

    `timeout_seconds` is the timeout of every call. Left out, a non-streamed
    call is given 750 seconds, and a streamed call 190 seconds to its response
    headers and to each later read. A call's own `timeout_seconds` in
    `request_options` wins over both. A call that runs out of time raises
    `RunInfraTimeoutError` and is never sent again.

    `max_retries` and `retry_base_seconds` bound the retries of a call that is
    safe to send again: a GET, or a non-streamed chat, Responses or batch
    create call that carries an `idempotency_key`.
    """

    def __init__(
        self,
        *,
        api_key: str,
        pipeline_id: Optional[str] = None,
        base_url: str = "https://api.runinfra.ai/v1",
        timeout_seconds: Optional[float] = None,
        transport: Optional[Transport] = None,
        max_retries: int = 2,
        retry_base_seconds: float = 0.25,
    ) -> None:
        if not isinstance(api_key, str):
            raise _invalid_request_option("api_key must be a string")
        api_key = api_key.strip()
        if not api_key:
            raise AuthenticationError("api_key is required", status=401, error_type="auth_error")
        api_key = _validated_header(api_key, "api_key")
        if timeout_seconds is not None:
            timeout_seconds = _validate_positive_number(timeout_seconds, "timeout_seconds")
        max_retries = _validate_non_negative_integer(max_retries, "max_retries")
        retry_base_seconds = _validate_non_negative_number(
            retry_base_seconds,
            "retry_base_seconds",
        )
        if transport is not None and not callable(transport):
            raise _invalid_request_option("transport must be callable")
        normalized_base_url = _normalize_base_url(base_url, pipeline_id)
        requester = _Requester(
            api_key=api_key,
            base_url=normalized_base_url,
            pipeline_scoped=pipeline_id is not None or _base_url_looks_pipeline_scoped(normalized_base_url),
            transport=transport if transport is not None else _default_transport(timeout_seconds),
            max_retries=max_retries,
            retry_base_seconds=retry_base_seconds,
            default_timeout_seconds=timeout_seconds,
        )
        self.chat = _Chat(requester)
        self.responses = _Responses(requester)
        self.embeddings = _Embeddings(requester)
        self.audio = _Audio(requester)
        self.models = _Models(requester)
        self.images = _Images(requester)
        self.batches = _Batches(requester)
        self.webhooks = _Webhooks()
        self.voice = _Voice(requester)


__all__ = [
    "AudioResponse",
    "__version__",
    "AuthenticationError",
    "BatchAnswerDelivery",
    "BatchCancelResponse",
    "BatchCheckError",
    "BatchCreateResponse",
    "BatchDelivery",
    "BatchDeliveryCost",
    "BatchDeliveryError",
    "BatchDeliveryErrorCode",
    "BatchDeliveryUsage",
    "BatchDestination",
    "BatchEndReason",
    "BatchErrorDelivery",
    "BatchJob",
    "BatchJobDetail",
    "BatchLineCheckCode",
    "BatchLineCheckErrors",
    "BatchListResponse",
    "BatchMadeBy",
    "BatchNotice",
    "BatchPauseReason",
    "BatchQuote",
    "BatchRefusalCode",
    "BatchRetrieveResponse",
    "BatchState",
    "BatchTestDelivery",
    "BatchUnavailableReason",
    "ChatCompletionChoice",
    "ChatCompletionMessageToolCall",
    "ChatCompletionResponse",
    "ChatCompletionStreamChoice",
    "ChatCompletionStreamDelta",
    "ChatCompletionStreamEvent",
    "ChatCompletionStreamToolCallDelta",
    "ChatCompletionStreamToolCallFunction",
    "ChatCompletionToolCallFunction",
    "ChatMessage",
    "ChatToolMessage",
    "DeploymentError",
    "EmbeddingObject",
    "EmbeddingResponse",
    "ImageGenerationResponse",
    "VoicePipelineResponse",
    "ImageObject",
    "InsufficientCreditsError",
    "ModelListResponse",
    "ModelObject",
    "ModelNotFoundError",
    "PermissionDeniedError",
    "RateLimitError",
    "RunInfra",
    "RunInfraConnectionError",
    "RunInfraError",
    "RunInfraRequest",
    "RunInfraResponse",
    "RunInfraStream",
    "RunInfraStreamError",
    "RunInfraStreamIncompleteError",
    "RunInfraStreamParseError",
    "RunInfraTimeoutError",
    "ResponsesCreateResponse",
    "TranscriptionResponse",
    "UnsupportedOperationError",
    "WebhookVerificationError",
    "construct_webhook_event",
    "verify_batch_delivery",
    "verify_webhook_signature",
]

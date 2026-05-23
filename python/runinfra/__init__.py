from __future__ import annotations

import codecs
import json
import hashlib
import hmac
import math
import re
import time
import uuid
import urllib.error
import urllib.parse
import urllib.request
from dataclasses import dataclass
from email.utils import parsedate_to_datetime
from collections.abc import Mapping as MappingABC
from typing import Any, Callable, Dict, Iterable, Iterator, List, Mapping, Optional, Sequence, TypedDict, Union


JsonDict = Dict[str, Any]
Transport = Callable[["RunInfraRequest"], "RunInfraResponse"]
ResponseBody = Union[bytes, Iterable[bytes]]
__version__ = "0.1.3"
_MAX_AUTOMATIC_RETRY_AFTER_SECONDS = 60.0
_WEBHOOK_SIGNATURE_HEADER_MAX_LENGTH = 8192


class RunInfraRequestMetadata(TypedDict, total=False):
    _request_id: str


class ModelObject(RunInfraRequestMetadata, total=False):
    id: str
    object: str
    created: int
    owned_by: str


class ModelListResponse(RunInfraRequestMetadata, total=False):
    object: str
    data: List[ModelObject]


class ChatCompletionResponse(RunInfraRequestMetadata, total=False):
    id: str
    object: str
    created: int
    model: str
    choices: List[JsonDict]
    usage: JsonDict


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
    def __init__(
        self,
        message: str,
        *,
        status: int,
        error_type: str,
        request_id: Optional[str] = None,
        retry_after_seconds: Optional[float] = None,
    ) -> None:
        super().__init__(message)
        self.status = status
        self.type = error_type
        self.request_id = request_id
        self.retry_after_seconds = retry_after_seconds


class AuthenticationError(RunInfraError):
    pass


class PermissionDeniedError(RunInfraError):
    pass


class RateLimitError(RunInfraError):
    pass


class InsufficientCreditsError(RunInfraError):
    pass


class DeploymentError(RunInfraError):
    pass


class ModelNotFoundError(RunInfraError):
    pass


class RunInfraTimeoutError(RunInfraError):
    pass


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


class RunInfraStream:
    def __init__(self, body: ResponseBody, request_id: Optional[str] = None) -> None:
        self._body = body
        self.request_id = request_id

    def __iter__(self) -> Iterator[JsonDict]:
        buffer = ""
        data_lines: List[str] = []
        decoder = codecs.getincrementaldecoder("utf-8")()

        def dispatch_event() -> Optional[JsonDict]:
            payload = "\n".join(data_lines).strip()
            data_lines.clear()
            if not payload or payload == "[DONE]":
                return None
            try:
                return json.loads(payload)
            except json.JSONDecodeError as exc:
                raise RunInfraStreamParseError(request_id=self.request_id) from exc

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

        try:
            for chunk in chunks:
                buffer += decoder.decode(chunk, final=False)
                lines = buffer.split("\n")
                buffer = lines.pop() or ""
                for line in lines:
                    parsed = parse_line(line)
                    if parsed is not None:
                        yield parsed

            buffer += decoder.decode(b"", final=True)
            parsed = parse_line(buffer)
            if parsed is not None:
                yield parsed
            if data_lines:
                parsed = dispatch_event()
                if parsed is not None:
                    yield parsed
        except RunInfraError:
            raise
        except Exception as exc:
            raise _transport_error(exc, request_id=self.request_id) from exc
        finally:
            if callable(close_chunks):
                close_chunks()


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


def _default_transport(timeout: float) -> Transport:
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
                timeout=request.timeout_seconds or timeout,
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


def _retry_after_seconds(response: RunInfraResponse) -> Optional[float]:
    value = response.headers.get("retry-after") or response.headers.get("Retry-After")
    if not value:
        return None
    value = value.strip()
    if re.fullmatch(r"[0-9]+", value):
        return float(value)
    if re.match(r"^(?:[+-]|\d)", value):
        return None
    try:
        retry_at = parsedate_to_datetime(value)
        return max(0.0, retry_at.timestamp() - time.time())
    except (TypeError, ValueError, OverflowError):
        return None


def _automatic_retry_after_seconds(response: RunInfraResponse) -> Optional[float]:
    delay = _retry_after_seconds(response)
    if delay is None or delay > _MAX_AUTOMATIC_RETRY_AFTER_SECONDS:
        return None
    return delay


def _retry_delay_seconds(attempt: int, base_seconds: float, response: Optional[RunInfraResponse] = None) -> float:
    if response is not None:
        retry_after = _automatic_retry_after_seconds(response)
        if retry_after is not None:
            return retry_after
    if base_seconds <= 0:
        return 0
    return min(30.0, base_seconds * (2 ** max(0, attempt - 1)))


def _discard_response_body(response: RunInfraResponse) -> None:
    if isinstance(response.body, bytes):
        return
    close_body = getattr(response.body, "close", None)
    if callable(close_body):
        close_body()


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


def _validated_audio_file(value: Any) -> bytes:
    if not isinstance(value, (bytes, bytearray)):
        raise _invalid_request_option("file must be bytes or bytearray")
    return bytes(value)


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
    if not any(hmac.compare_digest(expected, signature) for signature in signatures):
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


def _transport_error(error: BaseException, request_id: Optional[str] = None) -> RunInfraError:
    if _is_timeout_error(error):
        return RunInfraTimeoutError(
            str(error),
            status=0,
            error_type="timeout_error",
            request_id=request_id,
        )
    return RunInfraConnectionError(
        str(error),
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


def _error_from_response(response: RunInfraResponse) -> RunInfraError:
    message = f"RunInfra request failed with status {response.status}"
    error_type = "api_error"
    try:
        body = response.json()
        if isinstance(body, dict) and isinstance(body.get("error"), dict):
            error = body["error"]
            if isinstance(error.get("message"), str):
                message = error["message"]
            if isinstance(error.get("type"), str):
                error_type = error["type"]
    except Exception:
        pass

    request_id = _request_id_from_headers(response.headers)
    if response.status == 401:
        return AuthenticationError(message, status=response.status, error_type="auth_error", request_id=request_id)
    if response.status == 403:
        return PermissionDeniedError(message, status=response.status, error_type="permission_denied", request_id=request_id)
    if response.status == 402:
        return InsufficientCreditsError(message, status=response.status, error_type="insufficient_credits", request_id=request_id)
    if response.status == 404 or error_type == "model_not_found":
        return ModelNotFoundError(message, status=response.status, error_type="model_not_found", request_id=request_id)
    if response.status == 429:
        return RateLimitError(
            message,
            status=response.status,
            error_type="rate_limit_error",
            request_id=request_id,
            retry_after_seconds=_retry_after_seconds(response),
        )
    if error_type == "deployment_error":
        return DeploymentError(message, status=response.status, error_type=error_type, request_id=request_id)
    return RunInfraError(message, status=response.status, error_type=error_type, request_id=request_id)


def _json_body(payload: Mapping[str, Any]) -> bytes:
    try:
        return json.dumps(payload, separators=(",", ":"), allow_nan=False).encode("utf-8")
    except (TypeError, ValueError, OverflowError) as exc:
        raise _invalid_request_option(
            "JSON request body must be serializable and contain only finite numbers"
        ) from exc


def _json_response(response: RunInfraResponse) -> Any:
    payload = response.json()
    if isinstance(payload, dict):
        request_id = _request_id_from_headers(response.headers)
        if request_id:
            return {**payload, "_request_id": request_id}
        return payload
    request_id = _request_id_from_headers(response.headers)
    raise RunInfraError(
        f"RunInfra JSON response shape error: expected object, got {_json_payload_kind(payload)}.",
        status=response.status,
        error_type="response_shape_error",
        request_id=request_id,
    )


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
        transport: Transport,
        max_retries: int,
        retry_base_seconds: float,
    ) -> None:
        self.api_key = api_key
        self.base_url = base_url
        self.transport = transport
        self.max_retries = max_retries
        self.retry_base_seconds = retry_base_seconds

    def request(
        self,
        path: str,
        *,
        method: str = "POST",
        json_payload: Optional[Mapping[str, Any]] = None,
        body: Optional[bytes] = None,
        headers: Optional[Mapping[str, str]] = None,
        stream: bool = False,
        idempotent_replay_safe: bool = True,
        request_options: Optional[Mapping[str, Any]] = None,
    ) -> RunInfraResponse:
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
        method_name = method.upper()
        has_replayable_json_body = json_payload is not None and not stream and idempotent_replay_safe
        can_retry = method_name in {"GET", "HEAD"} or (
            has_idempotency_key and has_replayable_json_body
        )
        while True:
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
                if can_retry and attempt < max_retries:
                    attempt += 1
                    time.sleep(_retry_delay_seconds(attempt, retry_base_seconds))
                    continue
                raise exc.error from exc
            except RunInfraError:
                raise
            except Exception as exc:
                if can_retry and attempt < max_retries:
                    attempt += 1
                    time.sleep(_retry_delay_seconds(attempt, retry_base_seconds))
                    continue
                raise _transport_error(exc) from exc

            if 200 <= response.status < 300:
                return response
            if can_retry and _is_retryable(response.status) and attempt < max_retries:
                attempt += 1
                _discard_response_body(response)
                time.sleep(_retry_delay_seconds(attempt, retry_base_seconds, response))
                continue
            raise _error_from_response(response)


class _ChatCompletions:
    def __init__(self, requester: _Requester) -> None:
        self._requester = requester

    def create(self, **kwargs: Any) -> Union[ChatCompletionResponse, RunInfraStream]:
        request_options = kwargs.pop("request_options", None)
        kwargs = {**kwargs, "model": _validated_model(kwargs.get("model"))}
        _validate_chat_messages(kwargs.get("messages"))
        stream = kwargs.get("stream") is True
        response = self._requester.request(
            "/chat/completions",
            json_payload=kwargs,
            stream=stream,
            request_options=request_options,
        )
        if stream:
            return RunInfraStream(
                response.body,
                _request_id_from_headers(response.headers),
            )
        return _json_response(response)


class _Chat:
    def __init__(self, requester: _Requester) -> None:
        self.completions = _ChatCompletions(requester)


class _Responses:
    def __init__(self, requester: _Requester) -> None:
        self._requester = requester

    def create(self, **kwargs: Any) -> Union[ResponsesCreateResponse, RunInfraStream]:
        request_options = kwargs.pop("request_options", None)
        kwargs = {**kwargs, "model": _validated_model(kwargs.get("model"))}
        _validate_responses_input(kwargs.get("input"))
        stream = kwargs.get("stream") is True
        response = self._requester.request(
            "/responses",
            json_payload=kwargs,
            stream=stream,
            request_options=request_options,
        )
        if stream:
            return RunInfraStream(
                response.body,
                _request_id_from_headers(response.headers),
            )
        return _json_response(response)


class _Embeddings:
    def __init__(self, requester: _Requester) -> None:
        self._requester = requester

    def create(
        self,
        *,
        model: str,
        input: Union[str, Sequence[str]],
        request_options: Optional[Mapping[str, Any]] = None,
        **kwargs: Any,
    ) -> EmbeddingResponse:
        _validate_embedding_input(input)
        return _json_response(self._requester.request(
            "/embeddings",
            json_payload={"model": _validated_model(model), "input": input, **kwargs},
            request_options=request_options,
        ))


class _Speech:
    def __init__(self, requester: _Requester) -> None:
        self._requester = requester

    def create(
        self,
        *,
        model: str,
        input: str,
        voice: Optional[str] = None,
        request_options: Optional[Mapping[str, Any]] = None,
        **kwargs: Any,
    ) -> AudioResponse:
        validated_input = _validated_non_empty_string(input, "input")
        payload: Dict[str, Any] = {
            "model": _validated_model(model),
            "input": validated_input,
            **kwargs,
        }
        if voice is not None:
            payload["voice"] = _validated_non_empty_string(voice, "voice")
        elif "ref_audio" in kwargs or "ref_text" in kwargs:
            payload["ref_audio"] = _validated_non_empty_string(kwargs.get("ref_audio"), "ref_audio")
            payload["ref_text"] = _validated_non_empty_string(kwargs.get("ref_text"), "ref_text")
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
        content_type = response.headers.get("content-type", response.headers.get("Content-Type", "application/octet-stream"))
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
        request_options: Optional[Mapping[str, Any]] = None,
        **kwargs: Any,
    ) -> TranscriptionResponse:
        fields = {
            "model": _validated_model(model),
            **{key: _validated_multipart_field_value(value) for key, value in kwargs.items()},
        }
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
        ))


class _Audio:
    """Audio surfaces (text-to-speech + speech-to-text).

    [EXPERIMENTAL] As of v0.1.3, these methods have NOT been verified end-to-end
    against a live deployed pipeline in the canary suite. The HTTP envelope
    matches the OpenAI Audio API contract and the request/response shapes are
    stable, but you should test against your own deployed model before using
    in production. Live-canary verification is tracked for v1.0.0 GA.
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
        ))

    def retrieve(self, model: str, *, request_options: Optional[Mapping[str, Any]] = None) -> ModelObject:
        encoded_model = urllib.parse.quote(_validated_identifier(model, "model"), safe="")
        return _json_response(self._requester.request(
            f"/models/{encoded_model}",
            method="GET",
            request_options=request_options,
        ))


class _Images:
    """Image generation surface.

    [EXPERIMENTAL] As of v0.1.3, this method has NOT been verified end-to-end
    against a live deployed pipeline in the canary suite. The HTTP envelope
    matches the OpenAI Images API contract, but you should test against your
    own deployed model before using in production. Live-canary verification
    is tracked for v1.0.0 GA.
    """

    def __init__(self, requester: _Requester) -> None:
        self._requester = requester

    def generate(
        self,
        *,
        model: str,
        prompt: str,
        request_options: Optional[Mapping[str, Any]] = None,
        **kwargs: Any,
    ) -> ImageGenerationResponse:
        validated_prompt = _validated_non_empty_string(prompt, "prompt")
        return _json_response(self._requester.request(
            "/images/generations",
            json_payload={"model": _validated_model(model), "prompt": validated_prompt, **kwargs},
            request_options=request_options,
        ))


class _Webhooks:
    def verify_signature(self, **kwargs: Any) -> bool:
        return verify_webhook_signature(**kwargs)

    def construct_event(self, **kwargs: Any) -> Any:
        return construct_webhook_event(**kwargs)

    def create(self, **_kwargs: Any) -> Any:
        raise UnsupportedOperationError(
            "RunInfra public webhooks are not available yet; delivery and signature verification endpoints are not shipped."
        )

    def list(self) -> Any:
        raise UnsupportedOperationError(
            "RunInfra public webhooks are not available yet; delivery and signature verification endpoints are not shipped."
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
        return _json_response(self._requester.request(
            "/pipeline",
            body=_validated_audio_bytes(audio),
            headers={
                "Content-Type": _validated_mime_type(mime_type),
                "Accept": "application/json",
            },
            idempotent_replay_safe=False,
            request_options=request_options,
        ))


class _Voice:
    def __init__(self, requester: _Requester) -> None:
        self.pipeline = _VoicePipeline(requester)


class RunInfra:
    def __init__(
        self,
        *,
        api_key: str,
        pipeline_id: Optional[str] = None,
        base_url: str = "https://api.runinfra.ai/v1",
        timeout_seconds: float = 120,
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
        timeout_seconds = _validate_positive_number(timeout_seconds, "timeout_seconds")
        max_retries = _validate_non_negative_integer(max_retries, "max_retries")
        retry_base_seconds = _validate_non_negative_number(
            retry_base_seconds,
            "retry_base_seconds",
        )
        if transport is not None and not callable(transport):
            raise _invalid_request_option("transport must be callable")
        requester = _Requester(
            api_key=api_key,
            base_url=_normalize_base_url(base_url, pipeline_id),
            transport=transport if transport is not None else _default_transport(timeout_seconds),
            max_retries=max_retries,
            retry_base_seconds=retry_base_seconds,
        )
        self.chat = _Chat(requester)
        self.responses = _Responses(requester)
        self.embeddings = _Embeddings(requester)
        self.audio = _Audio(requester)
        self.models = _Models(requester)
        self.images = _Images(requester)
        self.webhooks = _Webhooks()
        self.voice = _Voice(requester)


__all__ = [
    "AudioResponse",
    "__version__",
    "AuthenticationError",
    "ChatCompletionResponse",
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
    "RunInfraStreamParseError",
    "RunInfraTimeoutError",
    "ResponsesCreateResponse",
    "TranscriptionResponse",
    "UnsupportedOperationError",
    "WebhookVerificationError",
    "construct_webhook_event",
    "verify_webhook_signature",
]

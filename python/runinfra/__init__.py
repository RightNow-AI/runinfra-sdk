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
from typing import Any, Callable, Dict, Iterable, Iterator, List, Literal, Mapping, Optional, Sequence, TypedDict, Union, overload


JsonDict = Dict[str, Any]
Transport = Callable[["RunInfraRequest"], "RunInfraResponse"]
ResponseBody = Union[bytes, Iterable[bytes]]
__version__ = "0.1.4"
_MAX_AUTOMATIC_RETRY_AFTER_SECONDS = 60.0
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
    def __init__(
        self,
        body: ResponseBody,
        request_id: Optional[str] = None,
        sensitive_values: Iterable[str] = (),
    ) -> None:
        self._body = body
        self.request_id = request_id
        self._sensitive_values = tuple(sensitive_values)

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

        error_to_raise: Optional[RunInfraError] = None
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


def _default_transport(timeout: float) -> Transport:
    def send(request: RunInfraRequest) -> RunInfraResponse:
        req = urllib.request.Request(
            request.url,
            data=request.body,
            headers=request.headers,
            method=request.method,
        )

        def _extract_status(obj: Any) -> int:
            # Accept common shapes: .status, .getcode(), or .code
            if hasattr(obj, "status"):
                try:
                    return int(getattr(obj, "status"))
                except Exception:
                    pass
            getcode = getattr(obj, "getcode", None)
            if callable(getcode):
                try:
                    return int(getcode())
                except Exception:
                    pass
            code = getattr(obj, "code", None)
            if isinstance(code, int):
                return code
            try:
                if code is not None:
                    return int(code)
            except Exception:
                pass
            return 0

        def _extract_headers(obj: Any) -> Dict[str, str]:
            # Try common header accessors: .headers (mapping-like) or .getheaders()
            items: List[tuple] = []
            headers_obj = getattr(obj, "headers", None)
            getheaders = getattr(obj, "getheaders", None)
            if headers_obj is not None:
                try:
                    items = list(headers_obj.items())
                except Exception:
                    # Fallback: some header-like objects are iterable of pairs
                    try:
                        items = list(headers_obj)
                    except Exception:
                        items = []
            elif callable(getheaders):
                try:
                    items = list(getheaders())
                except Exception:
                    items = []

            normalized: Dict[str, str] = {}
            for pair in items:
                try:
                    name, value = pair
                    if isinstance(name, str) and value is not None:
                        normalized[name.lower()] = str(value)
                except Exception:
                    continue
            return normalized

        try:
            response = urllib.request.urlopen(
                req,
                timeout=request.timeout_seconds or timeout,
            )
            response_headers = _extract_headers(response)
            status = _extract_status(response)

            if request.stream:
                def iter_response() -> Iterator[bytes]:
                    try:
                        while True:
                            chunk = getattr(response, "readline", lambda: b"")()
                            if not chunk:
                                break
                            yield chunk
                    finally:
                        close = getattr(response, "close", None)
                        if callable(close):
                            try:
                                close()
                            except Exception:
                                pass

                return RunInfraResponse(
                    status,
                    response_headers,
                    iter_response(),
                )

            try:
                body = response.read()
            except Exception as exc:
                raise _TransportBodyReadError(
                    _transport_error(
                        exc,
                        _request_id_from_headers(response_headers),
                    )
                ) from exc
            finally:
                close = getattr(response, "close", None)
                if callable(close):
                    try:
                        close()
                    except Exception:
                        pass

            return RunInfraResponse(
                status,
                response_headers,
                body,
            )
        except urllib.error.HTTPError as exc:
            response_headers = _extract_headers(exc)
            try:
                body = exc.read()
            except Exception as read_exc:
                raise _TransportBodyReadError(
                    _transport_error(
                        read_exc,
                        _request_id_from_headers(response_headers),
                    )
                ) from read_exc
            status = _extract_status(exc) or getattr(exc, "code", 0)
            try:
                status = int(status)
            except Exception:
                status = 0
            return RunInfraResponse(status, response_headers, body)

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
) -> Dict[str, object]:
    payload = {key: value for key, value in fields.items() if value is not None}
    typed_keys = set(fields.keys())
    if extra_body is None:
        return payload
    if not isinstance(extra_body, MappingABC):
        raise _invalid_request_option("extra_body must be a mapping")
    for key, value in extra_body.items():
        if not isinstance(key, str) or not key.strip():
            raise _invalid_request_option("extra_body keys must be non-empty strings")
        if key in typed_keys:
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


def _redacted_error_message(error: BaseException, sensitive_values: Iterable[str] = ()) -> str:
    message = str(error)
    for value in sensitive_values:
        if value:
            message = message.replace(value, "[redacted]")
    return message


def _redacted_runinfra_error(
    error: RunInfraError,
    sensitive_values: Iterable[str] = (),
) -> RunInfraError:
    message = _redacted_error_message(error, sensitive_values)
    if isinstance(error, RunInfraStreamParseError):
        return RunInfraStreamParseError(message, request_id=error.request_id)
    if isinstance(error, UnsupportedOperationError):
        return UnsupportedOperationError(message)
    if isinstance(error, WebhookVerificationError):
        return WebhookVerificationError(message)
    try:
        return error.__class__(
            message,
            status=error.status,
            error_type=error.type,
            request_id=error.request_id,
            retry_after_seconds=error.retry_after_seconds,
        )
    except TypeError:
        return RunInfraError(
            message,
            status=error.status,
            error_type=error.type,
            request_id=error.request_id,
            retry_after_seconds=error.retry_after_seconds,
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
    ) -> None:
        self.api_key = api_key
        self.base_url = base_url
        self.pipeline_scoped = pipeline_scoped
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
        idempotent_replay_safe: bool = False,
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
            error_to_raise: Optional[RunInfraError] = None
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
                error_to_raise = _redacted_runinfra_error(exc.error, [self.api_key])
            except RunInfraError as exc:
                error_to_raise = _redacted_runinfra_error(exc, [self.api_key])
            except Exception as exc:
                if can_retry and attempt < max_retries:
                    attempt += 1
                    time.sleep(_retry_delay_seconds(attempt, retry_base_seconds))
                    continue
                error_to_raise = _transport_error(exc, sensitive_values=[self.api_key])
            if error_to_raise is not None:
                raise error_to_raise

            if 200 <= response.status < 300:
                return response
            if can_retry and _is_retryable(response.status) and attempt < max_retries:
                attempt += 1
                _discard_response_body(response)
                time.sleep(_retry_delay_seconds(attempt, retry_base_seconds, response))
                continue
            raise _redacted_runinfra_error(_error_from_response(response), [self.api_key])


class _ChatCompletions:
    def __init__(self, requester: _Requester) -> None:
        self._requester = requester

    @overload
    def create(
        self,
        *,
        model: str,
        messages: Sequence[Mapping[str, object]],
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
        request_options: Optional[Mapping[str, Any]] = None,
        extra_body: Optional[Mapping[str, object]] = None,
    ) -> RunInfraStream: ...

    @overload
    def create(
        self,
        *,
        model: str,
        messages: Sequence[Mapping[str, object]],
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
        request_options: Optional[Mapping[str, Any]] = None,
        extra_body: Optional[Mapping[str, object]] = None,
    ) -> ChatCompletionResponse: ...

    @overload
    def create(
        self,
        *,
        model: str,
        messages: Sequence[Mapping[str, object]],
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
        request_options: Optional[Mapping[str, Any]] = None,
        extra_body: Optional[Mapping[str, object]] = None,
    ) -> Union[ChatCompletionResponse, RunInfraStream]: ...

    def create(
        self,
        *,
        model: str,
        messages: Sequence[Mapping[str, object]],
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
        request_options: Optional[Mapping[str, Any]] = None,
        extra_body: Optional[Mapping[str, object]] = None,
    ) -> Union[ChatCompletionResponse, RunInfraStream]:
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
            },
            extra_body,
        )
        _validate_chat_messages(payload.get("messages"))
        is_stream = payload.get("stream") is True
        response = self._requester.request(
            "/chat/completions",
            json_payload=payload,
            stream=is_stream,
            idempotent_replay_safe=True,
            request_options=request_options,
        )
        if is_stream:
            return RunInfraStream(
                response.body,
                _request_id_from_headers(response.headers),
                [self._requester.api_key],
            )
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
        response = self._requester.request(
            "/responses",
            json_payload=payload,
            stream=is_stream,
            idempotent_replay_safe=True,
            request_options=request_options,
        )
        if is_stream:
            return RunInfraStream(
                response.body,
                _request_id_from_headers(response.headers),
                [self._requester.api_key],
            )
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

    [EXPERIMENTAL] As of v0.1.4, these methods have NOT been verified end-to-end
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

    [EXPERIMENTAL] As of v0.1.4, this method has NOT been verified end-to-end
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

    [EXPERIMENTAL] As of v0.1.4, this method has NOT been verified end-to-end
    against a live deployed pipeline in the canary suite. It requires a
    pipeline-scoped client and posts binary audio to `/pipeline`, but you
    should test against your own deployed pipeline before using in production.
    Live-canary verification is tracked for v1.0.0 GA.
    """

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
        normalized_base_url = _normalize_base_url(base_url, pipeline_id)
        requester = _Requester(
            api_key=api_key,
            base_url=normalized_base_url,
            pipeline_scoped=pipeline_id is not None or _base_url_looks_pipeline_scoped(normalized_base_url),
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

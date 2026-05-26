#!/usr/bin/env python
from __future__ import annotations

import argparse
import hashlib
import hmac
import inspect
import json
import math
import os
import random
import re
import sys
import time
import traceback
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Union

REPO_ROOT = Path(__file__).resolve().parents[1]
if os.environ.get("RUNINFRA_CANARY_PYTHON_IMPORT_MODE") != "installed":
    sys.path.insert(0, str(REPO_ROOT / "python"))

import runinfra as runinfra_module  # noqa: E402
from runinfra import (  # noqa: E402
    __version__,
    AuthenticationError,
    InsufficientCreditsError,
    ModelNotFoundError,
    PermissionDeniedError,
    RateLimitError,
    RunInfra,
    RunInfraConnectionError,
    RunInfraError,
    RunInfraResponse,
    RunInfraStreamParseError,
    RunInfraTimeoutError,
    construct_webhook_event,
    verify_webhook_signature,
)

TTS_RESPONSE_FORMATS = {"mp3", "opus", "aac", "flac", "wav", "pcm"}
MISSING_MODEL_ID = "runinfra-sdk-canary-missing-model"
PRODUCTION_BASE_URL = "https://api.runinfra.ai/v1"
SLOW_CONSUMER_DELAY_REQUIREMENT = "RUNINFRA_CANARY_STREAM_SLOW_CONSUMER_DELAY_MS non-negative integer <= 5000"
SLOW_CONSUMER_DELAY_ERROR = "RUNINFRA_CANARY_STREAM_SLOW_CONSUMER_DELAY_MS must be a non-negative integer <= 5000"


def env(name: str) -> Optional[str]:
    value = os.environ.get(name, "").strip()
    return value or None


def first_env(*names: str) -> Optional[str]:
    for name in names:
        value = env(name)
        if value:
            return value
    return None


def redacted_env(names: Iterable[str]) -> Dict[str, str]:
    return {name: "set_redacted" if env(name) else "missing" for name in names}


def assert_object(value: Any, label: str) -> Dict[str, Any]:
    if not isinstance(value, dict):
        raise AssertionError(f"{label} must be a JSON object")
    return value


def assert_non_empty_list(value: Any, label: str) -> None:
    if not isinstance(value, list) or not value:
        raise AssertionError(f"{label} must be a non-empty list")


def assert_json_array(value: Any, label: str) -> None:
    if not isinstance(value, list):
        raise AssertionError(f"{label} must be an array")


def assert_string(value: Any, label: str) -> None:
    if not isinstance(value, str) or not value:
        raise AssertionError(f"{label} must be a non-empty string")


def assert_optional_string(value: Any, label: str) -> None:
    if value is not None and not isinstance(value, str):
        raise AssertionError(f"{label} must be a string when present")


def assert_optional_number(value: Any, label: str) -> None:
    if value is not None and not isinstance(value, (int, float)):
        raise AssertionError(f"{label} must be a number when present")


def assert_non_negative_integer(value: Any, label: str) -> None:
    if not isinstance(value, int) or isinstance(value, bool) or value < 0:
        raise AssertionError(f"{label} must be a non-negative integer")


def assert_request_id(value: Any, label: str) -> None:
    if not isinstance(value, str) or not value:
        raise AssertionError(f"{label} did not expose x-request-id")


def assert_clear_unsupported_parameter_error(error: BaseException, label: str) -> Dict[str, Any]:
    status = getattr(error, "status", None)
    if status not in {400, 422}:
        raise AssertionError(f"{label} expected a clear 400/422 validation error, got {status or 'unknown'}")
    error_type = getattr(error, "type", None)
    allowed_types = {
        "bad_request",
        "invalid_request",
        "invalid_request_error",
        "invalid_request_options",
        "unsupported_operation",
        "unsupported_parameter",
        "validation_error",
    }
    if not isinstance(error_type, str) or error_type not in allowed_types:
        raise AssertionError(f"{label} expected an invalid-parameter error type, got {error_type or 'unknown'}")
    request_id = getattr(error, "request_id", None)
    assert_request_id(request_id, label)
    return {"errorType": error_type, "errorStatus": status, "requestId": request_id}


def required_positive_integer_env(name: str) -> int:
    value = env(name)
    if not value:
        raise AssertionError(f"{name} missing")
    if not re.fullmatch(r"[1-9][0-9]*", value):
        raise AssertionError(f"{name} must be a positive integer")
    return int(value)


def assert_chat_completion_envelope(response: Dict[str, Any], label: str) -> None:
    assert_string(response.get("id"), f"{label}.id")
    assert_optional_string(response.get("object"), f"{label}.object")
    assert_optional_number(response.get("created"), f"{label}.created")
    assert_string(response.get("model"), f"{label}.model")
    assert_non_empty_list(response.get("choices"), f"{label}.choices")
    choice = assert_object(response["choices"][0], f"{label}.choices[0]")
    assert_optional_number(choice.get("index"), f"{label}.choices[0].index")
    message = assert_object(choice.get("message"), f"{label}.choices[0].message")
    assert_string(message.get("role"), f"{label}.choices[0].message.role")
    assert_optional_string(message.get("content"), f"{label}.choices[0].message.content")


def assert_chat_stream_envelope(event: Dict[str, Any], label: str) -> None:
    assert_optional_string(event.get("id"), f"{label}.id")
    assert_optional_string(event.get("object"), f"{label}.object")
    assert_optional_number(event.get("created"), f"{label}.created")
    assert_optional_string(event.get("model"), f"{label}.model")
    assert_non_empty_list(event.get("choices"), f"{label}.choices")
    choice = assert_object(event["choices"][0], f"{label}.choices[0]")
    assert_optional_number(choice.get("index"), f"{label}.choices[0].index")
    if choice.get("delta") is not None:
        assert_object(choice["delta"], f"{label}.choices[0].delta")


def is_chat_stream_usage_event(event: Dict[str, Any]) -> bool:
    return (
        isinstance(event.get("choices"), list)
        and len(event["choices"]) == 0
        and isinstance(event.get("usage"), dict)
    )


def assert_chat_stream_usage_event(event: Dict[str, Any], label: str) -> None:
    assert_optional_string(event.get("id"), f"{label}.id")
    assert_optional_string(event.get("object"), f"{label}.object")
    assert_optional_number(event.get("created"), f"{label}.created")
    assert_optional_string(event.get("model"), f"{label}.model")
    choices = event.get("choices")
    if not isinstance(choices, list) or choices:
        raise AssertionError(f"{label}.choices must be an empty list for a chat usage chunk")
    assert_chat_usage_object(event.get("usage"), f"{label}.usage")


def assert_chat_stream_compatibility_event(event: Dict[str, Any], label: str) -> None:
    if is_chat_stream_usage_event(event):
        assert_chat_stream_usage_event(event, label)
        return
    assert_chat_stream_envelope(event, label)


def assert_chat_usage_object(value: Any, label: str) -> None:
    usage = assert_object(value, label)
    for field in ("prompt_tokens", "completion_tokens", "total_tokens"):
        assert_non_negative_integer(usage.get(field), f"{label}.{field}")


def assert_responses_envelope(response: Dict[str, Any], label: str) -> None:
    assert_string(response.get("id"), f"{label}.id")
    assert_optional_string(response.get("object"), f"{label}.object")
    assert_optional_string(response.get("status"), f"{label}.status")
    if not response.get("output_text") and not isinstance(response.get("output"), list):
        raise AssertionError(f"{label} missing output_text or output array")


def assert_responses_stream_envelope(event: Dict[str, Any], label: str) -> None:
    response = event.get("response")
    if not (
        isinstance(event.get("type"), str)
        or isinstance(event.get("status"), str)
        or (isinstance(response, dict) and isinstance(response.get("status"), str))
    ):
        raise AssertionError(f"{label} missing semantic response stream type/status")


def assert_embeddings_envelope(response: Dict[str, Any], label: str) -> None:
    assert_optional_string(response.get("object"), f"{label}.object")
    assert_non_empty_list(response.get("data"), f"{label}.data")
    first = assert_object(response["data"][0], f"{label}.data[0]")
    assert_optional_string(first.get("object"), f"{label}.data[0].object")
    assert_optional_number(first.get("index"), f"{label}.data[0].index")
    vector = first.get("embedding")
    if not isinstance(vector, list) or not vector:
        raise AssertionError(f"{label}.data[0].embedding must be a non-empty array")
    if not all(isinstance(item, (int, float)) and math.isfinite(item) for item in vector):
        raise AssertionError(f"{label}.data[0].embedding must contain finite numbers")


def assert_image_envelope(response: Dict[str, Any], label: str) -> None:
    assert_optional_number(response.get("created"), f"{label}.created")
    assert_non_empty_list(response.get("data"), f"{label}.data")
    first = assert_object(response["data"][0], f"{label}.data[0]")
    if not isinstance(first.get("url"), str) and not isinstance(first.get("b64_json"), str):
        raise AssertionError(f"{label}.data[0] missing url or b64_json")


def assert_image_output_format(response: Dict[str, Any], response_format: str, label: str) -> None:
    first = assert_object(response["data"][0], f"{label}.data[0]")
    if response_format == "url" and not isinstance(first.get("url"), str):
        raise AssertionError(f"{label}.data[0] missing requested url output")
    if response_format == "b64_json" and not isinstance(first.get("b64_json"), str):
        raise AssertionError(f"{label}.data[0] missing requested b64_json output")
    if response_format == "url" and isinstance(first.get("b64_json"), str):
        raise AssertionError(f"{label}.data[0] included b64_json despite requested url output")
    if response_format == "b64_json" and isinstance(first.get("url"), str):
        raise AssertionError(f"{label}.data[0] included url despite requested b64_json output")


def assert_audio_content_type(value: Any, label: str) -> None:
    assert_string(value, f"{label}.content_type")
    if "json" in value.lower():
        raise AssertionError(f"{label} returned JSON content type instead of binary audio")


def normalized_text(value: Any) -> str:
    return re.sub(r"[^a-z0-9]+", " ", str(value or "").lower()).strip()


def asr_fixture() -> Dict[str, Any]:
    path = env("RUNINFRA_ASR_FIXTURE_PATH")
    if not path:
        raise AssertionError("ASR fixture missing")
    resolved = Path(path).resolve()
    content = resolved.read_bytes()
    if not content:
        raise AssertionError("ASR fixture was empty")
    return {
        "content": content,
        "filename": resolved.name,
        "content_type": env("RUNINFRA_ASR_FIXTURE_CONTENT_TYPE") or "audio/wav",
    }


def voice_pipeline_fixture_path() -> Optional[str]:
    return first_env("RUNINFRA_VOICE_PIPELINE_AUDIO_PATH", "RUNINFRA_ASR_FIXTURE_PATH")


def voice_pipeline_expected_text() -> Optional[str]:
    return first_env("RUNINFRA_VOICE_PIPELINE_EXPECTED_TEXT", "RUNINFRA_ASR_EXPECTED_TEXT")


def voice_pipeline_fixture() -> Dict[str, Any]:
    path = voice_pipeline_fixture_path()
    if not path:
        raise AssertionError("voice pipeline fixture missing")
    resolved = Path(path).resolve()
    content = resolved.read_bytes()
    if not content:
        raise AssertionError("voice pipeline fixture was empty")
    return {
        "content": content,
        "content_type": first_env(
            "RUNINFRA_VOICE_PIPELINE_AUDIO_CONTENT_TYPE",
            "RUNINFRA_ASR_FIXTURE_CONTENT_TYPE",
        ) or "audio/wav",
    }


def assert_voice_pipeline_expected_text(response: Dict[str, Any]) -> Dict[str, str]:
    expected = normalized_text(voice_pipeline_expected_text())
    if not expected:
        raise AssertionError("voice pipeline expected text missing")
    fields = [
        "transcript",
        "text",
        "responseText",
        "response",
        "response_text",
        "outputText",
        "output_text",
    ]
    for field in fields:
        actual = normalized_text(get_path_value(response, field))
        if actual and expected in actual:
            return {"textEvidenceField": field}
    raise AssertionError(f"voice pipeline response did not include expected text in: {', '.join(fields)}")


def error_summary(error: BaseException) -> Dict[str, Any]:
    return {
        "name": error.__class__.__name__,
        "type": safe_diagnostic_token(getattr(error, "type", None)),
        "diagnostic": canary_diagnostic(error),
        "status": getattr(error, "status", None),
        "requestId": getattr(error, "request_id", None),
        "message": "redacted",
    }


def canary_diagnostic(error: BaseException) -> Optional[str]:
    message = str(error)
    if "unexpectedly succeeded" in message:
        return "unexpected_success"
    if "expected a clear 400/422 validation error" in message:
        return "invalid_error_shape"
    if "did not expose x-request-id" in message:
        return "missing_request_id"
    if "did not emit a terminal event" in message:
        return "missing_terminal_event"
    if "timed out" in message:
        return "timeout"
    if "must be a JSON object" in message or "must be a non-empty list" in message:
        return "invalid_response_shape"
    return None


def safe_diagnostic_token(value: Any) -> Optional[str]:
    if not isinstance(value, str):
        return None
    return value if re.fullmatch(r"[a-zA-Z0-9_.:-]{1,80}", value) else "redacted"


def read_some_stream(stream: Any, label: str) -> List[Dict[str, Any]]:
    events = []
    iterator = iter(stream)
    try:
        while len(events) < 3:
            try:
                event = next(iterator)
            except StopIteration:
                break
            events.append(assert_object(event, f"{label} event"))
    finally:
        iterator.close()
    assert_non_empty_list(events, f"{label} events")
    return events


def read_full_stream(stream: Any, label: str, has_terminal_event: Callable[[Dict[str, Any]], bool]) -> List[Dict[str, Any]]:
    events = []
    for event in stream:
        events.append(assert_object(event, f"{label} event"))
        if len(events) > 200:
            raise AssertionError(f"{label} exceeded 200 events without ending")
    assert_non_empty_list(events, f"{label} events")
    if not any(has_terminal_event(event) for event in events):
        raise AssertionError(f"{label} did not emit a terminal event")
    return events


def slow_consumer_delay_requirement() -> List[str]:
    value = env("RUNINFRA_CANARY_STREAM_SLOW_CONSUMER_DELAY_MS")
    if not value:
        return []
    if not re.fullmatch(r"(?:0|[1-9][0-9]*)", value):
        return [SLOW_CONSUMER_DELAY_REQUIREMENT]
    return [] if int(value) <= 5000 else [SLOW_CONSUMER_DELAY_REQUIREMENT]


def slow_consumer_delay_seconds() -> float:
    value = env("RUNINFRA_CANARY_STREAM_SLOW_CONSUMER_DELAY_MS")
    if not value:
        return 0.025
    if slow_consumer_delay_requirement():
        raise AssertionError(SLOW_CONSUMER_DELAY_ERROR)
    return int(value) / 1000


def slow_stream_requirements() -> List[str]:
    return [
        *[name for name in ("RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL") if not env(name)],
        *slow_consumer_delay_requirement(),
    ]


def canary_timeout_seconds() -> float:
    return float(env("RUNINFRA_CANARY_TIMEOUT_SECONDS") or "120")


def sleep_within_deadline(delay_seconds: float, deadline: float, label: str) -> None:
    if delay_seconds <= 0:
        return
    remaining = deadline - time.perf_counter()
    if remaining <= 0 or delay_seconds > remaining:
        raise AssertionError(f"{label} slow-consumer timed out")
    time.sleep(delay_seconds)


def read_slow_stream(
    stream: Any,
    label: str,
    has_terminal_event: Callable[[Dict[str, Any]], bool],
    delay_seconds: Optional[float] = None,
) -> Dict[str, Any]:
    events = []
    delay_seconds = slow_consumer_delay_seconds() if delay_seconds is None else delay_seconds
    deadline = time.perf_counter() + canary_timeout_seconds()
    for event in stream:
        events.append(assert_object(event, f"{label} event"))
        if len(events) > 200:
            raise AssertionError(f"{label} exceeded 200 events without ending")
        sleep_within_deadline(delay_seconds, deadline, label)
    assert_non_empty_list(events, f"{label} events")
    if not any(has_terminal_event(event) for event in events):
        raise AssertionError(f"{label} did not emit a terminal event")
    return {"events": events, "delay": "set_redacted"}


class LocalStreamTransport:
    def __init__(self, body: Any, request_id: str) -> None:
        self.body = body
        self.request_id = request_id

    def __call__(self, _request: Any) -> RunInfraResponse:
        return RunInfraResponse(
            200,
            {"content-type": "text/event-stream", "x-request-id": self.request_id},
            self.body,
        )


def local_stream_client(body: Any, request_id: str) -> RunInfra:
    return RunInfra(
        api_key="sk-ri-live-canary-local",
        base_url="http://localhost:1/v1",
        max_retries=0,
        transport=LocalStreamTransport(body, request_id),
    )


def local_chat_stream(body: Any, request_id: str) -> Any:
    stream = local_stream_client(body, request_id).chat.completions.create(
        model="runinfra-local-stream-model",
        messages=[{"role": "user", "content": "local stream canary"}],
        stream=True,
    )
    assert_request_id(stream.request_id, request_id)
    return stream


def local_responses_stream(body: Any, request_id: str) -> Any:
    stream = local_stream_client(body, request_id).responses.create(
        model="runinfra-local-stream-model",
        input="local stream canary",
        stream=True,
    )
    assert_request_id(stream.request_id, request_id)
    return stream


def expect_stream_error(
    stream: Any,
    error_class: Any,
    error_type: str,
    label: str,
    *,
    read_first: bool = False,
) -> Dict[str, Any]:
    iterator = iter(stream)
    try:
        if read_first:
            first = next(iterator)
            assert_object(first, f"{label} first event")
        try:
            next(iterator)
        except error_class as error:
            if getattr(error, "type", None) != error_type:
                raise AssertionError(f"{label} expected {error_type}, got {getattr(error, 'type', None) or 'unknown'}")
            request_id = getattr(error, "request_id", None)
            assert_request_id(request_id, label)
            return {"requestId": request_id, "errorType": error_type, "errorName": error.__class__.__name__}
        except BaseException as error:
            raise AssertionError(f"{label} expected {error_class.__name__}, got {error.__class__.__name__}") from error
        raise AssertionError(f"{label} did not raise the expected stream error")
    finally:
        close = getattr(iterator, "close", None)
        if callable(close):
            close()


def chat_disconnect_chunks() -> Iterable[bytes]:
    yield b'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'
    raise ConnectionResetError("stream reset")


def chat_stalled_chunks() -> Iterable[bytes]:
    yield b'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n'
    raise TimeoutError("stream read timed out")


def responses_disconnect_chunks() -> Iterable[bytes]:
    yield b'data: {"type":"response.output_text.delta","delta":"hi"}\n\n'
    raise ConnectionResetError("stream reset")


def responses_stalled_chunks() -> Iterable[bytes]:
    yield b'data: {"type":"response.output_text.delta","delta":"hi"}\n\n'
    raise TimeoutError("stream read timed out")


def local_retry_response(
    payload: Dict[str, Any],
    status: int,
    request_id: str,
    headers: Optional[Dict[str, str]] = None,
) -> RunInfraResponse:
    response_headers = {"content-type": "application/json", "x-request-id": request_id}
    if headers:
        response_headers.update(headers)
    return RunInfraResponse(
        status,
        response_headers,
        json.dumps(payload).encode("utf-8"),
    )


def local_retry_failure(request_id: str) -> RunInfraResponse:
    return local_retry_response(
        {"error": {"message": "transient local retry probe", "type": "api_error"}},
        503,
        request_id,
    )


class LocalRetryTransport:
    def __init__(self, responses: Iterable[RunInfraResponse]) -> None:
        self.responses = list(responses)
        self.calls: List[Any] = []

    def __call__(self, request: Any) -> RunInfraResponse:
        self.calls.append(request)
        if not self.responses:
            raise RuntimeError("local retry canary exhausted fake responses")
        return self.responses.pop(0)


def local_retry_client(responses: Iterable[RunInfraResponse], *, pipeline_id: Optional[str] = None) -> Dict[str, Any]:
    transport = LocalRetryTransport(responses)
    return {
        "client": RunInfra(
            api_key="sk-ri-live-canary-local",
            pipeline_id=pipeline_id,
            base_url="http://localhost:1/v1",
            max_retries=1,
            retry_base_seconds=0,
            timeout_seconds=1,
            transport=transport,
        ),
        "calls": transport.calls,
    }


class LocalTimeoutTransport:
    def __init__(self) -> None:
        self.calls: List[Any] = []

    def __call__(self, request: Any) -> RunInfraResponse:
        self.calls.append(request)
        raise TimeoutError("timed out")


def local_timeout_client() -> Dict[str, Any]:
    transport = LocalTimeoutTransport()
    return {
        "client": RunInfra(
            api_key="sk-ri-live-canary-local",
            base_url="http://localhost:1/v1",
            max_retries=0,
            retry_base_seconds=0,
            timeout_seconds=1,
            transport=transport,
        ),
        "calls": transport.calls,
    }


def assert_retry_call_count(calls: List[Any], expected: int, label: str) -> Dict[str, Any]:
    if len(calls) != expected:
        raise AssertionError(f"{label} expected {expected} local calls, got {len(calls)}")
    return {"attempts": len(calls)}


def assert_idempotency_header(calls: List[Any], expected: str, label: str) -> None:
    for index, call in enumerate(calls, start=1):
        if call.headers.get("Idempotency-Key") != expected:
            raise AssertionError(f"{label} call {index} expected idempotency header")


def assert_client_request_id_header(calls: List[Any], expected: str, label: str) -> None:
    for index, call in enumerate(calls, start=1):
        if call.headers.get("X-Client-Request-Id") != expected:
            raise AssertionError(f"{label} call {index} expected client request id header")


def assert_custom_header(calls: List[Any], name: str, expected: str, label: str) -> None:
    for index, call in enumerate(calls, start=1):
        if call.headers.get(name) != expected:
            raise AssertionError(f"{label} call {index} expected custom header {name}")


def assert_request_body_does_not_contain(call: Any, forbidden: Iterable[str], label: str) -> None:
    body = getattr(call, "body", b"") or b""
    if isinstance(body, bytes):
        text = body.decode("utf-8", errors="replace")
    else:
        text = str(body)
    for value in forbidden:
        if value in text:
            raise AssertionError(f"{label} leaked {value} into request body")


def request_body_json(call: Any, label: str) -> Dict[str, Any]:
    body = getattr(call, "body", b"") or b""
    if isinstance(body, bytes):
        text = body.decode("utf-8", errors="replace")
    else:
        text = str(body)
    try:
        parsed = json.loads(text)
    except json.JSONDecodeError as error:
        raise AssertionError(f"{label} expected JSON request body") from error
    if not isinstance(parsed, dict):
        raise AssertionError(f"{label} expected JSON object request body")
    return parsed


def assert_extra_body_json_field(call: Any, key: str, expected: Any, label: str) -> None:
    parsed = request_body_json(call, label)
    if parsed.get(key) != expected:
        raise AssertionError(f"{label} expected extra body field {key}")
    if "extraBody" in parsed or "extra_body" in parsed:
        raise AssertionError(f"{label} serialized SDK extra body option name")


def assert_invalid_request_option_error(error: BaseException, label: str) -> Dict[str, Any]:
    if getattr(error, "status", None) != 0 or getattr(error, "type", None) != "invalid_request_options":
        raise AssertionError(
            f"{label} invalid request option mapped unexpectedly: {getattr(error, 'status', None)} {getattr(error, 'type', None)}"
        )
    return {"errorType": getattr(error, "type", None), "errorStatus": getattr(error, "status", None)}


def assert_unknown_request_field_rejected(
    run: Callable[[], Any],
    calls: List[Any],
    field: str,
    label: str,
) -> Dict[str, Any]:
    calls_before = len(calls)
    try:
        run()
    except TypeError as error:
        if field not in str(error):
            raise AssertionError(f"{label} rejected unknown field with unclear message") from error
        if len(calls) != calls_before:
            raise AssertionError(f"{label} sent a request after rejecting unknown direct request field")
        return {"errorType": "type_error", "errorName": error.__class__.__name__}
    except BaseException as error:
        raise AssertionError(f"{label} expected TypeError, got {error.__class__.__name__}") from error
    raise AssertionError(f"{label} accepted unknown direct request field")


def assert_retryable_error(error: BaseException, label: str) -> Dict[str, Any]:
    if not isinstance(error, RunInfraError) or getattr(error, "status", None) != 503:
        raise AssertionError(
            f"{label} expected local 503 RunInfraError, got {getattr(error, 'status', None) or error.__class__.__name__}"
        )
    request_id = getattr(error, "request_id", None)
    assert_request_id(request_id, label)
    return {
        "errorStatus": getattr(error, "status", None),
        "errorType": getattr(error, "type", None),
        "requestId": request_id,
    }


def assert_rate_limit_error(error: BaseException, label: str, expected_retry_after_seconds: float) -> Dict[str, Any]:
    if not isinstance(error, RateLimitError):
        raise AssertionError(f"{label} expected RateLimitError, got {error.__class__.__name__}")
    if getattr(error, "status", None) != 429 or getattr(error, "type", None) != "rate_limit_error":
        raise AssertionError(
            f"{label} rate-limit error mapped unexpectedly: {getattr(error, 'status', None)} {getattr(error, 'type', None)}"
        )
    if getattr(error, "retry_after_seconds", None) != expected_retry_after_seconds:
        raise AssertionError(
            f"{label} expected retry_after_seconds {expected_retry_after_seconds}, got {getattr(error, 'retry_after_seconds', None)}"
        )
    request_id = getattr(error, "request_id", None)
    assert_request_id(request_id, label)
    return {
        "errorType": getattr(error, "type", None),
        "errorStatus": getattr(error, "status", None),
        "requestId": request_id,
        "retryAfterSeconds": getattr(error, "retry_after_seconds", None),
    }


def assert_insufficient_credits_error(error: BaseException, label: str) -> Dict[str, Any]:
    if not isinstance(error, InsufficientCreditsError):
        raise AssertionError(f"{label} expected InsufficientCreditsError, got {error.__class__.__name__}")
    if getattr(error, "status", None) != 402 or getattr(error, "type", None) != "insufficient_credits":
        raise AssertionError(
            f"{label} insufficient-credits error mapped unexpectedly: {getattr(error, 'status', None)} {getattr(error, 'type', None)}"
        )
    request_id = getattr(error, "request_id", None)
    assert_request_id(request_id, label)
    return {
        "errorType": getattr(error, "type", None),
        "errorStatus": getattr(error, "status", None),
        "requestId": request_id,
    }


def is_chat_terminal_event(event: Dict[str, Any]) -> bool:
    choices = event.get("choices")
    return isinstance(choices, list) and any(
        isinstance(choice, dict) and "finish_reason" in choice and choice.get("finish_reason") is not None
        for choice in choices
    )


def is_responses_terminal_event(event: Dict[str, Any]) -> bool:
    event_type = event.get("type")
    response = event.get("response")
    return (
        event_type in {"response.completed", "response.done", "done"}
        or (isinstance(event_type, str) and event_type.endswith(".completed"))
        or event.get("status") == "completed"
        or (isinstance(response, dict) and response.get("status") == "completed")
    )


def report_base_url(value: str) -> str:
    if not env("RUNINFRA_BASE_URL"):
        return value
    return value if value == PRODUCTION_BASE_URL else "custom_set_redacted"


def get_path_value(value: Any, path: str) -> Any:
    current = value
    for segment in path.split("."):
        if not isinstance(current, dict):
            return None
        current = current.get(segment)
    return current


IDEMPOTENCY_EVIDENCE_FIELD_ERROR = "RUNINFRA_CANARY_IDEMPOTENCY_EVIDENCE_FIELD dot-separated response field paths"
IDEMPOTENCY_EVIDENCE_FIELD_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*$")


def idempotency_evidence_fields() -> List[str]:
    fields = [
        field.strip()
        for field in (
            env("RUNINFRA_CANARY_IDEMPOTENCY_EVIDENCE_FIELD")
            or "idempotency_replayed,_idempotency_replayed,_idempotent_replay,idempotency.replayed,replay.replayed"
        ).split(",")
        if field.strip()
    ]
    if not fields or any(IDEMPOTENCY_EVIDENCE_FIELD_RE.fullmatch(field) is None for field in fields):
        raise AssertionError(IDEMPOTENCY_EVIDENCE_FIELD_ERROR)
    return fields


def optional_idempotency_evidence_field_requirement() -> List[str]:
    try:
        idempotency_evidence_fields()
    except AssertionError:
        return [IDEMPOTENCY_EVIDENCE_FIELD_ERROR]
    return []


def assert_idempotency_replay_evidence(response: Dict[str, Any]) -> Dict[str, str]:
    fields = idempotency_evidence_fields()
    for field in fields:
        value = get_path_value(response, field)
        if value is True or value in {"true", "replayed", "hit"}:
            return {"idempotencyEvidenceField": field}
    raise AssertionError(
        f"second idempotent response did not expose replay evidence in any field: {', '.join(fields)}"
    )


def speech_voice_payload() -> Optional[Dict[str, str]]:
    voice = env("RUNINFRA_TTS_VOICE")
    ref_audio = env("RUNINFRA_TTS_REF_AUDIO")
    ref_text = env("RUNINFRA_TTS_REF_TEXT")
    if voice:
        return {"voice": voice}
    if ref_audio and ref_text:
        return {
            "ref_audio": ref_audio,
            "ref_text": ref_text,
            "task_type": env("RUNINFRA_TTS_TASK_TYPE") or "Base",
        }
    return None


def main() -> int:
    parser = argparse.ArgumentParser(description="Run RunInfra Python SDK live canaries.")
    parser.add_argument("--strict", action="store_true", help="Fail when any matrix row is skipped.")
    parser.add_argument("--report", help="Write a redacted JSON report to this path.")
    args = parser.parse_args()

    relevant_env = [
        "RUNINFRA_API_KEY",
        "RUNINFRA_BASE_URL",
        "RUNINFRA_CANARY_TIMEOUT_SECONDS",
        "RUNINFRA_CANARY_STREAM_SLOW_CONSUMER_DELAY_MS",
        "RUNINFRA_LLM_MODEL",
        "RUNINFRA_EMBEDDING_MODEL",
        "RUNINFRA_EMBEDDING_DIMENSIONS",
        "RUNINFRA_IMAGE_MODEL",
        "RUNINFRA_IMAGE_SIZE",
        "RUNINFRA_IMAGE_RESPONSE_FORMAT",
        "RUNINFRA_TTS_MODEL",
        "RUNINFRA_TTS_VOICE",
        "RUNINFRA_TTS_REF_AUDIO",
        "RUNINFRA_TTS_REF_TEXT",
        "RUNINFRA_TTS_TASK_TYPE",
        "RUNINFRA_TTS_RESPONSE_FORMAT",
        "RUNINFRA_ASR_MODEL",
        "RUNINFRA_ASR_LANGUAGE",
        "RUNINFRA_ASR_RESPONSE_FORMAT",
        "RUNINFRA_ASR_FIXTURE_PATH",
        "RUNINFRA_ASR_FIXTURE_CONTENT_TYPE",
        "RUNINFRA_ASR_EXPECTED_TEXT",
        "RUNINFRA_PIPELINE_API_KEY",
        "RUNINFRA_VOICE_PIPELINE_ID",
        "RUNINFRA_VOICE_PIPELINE_API_KEY",
        "RUNINFRA_VOICE_PIPELINE_AUDIO_PATH",
        "RUNINFRA_VOICE_PIPELINE_AUDIO_CONTENT_TYPE",
        "RUNINFRA_VOICE_PIPELINE_EXPECTED_TEXT",
        "RUNINFRA_CANARY_ENABLE_IDEMPOTENCY",
        "RUNINFRA_CANARY_IDEMPOTENCY_EVIDENCE_FIELD",
    ]
    api_key = env("RUNINFRA_API_KEY")
    base_url = env("RUNINFRA_BASE_URL") or PRODUCTION_BASE_URL
    llm_model = env("RUNINFRA_LLM_MODEL")
    embedding_model = env("RUNINFRA_EMBEDDING_MODEL")
    image_model = env("RUNINFRA_IMAGE_MODEL")
    tts_model = env("RUNINFRA_TTS_MODEL")
    asr_model = env("RUNINFRA_ASR_MODEL")
    pipeline_id = first_env("RUNINFRA_VOICE_PIPELINE_ID", "TEST_PIPELINE_ID")
    pipeline_api_key = first_env("RUNINFRA_VOICE_PIPELINE_API_KEY", "RUNINFRA_PIPELINE_API_KEY", "RUNINFRA_API_KEY")
    timeout_seconds = float(env("RUNINFRA_CANARY_TIMEOUT_SECONDS") or "120")
    configuration_errors = optional_idempotency_evidence_field_requirement()
    if configuration_errors:
        summary = {"passed": 0, "failed": 1, "skipped": 0}
        report = {
            "schemaVersion": 1,
            "language": "python",
            "sdkVersion": __version__,
            "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "strict": args.strict,
            "baseURL": "not_checked",
            "env": redacted_env(relevant_env),
            "summary": summary,
            "results": [{
                "name": "configuration",
                "status": "failed",
                "durationMs": 0,
                "error": {
                    "name": "ConfigurationError",
                    "type": "invalid_configuration",
                    "message": "redacted",
                },
            }],
            "configuration": {"status": "failed", "errors": configuration_errors},
        }
        if args.report:
            report_path = Path(args.report).resolve()
            report_path.parent.mkdir(parents=True, exist_ok=True)
            report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
        print("Live canary configuration invalid:\n" + "\n".join(configuration_errors), file=sys.stderr)
        return 1

    def client(**overrides: Any) -> RunInfra:
        options: Dict[str, Any] = {
            "api_key": api_key,
            "base_url": base_url,
            "timeout_seconds": timeout_seconds,
            "max_retries": 0,
        }
        options.update(overrides)
        return RunInfra(**options)

    results: List[Dict[str, Any]] = []

    def missing(*names: str) -> List[str]:
        return [name for name in names if not env(name)]

    def record(name: str, requirements: Union[Callable[[], List[str]], List[str]], fn: Callable[[], Dict[str, Any]]) -> None:
        missing_requirements = requirements() if callable(requirements) else missing(*requirements)
        if missing_requirements:
            results.append({"name": name, "status": "skipped", "missing": missing_requirements, "durationMs": 0})
            return
        started = time.perf_counter()
        try:
            evidence = fn()
            results.append({"name": name, **evidence, "status": "passed", "durationMs": round((time.perf_counter() - started) * 1000)})
        except BaseException as error:  # noqa: BLE001
            results.append({
                "name": name,
                "status": "failed",
                "durationMs": round((time.perf_counter() - started) * 1000),
                "error": error_summary(error),
            })

    record("models.list", ["RUNINFRA_API_KEY"], lambda: _models_list(client()))
    record("models.retrieve.llm", ["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"], lambda: _model_retrieve(client(), llm_model, "models.retrieve.llm"))
    record("models.retrieve.embedding", ["RUNINFRA_API_KEY", "RUNINFRA_EMBEDDING_MODEL"], lambda: _model_retrieve(client(), embedding_model, "models.retrieve.embedding"))
    record("models.retrieve.image", ["RUNINFRA_API_KEY", "RUNINFRA_IMAGE_MODEL"], lambda: _model_retrieve(client(), image_model, "models.retrieve.image"))
    record("models.retrieve.tts", ["RUNINFRA_API_KEY", "RUNINFRA_TTS_MODEL"], lambda: _model_retrieve(client(), tts_model, "models.retrieve.tts"))
    record("models.retrieve.asr", ["RUNINFRA_API_KEY", "RUNINFRA_ASR_MODEL"], lambda: _model_retrieve(client(), asr_model, "models.retrieve.asr"))
    record("chat.completions.create", ["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"], lambda: _chat_create(client(), llm_model))
    record("openai.params.chat.completions", ["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"], lambda: _chat_params(client(), llm_model))
    record("openai.params.chat.stream_options", ["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"], lambda: _chat_stream_options(client(), llm_model))
    record("chat.completions.stream.final", ["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"], lambda: _chat_stream_final(client(), llm_model))
    record("chat.completions.stream.cancel", ["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"], lambda: _chat_stream_cancel(client(), llm_model))
    record("chat.completions.stream.slow_consumer", lambda: slow_stream_requirements(), lambda: _chat_stream_slow_consumer(client(), llm_model))
    record("chat.completions.stream.malformed_frame.local", [], _chat_stream_malformed_frame_local)
    record("chat.completions.stream.disconnect.local", [], _chat_stream_disconnect_local)
    record("chat.completions.stream.stalled_read.local", [], _chat_stream_stalled_read_local)
    record("responses.create", ["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"], lambda: _responses_create(client(), llm_model))
    record("openai.params.responses", ["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"], lambda: _responses_params(client(), llm_model))
    record("responses.stream.final", ["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"], lambda: _responses_stream_final(client(), llm_model))
    record("responses.stream.cancel", ["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"], lambda: _responses_stream_cancel(client(), llm_model))
    record("responses.stream.slow_consumer", lambda: slow_stream_requirements(), lambda: _responses_stream_slow_consumer(client(), llm_model))
    record("responses.stream.malformed_frame.local", [], _responses_stream_malformed_frame_local)
    record("responses.stream.disconnect.local", [], _responses_stream_disconnect_local)
    record("responses.stream.stalled_read.local", [], _responses_stream_stalled_read_local)
    record("embeddings.create", ["RUNINFRA_API_KEY", "RUNINFRA_EMBEDDING_MODEL"], lambda: _embeddings_create(client(), embedding_model))
    record(
        "openai.params.embeddings",
        ["RUNINFRA_API_KEY", "RUNINFRA_EMBEDDING_MODEL", "RUNINFRA_EMBEDDING_DIMENSIONS"],
        lambda: _embeddings_params(client(), embedding_model),
    )
    record("images.generate", ["RUNINFRA_API_KEY", "RUNINFRA_IMAGE_MODEL"], lambda: _images_generate(client(), image_model))
    record(
        "openai.params.images",
        ["RUNINFRA_API_KEY", "RUNINFRA_IMAGE_MODEL", "RUNINFRA_IMAGE_SIZE", "RUNINFRA_IMAGE_RESPONSE_FORMAT"],
        lambda: _images_params(client(), image_model),
    )
    record("audio.speech.create", lambda: _speech_requirements(), lambda: _speech_create(client(), tts_model))
    record(
        "openai.params.audio.speech",
        lambda: [
            *_speech_requirements(),
            *(["RUNINFRA_TTS_RESPONSE_FORMAT"] if not env("RUNINFRA_TTS_RESPONSE_FORMAT") else []),
        ],
        lambda: _speech_params(client(), tts_model),
    )
    record("audio.speech.binary_interfaces", lambda: _speech_requirements(), lambda: _speech_binary_interfaces(client(), tts_model))
    record(
        "audio.transcriptions.create",
        ["RUNINFRA_API_KEY", "RUNINFRA_ASR_MODEL", "RUNINFRA_ASR_FIXTURE_PATH", "RUNINFRA_ASR_EXPECTED_TEXT"],
        lambda: _transcriptions_create(client(), asr_model),
    )
    record(
        "openai.params.audio.transcriptions",
        [
            "RUNINFRA_API_KEY",
            "RUNINFRA_ASR_MODEL",
            "RUNINFRA_ASR_LANGUAGE",
            "RUNINFRA_ASR_RESPONSE_FORMAT",
            "RUNINFRA_ASR_FIXTURE_PATH",
            "RUNINFRA_ASR_EXPECTED_TEXT",
        ],
        lambda: _transcriptions_params(client(), asr_model),
    )
    record("voice.pipeline.create", lambda: _voice_requirements(pipeline_api_key, pipeline_id), lambda: _voice_pipeline_create(client(api_key=pipeline_api_key, pipeline_id=pipeline_id)))
    record("error.auth.invalid_key", [], lambda: _auth_error(base_url))
    record("error.model.not_found", ["RUNINFRA_API_KEY"], lambda: _model_not_found(client()))
    record("error.request.invalid_options", [], _invalid_request_options)
    record("error.insufficient_credits.local", [], _insufficient_credits_error_local)
    record("error.rate_limit.local", [], _rate_limit_error_local)
    record("request.client_request_id.local", [], _request_client_request_id_local)
    record("request.custom_headers.local", [], _request_custom_headers_local)
    record("request.timeout.local", [], _request_timeout_local)
    record("request.extra_body.local", [], _request_extra_body_local)
    record("request.unknown_fields.local", [], _request_unknown_fields_local)
    record("browser.api_key_guard.local", [], _browser_api_key_guard_local)
    record("security.api_key_redaction.local", [], assert_api_key_redaction)
    record("error.body.unsupported_parameter", ["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"], lambda: _unsupported_body_parameter(client(), llm_model))
    record("retry.safety.get.local", [], _retry_safety_get_local)
    record("retry.safety.post.requires_idempotency.local", [], _retry_safety_post_requires_idempotency_local)
    record("retry.safety.post.with_idempotency.local", [], _retry_safety_post_with_idempotency_local)
    record("retry.safety.post.non_replayable_json.no_retry.local", [], _retry_safety_post_non_replayable_json_no_retry_local)
    record("retry.safety.stream.no_retry.local", [], _retry_safety_stream_no_retry_local)
    record("retry.safety.audio_binary.no_retry.local", [], _retry_safety_audio_binary_no_retry_local)
    record("retry.safety.audio_multipart.no_retry.local", [], _retry_safety_audio_multipart_no_retry_local)
    record("retry.safety.voice_binary.no_retry.local", [], _retry_safety_voice_binary_no_retry_local)
    record("webhooks.delivery_surface.absent", [], _webhooks_delivery_surface_absent)
    record("webhooks.verify_signature.local", [], _webhooks_verify_signature_local)
    record("webhooks.construct_event.local", [], _webhooks_construct_event_local)
    record("webhooks.verify_signature.export", [], _webhooks_verify_signature_export)
    record("webhooks.construct_event.export", [], _webhooks_construct_event_export)
    record("idempotency.replay.responses", lambda: _idempotency_requirements(), lambda: _idempotency_replay(client(), llm_model))

    summary = {
        "passed": sum(1 for result in results if result["status"] == "passed"),
        "failed": sum(1 for result in results if result["status"] == "failed"),
        "skipped": sum(1 for result in results if result["status"] == "skipped"),
    }
    report = {
        "schemaVersion": 1,
        "language": "python",
        "sdkVersion": __version__,
        "generatedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        "strict": args.strict,
        "baseURL": report_base_url(base_url),
        "env": redacted_env(relevant_env),
        "summary": summary,
        "results": results,
    }
    if args.report:
        report_path = Path(args.report).resolve()
        report_path.parent.mkdir(parents=True, exist_ok=True)
        report_path.write_text(json.dumps(report, indent=2) + "\n", encoding="utf-8")
    print(json.dumps({"language": "python", "sdkVersion": __version__, "summary": summary}, indent=2))
    return 1 if summary["failed"] or (args.strict and summary["skipped"]) else 0


def _models_list(client: RunInfra) -> Dict[str, Any]:
    response = client.models.list()
    assert_object(response, "models.list response")
    assert_json_array(response.get("data"), "models.list data")
    assert_configured_models_listed(response["data"])
    assert_request_id(response.get("_request_id"), "models.list")
    return {"requestId": response.get("_request_id"), "itemCount": len(response["data"])}


def configured_canary_model_ids() -> List[str]:
    values = [
        env("RUNINFRA_LLM_MODEL"),
        env("RUNINFRA_EMBEDDING_MODEL"),
        env("RUNINFRA_IMAGE_MODEL"),
        env("RUNINFRA_TTS_MODEL"),
        env("RUNINFRA_ASR_MODEL"),
    ]
    output: List[str] = []
    for value in values:
        if value and value not in output:
            output.append(value)
    return output


def assert_configured_models_listed(models: Any) -> None:
    expected = configured_canary_model_ids()
    if not expected:
        return
    listed = {
        entry.get("id")
        for entry in models
        if isinstance(entry, dict) and isinstance(entry.get("id"), str)
    }
    missing_count = sum(1 for model_id in expected if model_id not in listed)
    if missing_count:
        raise AssertionError(f"models.list did not include {missing_count} configured canary model(s)")


def _model_retrieve(client: RunInfra, model: str, label: str) -> Dict[str, Any]:
    response = client.models.retrieve(model)
    assert_object(response, f"{label} response")
    if response.get("id") != model:
        raise AssertionError(f"{label} response id did not match requested model")
    assert_request_id(response.get("_request_id"), label)
    return {"requestId": response.get("_request_id")}


def _chat_create(client: RunInfra, model: str) -> Dict[str, Any]:
    response = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": "Reply with the single word ok."}],
        temperature=0,
        top_p=1,
        max_tokens=16,
        stop=["\n\n"],
    )
    assert_object(response, "chat response")
    assert_chat_completion_envelope(response, "chat response")
    assert_request_id(response.get("_request_id"), "chat.completions.create")
    return {"requestId": response.get("_request_id")}


def _chat_params(client: RunInfra, model: str) -> Dict[str, Any]:
    response = client.chat.completions.create(
        model=model,
        messages=[
            {"role": "system", "content": "You are a concise SDK compatibility canary."},
            {"role": "user", "content": "Reply with the single word ok."},
        ],
        temperature=0,
        top_p=1,
        max_tokens=16,
        stop=["\n\n"],
        presence_penalty=0,
        frequency_penalty=0,
        user="sdk-canary",
        metadata={"sdk_canary": "openai_params_chat"},
    )
    assert_object(response, "chat params response")
    assert_chat_completion_envelope(response, "chat params response")
    assert_request_id(response.get("_request_id"), "openai.params.chat.completions")
    return {"requestId": response.get("_request_id")}


def _chat_stream_options(client: RunInfra, model: str) -> Dict[str, Any]:
    stream = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": "Reply with the single word ok."}],
        temperature=0,
        max_tokens=16,
        stream=True,
        stream_options={"include_usage": True},
    )
    assert_request_id(stream.request_id, "openai.params.chat.stream_options")
    events = read_full_stream(stream, "chat stream options stream", is_chat_terminal_event)
    saw_usage = False
    for index, event in enumerate(events):
        if is_chat_stream_usage_event(event):
            assert_chat_stream_usage_event(event, f"chat stream options usage event {index}")
            saw_usage = True
        else:
            assert_chat_stream_envelope(event, f"chat stream options event {index}")
    if not saw_usage:
        raise AssertionError("chat stream options did not emit a usage event")
    return {"requestId": stream.request_id, "eventCount": len(events), "usage": "present"}


def _chat_stream_final(client: RunInfra, model: str) -> Dict[str, Any]:
    stream = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": "Reply with the single word ok."}],
        temperature=0,
        max_tokens=16,
        stream=True,
    )
    assert_request_id(stream.request_id, "chat.completions.stream.final")
    events = read_full_stream(stream, "chat stream", is_chat_terminal_event)
    for index, event in enumerate(events):
        assert_chat_stream_compatibility_event(event, f"chat stream event {index}")
    return {"requestId": stream.request_id, "eventCount": len(events)}


def _chat_stream_cancel(client: RunInfra, model: str) -> Dict[str, Any]:
    stream = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": "Reply with one sentence."}],
        temperature=0,
        max_tokens=32,
        stream=True,
    )
    assert_request_id(stream.request_id, "chat.completions.stream.cancel")
    events = read_some_stream(stream, "chat cancellation stream")
    for index, event in enumerate(events):
        assert_chat_stream_envelope(event, f"chat cancellation stream event {index}")
    return {"requestId": stream.request_id, "eventCount": len(events)}


def _chat_stream_slow_consumer(client: RunInfra, model: str) -> Dict[str, Any]:
    delay_seconds = slow_consumer_delay_seconds()
    stream = client.chat.completions.create(
        model=model,
        messages=[{"role": "user", "content": "Reply with one short sentence."}],
        temperature=0,
        max_tokens=32,
        stream=True,
    )
    assert_request_id(stream.request_id, "chat.completions.stream.slow_consumer")
    result = read_slow_stream(stream, "chat slow-consumer stream", is_chat_terminal_event, delay_seconds)
    events = result["events"]
    for index, event in enumerate(events):
        assert_chat_stream_compatibility_event(event, f"chat slow-consumer stream event {index}")
    return {
        "requestId": stream.request_id,
        "eventCount": len(events),
        "slowConsumerDelayMs": result["delay"],
    }


def _chat_stream_malformed_frame_local() -> Dict[str, Any]:
    stream = local_chat_stream(b"data: {not-json}\n\n", "req-local-chat-malformed")
    return expect_stream_error(
        stream,
        RunInfraStreamParseError,
        "stream_parse_error",
        "chat.completions.stream.malformed_frame.local",
    )


def _chat_stream_disconnect_local() -> Dict[str, Any]:
    stream = local_chat_stream(chat_disconnect_chunks(), "req-local-chat-disconnect")
    return expect_stream_error(
        stream,
        RunInfraConnectionError,
        "connection_error",
        "chat.completions.stream.disconnect.local",
        read_first=True,
    )


def _chat_stream_stalled_read_local() -> Dict[str, Any]:
    stream = local_chat_stream(chat_stalled_chunks(), "req-local-chat-stalled")
    return expect_stream_error(
        stream,
        RunInfraTimeoutError,
        "timeout_error",
        "chat.completions.stream.stalled_read.local",
        read_first=True,
    )


def _responses_create(client: RunInfra, model: str) -> Dict[str, Any]:
    response = client.responses.create(
        model=model,
        input="Reply with the single word ok.",
        instructions="Be concise.",
        temperature=0,
        max_output_tokens=16,
    )
    assert_object(response, "responses response")
    assert_responses_envelope(response, "responses response")
    assert_request_id(response.get("_request_id"), "responses.create")
    return {"requestId": response.get("_request_id"), "hasOutput": bool(response.get("output_text") or response.get("output"))}


def _responses_params(client: RunInfra, model: str) -> Dict[str, Any]:
    response = client.responses.create(
        model=model,
        input="Reply with the single word ok.",
        instructions="Be concise.",
        temperature=0,
        top_p=1,
        max_output_tokens=16,
    )
    assert_object(response, "responses params response")
    assert_responses_envelope(response, "responses params response")
    assert_request_id(response.get("_request_id"), "openai.params.responses")
    return {"requestId": response.get("_request_id"), "hasOutput": bool(response.get("output_text") or response.get("output"))}


def _responses_stream_final(client: RunInfra, model: str) -> Dict[str, Any]:
    stream = client.responses.create(
        model=model,
        input="Reply with the single word ok.",
        max_output_tokens=16,
        stream=True,
    )
    assert_request_id(stream.request_id, "responses.stream.final")
    events = read_full_stream(stream, "responses stream", is_responses_terminal_event)
    for index, event in enumerate(events):
        assert_responses_stream_envelope(event, f"responses stream event {index}")
    return {"requestId": stream.request_id, "eventCount": len(events)}


def _responses_stream_cancel(client: RunInfra, model: str) -> Dict[str, Any]:
    stream = client.responses.create(
        model=model,
        input="Reply with one sentence.",
        max_output_tokens=32,
        stream=True,
    )
    assert_request_id(stream.request_id, "responses.stream.cancel")
    events = read_some_stream(stream, "responses cancellation stream")
    for index, event in enumerate(events):
        assert_responses_stream_envelope(event, f"responses cancellation stream event {index}")
    return {"requestId": stream.request_id, "eventCount": len(events)}


def _responses_stream_slow_consumer(client: RunInfra, model: str) -> Dict[str, Any]:
    delay_seconds = slow_consumer_delay_seconds()
    stream = client.responses.create(
        model=model,
        input="Reply with one short sentence.",
        max_output_tokens=32,
        stream=True,
    )
    assert_request_id(stream.request_id, "responses.stream.slow_consumer")
    result = read_slow_stream(stream, "responses slow-consumer stream", is_responses_terminal_event, delay_seconds)
    events = result["events"]
    for index, event in enumerate(events):
        assert_responses_stream_envelope(event, f"responses slow-consumer stream event {index}")
    return {
        "requestId": stream.request_id,
        "eventCount": len(events),
        "slowConsumerDelayMs": result["delay"],
    }


def _responses_stream_malformed_frame_local() -> Dict[str, Any]:
    stream = local_responses_stream(b"data: {not-json}\n\n", "req-local-responses-malformed")
    return expect_stream_error(
        stream,
        RunInfraStreamParseError,
        "stream_parse_error",
        "responses.stream.malformed_frame.local",
    )


def _responses_stream_disconnect_local() -> Dict[str, Any]:
    stream = local_responses_stream(responses_disconnect_chunks(), "req-local-responses-disconnect")
    return expect_stream_error(
        stream,
        RunInfraConnectionError,
        "connection_error",
        "responses.stream.disconnect.local",
        read_first=True,
    )


def _responses_stream_stalled_read_local() -> Dict[str, Any]:
    stream = local_responses_stream(responses_stalled_chunks(), "req-local-responses-stalled")
    return expect_stream_error(
        stream,
        RunInfraTimeoutError,
        "timeout_error",
        "responses.stream.stalled_read.local",
        read_first=True,
    )


def _embeddings_create(client: RunInfra, model: str) -> Dict[str, Any]:
    response = client.embeddings.create(model=model, input=["runinfra live canary", "sdk ga gate"])
    assert_object(response, "embeddings response")
    assert_embeddings_envelope(response, "embeddings response")
    vector = response["data"][0].get("embedding")
    assert_request_id(response.get("_request_id"), "embeddings.create")
    return {"requestId": response.get("_request_id"), "vectorLength": len(vector)}


def _embeddings_params(client: RunInfra, model: str) -> Dict[str, Any]:
    dimensions = required_positive_integer_env("RUNINFRA_EMBEDDING_DIMENSIONS")
    response = client.embeddings.create(
        model=model,
        input="runinfra sdk openai parameter canary",
        encoding_format="float",
        dimensions=dimensions,
    )
    assert_object(response, "embeddings params response")
    assert_embeddings_envelope(response, "embeddings params response")
    vector = response["data"][0].get("embedding")
    assert_request_id(response.get("_request_id"), "openai.params.embeddings")
    if len(vector) != dimensions:
        raise AssertionError("embeddings params response ignored requested dimensions")
    return {"requestId": response.get("_request_id"), "vectorLength": len(vector)}


def _images_generate(client: RunInfra, model: str) -> Dict[str, Any]:
    request: Dict[str, Any] = {
        "model": model,
        "prompt": "A small green square on a white background.",
        "n": 1,
    }
    if env("RUNINFRA_IMAGE_SIZE"):
        request["size"] = env("RUNINFRA_IMAGE_SIZE")
    if env("RUNINFRA_IMAGE_RESPONSE_FORMAT"):
        request["response_format"] = env("RUNINFRA_IMAGE_RESPONSE_FORMAT")
    response = client.images.generate(**request)
    assert_object(response, "images response")
    assert_image_envelope(response, "images response")
    assert_request_id(response.get("_request_id"), "images.generate")
    return {"requestId": response.get("_request_id"), "output": "url" if response["data"][0].get("url") else "b64_json"}


def _image_response_format() -> str:
    response_format = env("RUNINFRA_IMAGE_RESPONSE_FORMAT")
    if response_format not in {"url", "b64_json"}:
        raise AssertionError("RUNINFRA_IMAGE_RESPONSE_FORMAT must be url or b64_json")
    return response_format


def _asr_response_format() -> str:
    response_format = env("RUNINFRA_ASR_RESPONSE_FORMAT")
    if response_format not in {"json", "verbose_json"}:
        raise AssertionError("RUNINFRA_ASR_RESPONSE_FORMAT must be json or verbose_json")
    return response_format


def _tts_response_format() -> str:
    response_format = env("RUNINFRA_TTS_RESPONSE_FORMAT")
    if not response_format:
        raise AssertionError("RUNINFRA_TTS_RESPONSE_FORMAT missing")
    if response_format not in TTS_RESPONSE_FORMATS:
        raise AssertionError("RUNINFRA_TTS_RESPONSE_FORMAT must be mp3, opus, aac, flac, wav, or pcm")
    return response_format


def _images_params(client: RunInfra, model: str) -> Dict[str, Any]:
    response_format = _image_response_format()
    response = client.images.generate(
        model=model,
        prompt="A small green square on a white background.",
        n=1,
        size=env("RUNINFRA_IMAGE_SIZE"),
        response_format=response_format,
    )
    assert_object(response, "images params response")
    assert_image_envelope(response, "images params response")
    assert_image_output_format(response, response_format, "images params response")
    assert_request_id(response.get("_request_id"), "openai.params.images")
    return {"requestId": response.get("_request_id"), "output": response_format}


def _speech_requirements() -> List[str]:
    missing_items = [name for name in ("RUNINFRA_API_KEY", "RUNINFRA_TTS_MODEL") if not env(name)]
    if not speech_voice_payload():
        missing_items.append("RUNINFRA_TTS_VOICE or RUNINFRA_TTS_REF_AUDIO plus RUNINFRA_TTS_REF_TEXT")
    return missing_items


def _speech_request(model: str, input_text: str, response_format: Optional[str] = None) -> Dict[str, Any]:
    request: Dict[str, Any] = {
        "model": model,
        "input": input_text,
        **(speech_voice_payload() or {}),
    }
    if response_format:
        request["response_format"] = response_format
    return request


def _speech_create(client: RunInfra, model: str) -> Dict[str, Any]:
    request = _speech_request(model, "RunInfra SDK live canary.")
    response = client.audio.speech.create(**request)
    if not response.content:
        raise AssertionError("TTS response was empty")
    assert_audio_content_type(response.content_type, "audio.speech.create")
    assert_request_id(response.request_id, "audio.speech.create")
    return {"requestId": response.request_id, "contentType": response.content_type, "byteLength": len(response.content)}


def _speech_params(client: RunInfra, model: str) -> Dict[str, Any]:
    response_format = _tts_response_format()
    request = _speech_request(model, "RunInfra SDK TTS parameter canary.", response_format=response_format)
    if request.get("response_format") != response_format:
        raise AssertionError("TTS parameter request did not include response_format")
    response = client.audio.speech.create(**request)
    if not response.content:
        raise AssertionError("TTS params response was empty")
    assert_audio_content_type(response.content_type, "openai.params.audio.speech")
    assert_request_id(response.request_id, "openai.params.audio.speech")
    return {
        "requestId": response.request_id,
        "responseFormat": "set_redacted",
        "contentType": response.content_type,
        "byteLength": len(response.content),
    }


def _speech_binary_interfaces(client: RunInfra, model: str) -> Dict[str, Any]:
    response = client.audio.speech.create(**_speech_request(model, "RunInfra SDK Python bytes canary."))
    if not isinstance(response.content, bytes) or not response.content:
        raise AssertionError("TTS bytes response was empty")
    assert_audio_content_type(response.content_type, "audio.speech.binary_interfaces")
    assert_request_id(response.request_id, "audio.speech.binary_interfaces")
    return {
        "requestId": response.request_id,
        "contentType": response.content_type,
        "byteLength": len(response.content),
    }


def _transcriptions_create(client: RunInfra, model: str) -> Dict[str, Any]:
    fixture = asr_fixture()
    request: Dict[str, Any] = {
        "model": model,
        "file": fixture["content"],
        "filename": fixture["filename"],
        "content_type": fixture["content_type"],
    }
    if env("RUNINFRA_ASR_LANGUAGE"):
        request["language"] = env("RUNINFRA_ASR_LANGUAGE")
    response = client.audio.transcriptions.create(**request)
    assert_object(response, "ASR response")
    assert_string(response.get("text"), "ASR response.text")
    expected = normalized_text(env("RUNINFRA_ASR_EXPECTED_TEXT"))
    actual = normalized_text(response.get("text"))
    if not expected or expected not in actual:
        raise AssertionError("ASR transcript did not include expected fixture text")
    assert_request_id(response.get("_request_id"), "audio.transcriptions.create")
    return {"requestId": response.get("_request_id"), "textLength": len(str(response.get("text", "")))}


def _transcriptions_params(client: RunInfra, model: str) -> Dict[str, Any]:
    fixture = asr_fixture()
    response_format = _asr_response_format()
    response = client.audio.transcriptions.create(
        model=model,
        file=fixture["content"],
        filename=fixture["filename"],
        content_type=fixture["content_type"],
        language=env("RUNINFRA_ASR_LANGUAGE"),
        prompt="RunInfra SDK ASR parameter canary.",
        response_format=response_format,
    )
    assert_object(response, "ASR params response")
    assert_string(response.get("text"), "ASR params response.text")
    expected = normalized_text(env("RUNINFRA_ASR_EXPECTED_TEXT"))
    actual = normalized_text(response.get("text"))
    if not expected or expected not in actual:
        raise AssertionError("ASR params transcript did not include expected fixture text")
    if response_format == "verbose_json":
        if (
            not isinstance(response.get("language"), str)
            and not isinstance(response.get("duration"), (int, float))
            and not isinstance(response.get("segments"), list)
        ):
            raise AssertionError("ASR verbose_json response did not include verbose fields")
    assert_request_id(response.get("_request_id"), "openai.params.audio.transcriptions")
    return {"requestId": response.get("_request_id"), "responseFormat": response_format}


def _voice_requirements(pipeline_api_key: Optional[str], pipeline_id: Optional[str]) -> List[str]:
    missing_items = []
    if not pipeline_api_key:
        missing_items.append("RUNINFRA_VOICE_PIPELINE_API_KEY or RUNINFRA_PIPELINE_API_KEY or RUNINFRA_API_KEY")
    if not pipeline_id:
        missing_items.append("RUNINFRA_VOICE_PIPELINE_ID or TEST_PIPELINE_ID")
    if not voice_pipeline_fixture_path():
        missing_items.append("RUNINFRA_VOICE_PIPELINE_AUDIO_PATH or RUNINFRA_ASR_FIXTURE_PATH")
    if not voice_pipeline_expected_text():
        missing_items.append("RUNINFRA_VOICE_PIPELINE_EXPECTED_TEXT or RUNINFRA_ASR_EXPECTED_TEXT")
    return missing_items


def _voice_pipeline_create(client: RunInfra) -> Dict[str, Any]:
    fixture = voice_pipeline_fixture()
    response = client.voice.pipeline.create(audio=fixture["content"], mime_type=fixture["content_type"])
    assert_object(response, "voice pipeline response")
    assert_request_id(response.get("_request_id"), "voice.pipeline.create")
    return {
        "requestId": response.get("_request_id"),
        **assert_voice_pipeline_expected_text(response),
    }


def _auth_error(base_url: str) -> Dict[str, Any]:
    invalid = RunInfra(api_key="sk-ri-live-canary-invalid", base_url=base_url, timeout_seconds=30, max_retries=0)
    try:
        invalid.models.list()
    except AuthenticationError as error:
        if error.status != 401 or error.type != "auth_error":
            raise AssertionError(f"invalid-key auth error mapped unexpectedly: {error.status} {error.type}")
        assert_request_id(error.request_id, "invalid-key auth error")
        return {"errorType": error.type, "errorStatus": error.status, "requestId": error.request_id}
    except PermissionDeniedError as error:
        if error.status != 403 or error.type != "permission_denied":
            raise AssertionError(f"invalid-key permission error mapped unexpectedly: {error.status} {error.type}")
        assert_request_id(error.request_id, "invalid-key permission error")
        return {"errorType": error.type, "errorStatus": error.status, "requestId": error.request_id}
    raise AssertionError("invalid API key unexpectedly succeeded")


def _model_not_found(client: RunInfra) -> Dict[str, Any]:
    try:
        client.models.retrieve(MISSING_MODEL_ID)
    except ModelNotFoundError as error:
        if error.status != 404 or error.type != "model_not_found":
            raise AssertionError(f"model-not-found error mapped unexpectedly: {error.status} {error.type}")
        assert_request_id(error.request_id, "model-not-found error")
        return {"errorType": error.type, "errorStatus": error.status, "requestId": error.request_id}
    raise AssertionError("missing model unexpectedly succeeded")


def _local_client() -> RunInfra:
    return RunInfra(api_key="sk-ri-live-canary-local", base_url="http://localhost:1/v1", max_retries=0)


def _invalid_request_options() -> Dict[str, Any]:
    try:
        _local_client().responses.create(
            model="llama",
            input="hello",
            request_options={"unsupported_option": True},
        )
    except BaseException as error:  # noqa: BLE001
        return assert_invalid_request_option_error(error, "error.request.invalid_options")
    raise AssertionError("invalid request option unexpectedly succeeded")


def _insufficient_credits_error_local() -> Dict[str, Any]:
    local = local_retry_client([
        local_retry_response(
            {"error": {"message": "local insufficient credits probe", "type": "insufficient_credits"}},
            402,
            "req-local-insufficient-credits",
        ),
    ])
    try:
        local["client"].responses.create(
            model="runinfra-local-error-model",
            input="local insufficient-credits canary",
        )
    except BaseException as error:  # noqa: BLE001
        return {
            **assert_insufficient_credits_error(error, "error.insufficient_credits.local"),
            **assert_retry_call_count(local["calls"], 1, "error.insufficient_credits.local"),
        }
    raise AssertionError("local insufficient-credits error unexpectedly succeeded")


def _rate_limit_error_local() -> Dict[str, Any]:
    local = local_retry_client([
        local_retry_response(
            {"error": {"message": "local rate limit probe", "type": "rate_limit_error"}},
            429,
            "req-local-rate-limit",
            {"Retry-After": "2"},
        ),
    ])
    try:
        local["client"].responses.create(
            model="runinfra-local-error-model",
            input="local rate-limit canary",
            request_options={"max_retries": 0},
        )
    except BaseException as error:  # noqa: BLE001
        return {
            **assert_rate_limit_error(error, "error.rate_limit.local", 2.0),
            **assert_retry_call_count(local["calls"], 1, "error.rate_limit.local"),
        }
    raise AssertionError("local rate-limit error unexpectedly succeeded")


def _unsupported_body_parameter(client: RunInfra, model: str) -> Dict[str, Any]:
    try:
        client.responses.create(
            model=model,
            input="Reply with the single word ok.",
            max_output_tokens=1,
            extra_body={"runinfra_unsupported_parameter_probe": "must_error"},
        )
    except BaseException as error:  # noqa: BLE001
        return assert_clear_unsupported_parameter_error(error, "unsupported body parameter")
    raise AssertionError("unsupported body parameter unexpectedly succeeded")


def _request_client_request_id_local() -> Dict[str, Any]:
    local = local_retry_client([
        local_retry_response(
            {"id": "resp-local-client-request-id", "status": "completed", "output": []},
            200,
            "req-local-client-request-id-server",
        ),
    ])
    response = local["client"].responses.create(
        model="runinfra-local-request-options-model",
        input="local request option canary",
        request_options={
            "client_request_id": "req-local-client-request-id",
            "max_retries": 0,
        },
    )
    assert_client_request_id_header(local["calls"], "req-local-client-request-id", "request.client_request_id.local")
    assert_request_body_does_not_contain(
        local["calls"][0],
        ["clientRequestId", "client_request_id", "req-local-client-request-id"],
        "request.client_request_id.local",
    )
    assert_request_id(response.get("_request_id"), "request.client_request_id.local")
    return {"requestId": response.get("_request_id"), "clientRequestIdHeader": "present"}


def _request_custom_headers_local() -> Dict[str, Any]:
    local = local_retry_client([
        local_retry_response(
            {"id": "resp-local-custom-headers", "status": "completed", "output": []},
            200,
            "req-local-custom-headers-server",
        ),
    ])
    response = local["client"].responses.create(
        model="runinfra-local-request-options-model",
        input="local custom header canary",
        request_options={
            "headers": {"X-RunInfra-App": "canary-app-metadata"},
            "max_retries": 0,
        },
    )
    assert_custom_header(local["calls"], "X-RunInfra-App", "canary-app-metadata", "request.custom_headers.local")
    assert_request_body_does_not_contain(
        local["calls"][0],
        ["headers", "X-RunInfra-App", "canary-app-metadata"],
        "request.custom_headers.local",
    )
    calls_before_rejected_override = len(local["calls"])
    try:
        local["client"].responses.create(
            model="runinfra-local-request-options-model",
            input="local custom header rejection canary",
            request_options={
                "headers": {"Authorization": "Bearer sk-ri-forbidden-override"},
                "max_retries": 0,
            },
        )
    except BaseException as error:  # noqa: BLE001
        evidence = assert_invalid_request_option_error(error, "request.custom_headers.local")
        if len(local["calls"]) != calls_before_rejected_override:
            raise AssertionError("request.custom_headers.local sent a request after rejecting SDK-controlled header override")
        assert_request_id(response.get("_request_id"), "request.custom_headers.local")
        return {
            **evidence,
            "requestId": response.get("_request_id"),
            "customHeader": "present",
            "rejectedOverride": "authorization",
        }
    raise AssertionError("custom Authorization header override unexpectedly succeeded")


def _request_timeout_local() -> Dict[str, Any]:
    local = local_timeout_client()
    try:
        local["client"].responses.create(
            model="runinfra-local-request-options-model",
            input="local request option canary",
            request_options={
                "timeout_seconds": 0.05,
                "max_retries": 0,
            },
        )
    except BaseException as error:  # noqa: BLE001
        if not isinstance(error, RunInfraTimeoutError) or getattr(error, "type", None) != "timeout_error":
            raise AssertionError(f"request.timeout.local expected RunInfraTimeoutError, got {error.__class__.__name__}")
        if len(local["calls"]) != 1:
            raise AssertionError(f"request.timeout.local expected 1 local call, got {len(local['calls'])}")
        call = local["calls"][0]
        if getattr(call, "timeout_seconds", None) != 0.05:
            raise AssertionError("request.timeout.local did not pass per-request timeout to transport")
        assert_request_body_does_not_contain(
            call,
            ["timeoutMs", "timeout_seconds", "timeoutSeconds"],
            "request.timeout.local",
        )
        return {
            "errorType": getattr(error, "type", None),
            "errorName": error.__class__.__name__,
            "attempts": len(local["calls"]),
            "timeoutSeconds": call.timeout_seconds,
        }
    raise AssertionError("request timeout unexpectedly succeeded")


def _request_extra_body_local() -> Dict[str, Any]:
    local = local_retry_client([
        local_retry_response(
            {"id": "resp-local-extra-body", "status": "completed", "output": []},
            200,
            "req-local-extra-body-server",
        ),
    ])
    response = local["client"].responses.create(
        model="runinfra-local-request-options-model",
        input="local extra body canary",
        extra_body={"runinfra_local_probe": "present"},
        request_options={"max_retries": 0},
    )
    assert_extra_body_json_field(
        local["calls"][0],
        "runinfra_local_probe",
        "present",
        "request.extra_body.local",
    )
    assert_request_body_does_not_contain(
        local["calls"][0],
        ["extraBody", "extra_body"],
        "request.extra_body.local",
    )
    calls_before_rejected_override = len(local["calls"])
    try:
        local["client"].responses.create(
            model="runinfra-local-request-options-model",
            input="local extra body override canary",
            extra_body={"model": "runinfra-local-invalid-override"},
            request_options={"max_retries": 0},
        )
    except BaseException as error:  # noqa: BLE001
        evidence = assert_invalid_request_option_error(error, "request.extra_body.local")
        if len(local["calls"]) != calls_before_rejected_override:
            raise AssertionError("request.extra_body.local sent a request after rejecting typed field override")
        signature = inspect.signature(local["client"].audio.transcriptions.create)
        if "extra_body" in signature.parameters:
            raise AssertionError("request.extra_body.local found multipart extra_body keyword in public signature")
        if any(parameter.kind is inspect.Parameter.VAR_KEYWORD for parameter in signature.parameters.values()):
            raise AssertionError("request.extra_body.local found multipart **kwargs in public signature")
        assert_request_id(response.get("_request_id"), "request.extra_body.local")
        return {
            **evidence,
            "requestId": response.get("_request_id"),
            "extraBodyField": "present",
            "rejectedOverride": "model",
            "multipartExtraBody": "absent",
        }
    raise AssertionError("extra_body typed field override unexpectedly succeeded")


def _request_unknown_fields_local() -> Dict[str, Any]:
    field = "runinfra_unknown_direct_probe"
    local = local_retry_client([
        local_retry_response(
            {"id": "resp-local-unknown-fields", "status": "completed", "output": []},
            200,
            "req-local-unknown-fields-extra-body",
        ),
    ])
    client = local["client"]
    calls = local["calls"]
    checks = [
        ("responses", lambda: client.responses.create(
            model="runinfra-local-request-fields-model",
            input="local unknown request field canary",
            **{field: "reject"},
        )),
        ("chat", lambda: client.chat.completions.create(
            model="runinfra-local-request-fields-model",
            messages=[{"role": "user", "content": "local unknown request field canary"}],
            **{field: "reject"},
        )),
        ("embeddings", lambda: client.embeddings.create(
            model="runinfra-local-embedding-model",
            input="local unknown request field canary",
            **{field: "reject"},
        )),
        ("images", lambda: client.images.generate(
            model="runinfra-local-image-model",
            prompt="local unknown request field canary",
            **{field: "reject"},
        )),
        ("audio.speech", lambda: client.audio.speech.create(
            model="runinfra-local-tts-model",
            input="local unknown request field canary",
            voice="local",
            **{field: "reject"},
        )),
        ("audio.transcriptions", lambda: client.audio.transcriptions.create(
            model="runinfra-local-asr-model",
            file=bytes([82, 73, 70, 70]),
            filename="local-unknown-fields.wav",
            **{field: "reject"},
        )),
        ("voice.pipeline", lambda: client.voice.pipeline.create(
            audio=bytes([1, 2, 3]),
            mime_type="audio/wav",
            **{field: "reject"},
        )),
    ]
    rejected = 0
    for label, run in checks:
        assert_unknown_request_field_rejected(run, calls, field, f"request.unknown_fields.local {label}")
        rejected += 1
    response = client.responses.create(
        model="runinfra-local-request-fields-model",
        input="local extra body still works",
        extra_body={field: "present"},
        request_options={"max_retries": 0},
    )
    assert_extra_body_json_field(calls[0], field, "present", "request.unknown_fields.local")
    assert_request_id(response.get("_request_id"), "request.unknown_fields.local")
    return {"requestId": response.get("_request_id"), "rejected": rejected, "extraBodyField": "present"}


def _browser_api_key_guard_local() -> Dict[str, Any]:
    forbidden_exports = {
        "BrowserRunInfra",
        "BrowserToken",
        "create_browser_token",
        "dangerously_allow_browser",
        "dangerouslyAllowBrowser",
    }
    exported = set(dir(runinfra_module))
    present = sorted(forbidden_exports.intersection(exported))
    if present:
        raise AssertionError(f"browser.api_key_guard.local exposed browser token surface: {', '.join(present)}")
    return {
        "browser_token_surface": "absent",
        "runtime": "python",
    }


class LocalApiKeyRedactionTransport:
    def __init__(self, secret: str) -> None:
        self.secret = secret
        self.calls: List[Any] = []

    def __call__(self, request: Any) -> RunInfraResponse:
        self.calls.append(request)
        raise OSError(f"lower transport exposed {self.secret}")


def assert_api_key_redaction() -> Dict[str, Any]:
    secret = "sk-ri-redact-local"

    def assert_redacted_public_error(error: BaseException, label: str) -> None:
        serialized = json.dumps({
            "name": error.__class__.__name__,
            "message": str(error),
            "status": getattr(error, "status", None),
            "type": getattr(error, "type", None),
            "requestId": getattr(error, "request_id", None),
        })
        if secret in serialized:
            raise AssertionError(f"{label} leaked the API key in the public error") from error
        if secret in "".join(traceback.format_exception(error)):
            raise AssertionError(f"{label} leaked the API key in traceback output") from error
        current: Optional[BaseException] = error
        seen: set[int] = set()
        while current is not None and id(current) not in seen:
            seen.add(id(current))
            if secret in str(current) or secret in repr(current):
                raise AssertionError(f"{label} leaked the API key in the exception chain") from error
            current = current.__cause__ or current.__context__

    def assert_redacted_connection_error(error: RunInfraConnectionError, label: str) -> None:
        assert_redacted_public_error(error, label)

    def assert_credential_placement(calls: List[Any], label: str) -> None:
        if len(calls) != 1:
            raise AssertionError(f"{label} expected one local request, got {len(calls)}")
        request = calls[0]
        if secret in str(getattr(request, "url", "")):
            raise AssertionError(f"{label} leaked the API key in the request URL")
        if getattr(request, "headers", {}).get("Authorization") != f"Bearer {secret}":
            raise AssertionError(f"{label} did not send the API key only as a bearer header")

    transport = LocalApiKeyRedactionTransport(secret)
    local = RunInfra(
        api_key=secret,
        base_url="http://localhost:1/v1",
        max_retries=0,
        retry_base_seconds=0,
        timeout_seconds=1,
        transport=transport,
    )
    try:
        local.models.list(request_options={"max_retries": 0})
    except RunInfraConnectionError as error:
        assert_redacted_connection_error(error, "security.api_key_redaction.local transport")
        assert_credential_placement(transport.calls, "security.api_key_redaction.local transport")
    except BaseException as error:
        raise AssertionError(
            f"security.api_key_redaction.local expected RunInfraConnectionError, got {error.__class__.__name__}"
        ) from error
    else:
        raise AssertionError("security.api_key_redaction.local transport unexpectedly succeeded")

    class LocalApiKeyRedactionSdkErrorTransport:
        def __init__(self, secret_value: str) -> None:
            self.secret = secret_value
            self.calls: List[Any] = []

        def __call__(self, request: Any) -> RunInfraResponse:
            self.calls.append(request)
            try:
                raise OSError(f"sdk cause exposed {self.secret}")
            except OSError as exc:
                raise RunInfraConnectionError(
                    "safe public message",
                    status=0,
                    error_type="connection_error",
                    request_id="req-local-api-key-sdk-cause-redaction",
                ) from exc

    sdk_error_transport = LocalApiKeyRedactionSdkErrorTransport(secret)
    sdk_error_client = RunInfra(
        api_key=secret,
        base_url="http://localhost:1/v1",
        max_retries=0,
        retry_base_seconds=0,
        timeout_seconds=1,
        transport=sdk_error_transport,
    )
    try:
        sdk_error_client.models.list(request_options={"max_retries": 0})
    except RunInfraConnectionError as error:
        assert_redacted_connection_error(error, "security.api_key_redaction.local sdk_error")
        assert_credential_placement(sdk_error_transport.calls, "security.api_key_redaction.local sdk_error")
    except BaseException as error:
        raise AssertionError(
            f"security.api_key_redaction.local sdk_error expected RunInfraConnectionError, got {error.__class__.__name__}"
        ) from error
    else:
        raise AssertionError("security.api_key_redaction.local sdk_error unexpectedly succeeded")

    class FailingBodyResponse:
        status = 200
        headers = {"content-type": "application/json", "x-request-id": "req-local-api-key-body-redaction"}

        def __enter__(self) -> "FailingBodyResponse":
            return self

        def __exit__(self, *_args: Any) -> bool:
            return False

        def read(self) -> bytes:
            raise OSError(f"body reader exposed {secret}")

    body_calls: List[Any] = []
    original_urlopen = runinfra_module.urllib.request.urlopen

    def fake_urlopen(request: Any, timeout: Optional[float] = None) -> FailingBodyResponse:
        del timeout
        body_calls.append(request)
        return FailingBodyResponse()

    runinfra_module.urllib.request.urlopen = fake_urlopen
    try:
        body_client = RunInfra(
            api_key=secret,
            base_url="http://localhost:1/v1",
            max_retries=0,
            retry_base_seconds=0,
            timeout_seconds=1,
            transport=runinfra_module._default_transport(1),
        )
        try:
            body_client.models.list(request_options={"max_retries": 0})
        except RunInfraConnectionError as error:
            assert_redacted_connection_error(error, "security.api_key_redaction.local body")
        except BaseException as error:
            raise AssertionError(
                f"security.api_key_redaction.local body expected RunInfraConnectionError, got {error.__class__.__name__}"
            ) from error
        else:
            raise AssertionError("security.api_key_redaction.local body unexpectedly succeeded")
    finally:
        runinfra_module.urllib.request.urlopen = original_urlopen
    if len(body_calls) != 1:
        raise AssertionError(f"security.api_key_redaction.local body expected one local request, got {len(body_calls)}")
    if secret in getattr(body_calls[0], "full_url", ""):
        raise AssertionError("security.api_key_redaction.local body leaked the API key in the request URL")
    if body_calls[0].headers.get("Authorization") != f"Bearer {secret}":
        raise AssertionError("security.api_key_redaction.local body did not send the API key only as a bearer header")

    class LocalApiKeyRedactionJsonBodyTransport:
        def __init__(self, secret_value: str) -> None:
            self.secret = secret_value
            self.calls: List[Any] = []

        def chunks(self) -> Iterable[bytes]:
            raise OSError(f"custom body reader exposed {self.secret}")
            yield b""  # pragma: no cover

        def __call__(self, request: Any) -> RunInfraResponse:
            self.calls.append(request)
            return RunInfraResponse(
                200,
                {"content-type": "application/json", "x-request-id": "req-local-api-key-custom-body-redaction"},
                self.chunks(),
            )

    custom_body_transport = LocalApiKeyRedactionJsonBodyTransport(secret)
    custom_body_client = RunInfra(
        api_key=secret,
        base_url="http://localhost:1/v1",
        max_retries=0,
        retry_base_seconds=0,
        timeout_seconds=1,
        transport=custom_body_transport,
    )
    try:
        custom_body_client.models.list(request_options={"max_retries": 0})
    except RunInfraConnectionError as error:
        assert_redacted_connection_error(error, "security.api_key_redaction.local custom_body")
        assert_credential_placement(custom_body_transport.calls, "security.api_key_redaction.local custom_body")
    except BaseException as error:
        raise AssertionError(
            f"security.api_key_redaction.local custom_body expected RunInfraConnectionError, got {error.__class__.__name__}"
        ) from error
    else:
        raise AssertionError("security.api_key_redaction.local custom_body unexpectedly succeeded")

    status_transport = LocalRetryTransport([
        RunInfraResponse(
            401,
            {"content-type": "application/json", "x-request-id": "req-local-api-key-status-redaction"},
            json.dumps({"error": {"message": f"status body exposed {secret}", "type": "auth_error"}}).encode("utf-8"),
        )
    ])
    status_client = RunInfra(
        api_key=secret,
        base_url="http://localhost:1/v1",
        max_retries=0,
        retry_base_seconds=0,
        timeout_seconds=1,
        transport=status_transport,
    )
    try:
        status_client.models.list(request_options={"max_retries": 0})
    except AuthenticationError as error:
        assert_redacted_public_error(error, "security.api_key_redaction.local status")
        assert_credential_placement(status_transport.calls, "security.api_key_redaction.local status")
    except BaseException as error:
        raise AssertionError(
            f"security.api_key_redaction.local status expected AuthenticationError, got {error.__class__.__name__}"
        ) from error
    else:
        raise AssertionError("security.api_key_redaction.local status unexpectedly succeeded")

    class LocalApiKeyRedactionStreamTransport:
        def __init__(self, secret_value: str) -> None:
            self.secret = secret_value
            self.calls: List[Any] = []

        def chunks(self) -> Iterable[bytes]:
            raise OSError(f"stream reader exposed {self.secret}")
            yield b""  # pragma: no cover

        def __call__(self, request: Any) -> RunInfraResponse:
            self.calls.append(request)
            return RunInfraResponse(
                200,
                {"content-type": "text/event-stream", "x-request-id": "req-local-api-key-stream-redaction"},
                self.chunks(),
            )

    stream_transport = LocalApiKeyRedactionStreamTransport(secret)
    stream_client = RunInfra(
        api_key=secret,
        base_url="http://localhost:1/v1",
        max_retries=0,
        retry_base_seconds=0,
        timeout_seconds=1,
        transport=stream_transport,
    )
    stream = stream_client.chat.completions.create(
        model="runinfra-local-redaction-model",
        messages=[{"role": "user", "content": "local api key redaction canary"}],
        stream=True,
        request_options={"max_retries": 0},
    )
    try:
        next(iter(stream))
    except RunInfraConnectionError as error:
        assert_redacted_connection_error(error, "security.api_key_redaction.local stream")
        assert_credential_placement(stream_transport.calls, "security.api_key_redaction.local stream")
        return {
            "errorType": "connection_error",
            "errorStatus": 0,
            "authorization": "bearer",
            "urlRedacted": "present",
            "transportErrorRedacted": "present",
            "sdkErrorCauseRedacted": "present",
            "bodyReadErrorRedacted": "present",
            "customBodyReadErrorRedacted": "present",
            "statusErrorRedacted": "present",
            "streamReadErrorRedacted": "present",
        }
    except BaseException as error:
        raise AssertionError(
            f"security.api_key_redaction.local stream expected RunInfraConnectionError, got {error.__class__.__name__}"
        ) from error
    raise AssertionError("security.api_key_redaction.local stream unexpectedly succeeded")


def _retry_safety_get_local() -> Dict[str, Any]:
    local = local_retry_client([
        local_retry_failure("req-local-retry-get-first"),
        local_retry_response({"object": "list", "data": []}, 200, "req-local-retry-get-second"),
    ])
    response = local["client"].models.list(request_options={"max_retries": 1, "retry_base_seconds": 0})
    assert_request_id(response.get("_request_id"), "retry.safety.get.local")
    return {
        **assert_retry_call_count(local["calls"], 2, "retry.safety.get.local"),
        "requestId": response.get("_request_id"),
    }


def _retry_safety_post_requires_idempotency_local() -> Dict[str, Any]:
    local = local_retry_client([local_retry_failure("req-local-retry-post-no-idempotency")])
    try:
        local["client"].responses.create(
            model="runinfra-local-retry-model",
            input="local retry canary",
            request_options={"max_retries": 1, "retry_base_seconds": 0},
        )
    except BaseException as error:  # noqa: BLE001
        return {
            **assert_retry_call_count(local["calls"], 1, "retry.safety.post.requires_idempotency.local"),
            **assert_retryable_error(error, "retry.safety.post.requires_idempotency.local"),
        }
    raise AssertionError("non-idempotent POST unexpectedly retried into success")


def _retry_safety_post_with_idempotency_local() -> Dict[str, Any]:
    local = local_retry_client([
        local_retry_failure("req-local-retry-post-idempotency-first"),
        local_retry_response(
            {"id": "resp-local-retry", "status": "completed", "output": []},
            200,
            "req-local-retry-post-idempotency-second",
        ),
    ])
    response = local["client"].responses.create(
        model="runinfra-local-retry-model",
        input="local retry canary",
        request_options={
            "idempotency_key": "idem-local-json-retry",
            "max_retries": 1,
            "retry_base_seconds": 0,
        },
    )
    assert_idempotency_header(local["calls"], "idem-local-json-retry", "retry.safety.post.with_idempotency.local")
    assert_request_id(response.get("_request_id"), "retry.safety.post.with_idempotency.local")
    return {
        **assert_retry_call_count(local["calls"], 2, "retry.safety.post.with_idempotency.local"),
        "requestId": response.get("_request_id"),
        "idempotencyHeader": "present",
    }


def _retry_safety_post_non_replayable_json_no_retry_local() -> Dict[str, Any]:
    checks = (
        (
            "embeddings",
            "idem-local-embeddings-json-no-retry",
            [
                local_retry_failure("req-local-retry-embeddings-json-no-retry"),
                local_retry_response({"object": "list", "data": []}, 200, "req-local-retry-embeddings-json-unexpected"),
            ],
            lambda client, request_options: client.embeddings.create(
                model="runinfra-local-embedding-model",
                input="local retry canary",
                request_options=request_options,
            ),
        ),
        (
            "images",
            "idem-local-images-json-no-retry",
            [
                local_retry_failure("req-local-retry-images-json-no-retry"),
                local_retry_response({"created": 1, "data": []}, 200, "req-local-retry-images-json-unexpected"),
            ],
            lambda client, request_options: client.images.generate(
                model="runinfra-local-image-model",
                prompt="local retry canary",
                request_options=request_options,
            ),
        ),
    )
    for surface, idempotency_key, responses, run in checks:
        row_label = f"retry.safety.post.non_replayable_json.no_retry.local {surface}"
        local = local_retry_client(responses)
        try:
            run(
                local["client"],
                {
                    "idempotency_key": idempotency_key,
                    "max_retries": 1,
                    "retry_base_seconds": 0,
                },
            )
        except BaseException as error:  # noqa: BLE001
            assert_idempotency_header(local["calls"], idempotency_key, row_label)
            assert_retryable_error(error, row_label)
            assert_retry_call_count(local["calls"], 1, row_label)
            continue
        raise AssertionError(f"{surface} JSON POST unexpectedly retried into success")
    return {"attemptsPerSurface": 1, "surfaces": "embeddings,images"}


def _retry_safety_stream_no_retry_local() -> Dict[str, Any]:
    local = local_retry_client([local_retry_failure("req-local-retry-stream-no-retry")])
    try:
        local["client"].chat.completions.create(
            model="runinfra-local-retry-model",
            messages=[{"role": "user", "content": "local retry canary"}],
            stream=True,
            request_options={
                "idempotency_key": "idem-local-stream-no-retry",
                "max_retries": 1,
                "retry_base_seconds": 0,
            },
        )
    except BaseException as error:  # noqa: BLE001
        assert_idempotency_header(local["calls"], "idem-local-stream-no-retry", "retry.safety.stream.no_retry.local")
        return {
            **assert_retry_call_count(local["calls"], 1, "retry.safety.stream.no_retry.local"),
            **assert_retryable_error(error, "retry.safety.stream.no_retry.local"),
        }
    raise AssertionError("streaming POST unexpectedly retried into success")


def _retry_safety_audio_binary_no_retry_local() -> Dict[str, Any]:
    local = local_retry_client([local_retry_failure("req-local-retry-audio-binary-no-retry")])
    try:
        local["client"].audio.speech.create(
            model="runinfra-local-retry-model",
            input="local retry canary",
            voice="alloy",
            request_options={
                "idempotency_key": "idem-local-audio-binary-no-retry",
                "max_retries": 1,
                "retry_base_seconds": 0,
            },
        )
    except BaseException as error:  # noqa: BLE001
        assert_idempotency_header(
            local["calls"],
            "idem-local-audio-binary-no-retry",
            "retry.safety.audio_binary.no_retry.local",
        )
        return {
            **assert_retry_call_count(local["calls"], 1, "retry.safety.audio_binary.no_retry.local"),
            **assert_retryable_error(error, "retry.safety.audio_binary.no_retry.local"),
        }
    raise AssertionError("binary audio POST unexpectedly retried into success")


def _retry_safety_audio_multipart_no_retry_local() -> Dict[str, Any]:
    local = local_retry_client([local_retry_failure("req-local-retry-audio-multipart-no-retry")])
    try:
        local["client"].audio.transcriptions.create(
            model="runinfra-local-retry-model",
            file=b"RIFF",
            filename="local-retry.wav",
            request_options={
                "idempotency_key": "idem-local-audio-multipart-no-retry",
                "max_retries": 1,
                "retry_base_seconds": 0,
            },
        )
    except BaseException as error:  # noqa: BLE001
        assert_idempotency_header(
            local["calls"],
            "idem-local-audio-multipart-no-retry",
            "retry.safety.audio_multipart.no_retry.local",
        )
        return {
            **assert_retry_call_count(local["calls"], 1, "retry.safety.audio_multipart.no_retry.local"),
            **assert_retryable_error(error, "retry.safety.audio_multipart.no_retry.local"),
        }
    raise AssertionError("multipart audio POST unexpectedly retried into success")


def _retry_safety_voice_binary_no_retry_local() -> Dict[str, Any]:
    local = local_retry_client(
        [
            local_retry_failure("req-local-retry-voice-binary-no-retry"),
            local_retry_response({"text": "unexpected retry success"}, 200, "req-local-retry-voice-binary-unexpected"),
        ],
        pipeline_id="pipe-local-retry-voice",
    )
    try:
        local["client"].voice.pipeline.create(
            audio=b"\x01\x02\x03",
            mime_type="audio/wav",
            request_options={
                "idempotency_key": "idem-local-voice-binary-no-retry",
                "max_retries": 1,
                "retry_base_seconds": 0,
            },
        )
    except BaseException as error:  # noqa: BLE001
        assert_idempotency_header(local["calls"], "idem-local-voice-binary-no-retry", "retry.safety.voice_binary.no_retry.local")
        return {
            **assert_retry_call_count(local["calls"], 1, "retry.safety.voice_binary.no_retry.local"),
            **assert_retryable_error(error, "retry.safety.voice_binary.no_retry.local"),
        }
    raise AssertionError("voice pipeline POST unexpectedly retried into success")


def _webhooks_delivery_surface_absent() -> Dict[str, str]:
    webhooks = _local_client().webhooks
    if hasattr(webhooks, "create") or hasattr(webhooks, "list"):
        raise AssertionError("unshipped webhook delivery methods are present")
    if not callable(webhooks.verify_signature) or not callable(webhooks.construct_event):
        raise AssertionError("webhook verification helpers are missing")
    return {"deliveryMethods": "absent", "verificationHelpers": "present"}


def _webhook_fixture() -> Dict[str, Any]:
    timestamp = int(time.time())
    payload = json.dumps({"type": "sdk.canary", "data": {"ok": True}}, separators=(",", ":"))
    secret = "whsec_sdk_canary_local"
    signature = hmac.new(
        secret.encode("utf-8"),
        f"{timestamp}.{payload}".encode("utf-8"),
        hashlib.sha256,
    ).hexdigest()
    return {
        "payload": payload,
        "secret": secret,
        "timestamp": timestamp,
        "signature_header": f"t={timestamp},v1={signature}",
    }


def _webhooks_verify_signature_local() -> Dict[str, Any]:
    fixture = _webhook_fixture()
    verified = _local_client().webhooks.verify_signature(
        payload=fixture["payload"],
        signature_header=fixture["signature_header"],
        secret=fixture["secret"],
        now=fixture["timestamp"],
    )
    if verified is not True:
        raise AssertionError("webhook signature verification did not return True")
    return {"verified": verified}


def _webhooks_construct_event_local() -> Dict[str, Any]:
    fixture = _webhook_fixture()
    event = _local_client().webhooks.construct_event(
        payload=fixture["payload"],
        signature_header=fixture["signature_header"],
        secret=fixture["secret"],
        now=fixture["timestamp"],
    )
    assert_object(event, "webhook event")
    assert_string(event.get("type"), "webhook event.type")
    return {"eventType": event.get("type")}


def _webhooks_verify_signature_export() -> Dict[str, Any]:
    fixture = _webhook_fixture()
    verified = verify_webhook_signature(
        payload=fixture["payload"],
        signature_header=fixture["signature_header"],
        secret=fixture["secret"],
        now=fixture["timestamp"],
    )
    if verified is not True:
        raise AssertionError("exported webhook signature verification did not return True")
    return {"verified": verified}


def _webhooks_construct_event_export() -> Dict[str, Any]:
    fixture = _webhook_fixture()
    event = construct_webhook_event(
        payload=fixture["payload"],
        signature_header=fixture["signature_header"],
        secret=fixture["secret"],
        now=fixture["timestamp"],
    )
    assert_object(event, "exported webhook event")
    assert_string(event.get("type"), "exported webhook event.type")
    return {"eventType": event.get("type")}


def _idempotency_requirements() -> List[str]:
    missing_items = [name for name in ("RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL") if not env(name)]
    if env("RUNINFRA_CANARY_ENABLE_IDEMPOTENCY") != "1":
        missing_items.append("RUNINFRA_CANARY_ENABLE_IDEMPOTENCY=1")
    return missing_items


def _idempotency_replay(client: RunInfra, model: str) -> Dict[str, Any]:
    key = f"sdk-canary-py-{int(time.time() * 1000)}-{random.randint(0, 999999):06d}"
    request = {
        "model": model,
        "input": "Reply with the single word ok.",
        "max_output_tokens": 16,
    }
    first = client.responses.create(**request, request_options={"idempotency_key": key, "max_retries": 0})
    second = client.responses.create(**request, request_options={"idempotency_key": key, "max_retries": 0})
    assert_request_id(first.get("_request_id"), "idempotency first response")
    assert_request_id(second.get("_request_id"), "idempotency second response")
    return {
        "firstRequestId": first.get("_request_id"),
        "secondRequestId": second.get("_request_id"),
        **assert_idempotency_replay_evidence(second),
    }


if __name__ == "__main__":
    raise SystemExit(main())

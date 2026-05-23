#!/usr/bin/env python
from __future__ import annotations

import argparse
import hashlib
import hmac
import json
import math
import os
import random
import re
import sys
import time
from pathlib import Path
from typing import Any, Callable, Dict, Iterable, List, Optional, Union

REPO_ROOT = Path(__file__).resolve().parents[1]
if os.environ.get("RUNINFRA_CANARY_PYTHON_IMPORT_MODE") != "installed":
    sys.path.insert(0, str(REPO_ROOT / "python"))

from runinfra import (  # noqa: E402
    __version__,
    AuthenticationError,
    ModelNotFoundError,
    PermissionDeniedError,
    RunInfra,
    construct_webhook_event,
    verify_webhook_signature,
)

TTS_RESPONSE_FORMATS = {"mp3", "opus", "aac", "flac", "wav", "pcm"}
MISSING_MODEL_ID = "runinfra-sdk-canary-missing-model"


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
        "status": getattr(error, "status", None),
        "requestId": getattr(error, "request_id", None),
        "message": "redacted",
    }


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
    return "custom_set_redacted" if env("RUNINFRA_BASE_URL") else value


def get_path_value(value: Any, path: str) -> Any:
    current = value
    for segment in path.split("."):
        if not isinstance(current, dict):
            return None
        current = current.get(segment)
    return current


def assert_idempotency_replay_evidence(response: Dict[str, Any]) -> Dict[str, str]:
    fields = [
        field.strip()
        for field in (
            env("RUNINFRA_CANARY_IDEMPOTENCY_EVIDENCE_FIELD")
            or "idempotency_replayed,_idempotency_replayed,idempotency.replayed,replay.replayed"
        ).split(",")
        if field.strip()
    ]
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
        "TEST_PIPELINE_ID",
        "RUNINFRA_VOICE_PIPELINE_ID",
        "RUNINFRA_VOICE_PIPELINE_API_KEY",
        "RUNINFRA_VOICE_PIPELINE_AUDIO_PATH",
        "RUNINFRA_VOICE_PIPELINE_AUDIO_CONTENT_TYPE",
        "RUNINFRA_VOICE_PIPELINE_EXPECTED_TEXT",
        "RUNINFRA_CANARY_ENABLE_IDEMPOTENCY",
        "RUNINFRA_CANARY_IDEMPOTENCY_EVIDENCE_FIELD",
    ]
    api_key = env("RUNINFRA_API_KEY")
    base_url = env("RUNINFRA_BASE_URL") or "https://api.runinfra.ai/v1"
    llm_model = env("RUNINFRA_LLM_MODEL")
    embedding_model = env("RUNINFRA_EMBEDDING_MODEL")
    image_model = env("RUNINFRA_IMAGE_MODEL")
    tts_model = env("RUNINFRA_TTS_MODEL")
    asr_model = env("RUNINFRA_ASR_MODEL")
    pipeline_id = first_env("RUNINFRA_VOICE_PIPELINE_ID", "TEST_PIPELINE_ID")
    pipeline_api_key = first_env("RUNINFRA_VOICE_PIPELINE_API_KEY", "RUNINFRA_PIPELINE_API_KEY", "RUNINFRA_API_KEY")
    timeout_seconds = float(env("RUNINFRA_CANARY_TIMEOUT_SECONDS") or "120")

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
    record("models.retrieve.llm", ["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"], lambda: _model_retrieve(client(), llm_model))
    record("chat.completions.create", ["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"], lambda: _chat_create(client(), llm_model))
    record("openai.params.chat.completions", ["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"], lambda: _chat_params(client(), llm_model))
    record("chat.completions.stream.final", ["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"], lambda: _chat_stream_final(client(), llm_model))
    record("chat.completions.stream.cancel", ["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"], lambda: _chat_stream_cancel(client(), llm_model))
    record("responses.create", ["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"], lambda: _responses_create(client(), llm_model))
    record("openai.params.responses", ["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"], lambda: _responses_params(client(), llm_model))
    record("responses.stream.final", ["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"], lambda: _responses_stream_final(client(), llm_model))
    record("responses.stream.cancel", ["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"], lambda: _responses_stream_cancel(client(), llm_model))
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
    record("error.body.unsupported_parameter", ["RUNINFRA_API_KEY", "RUNINFRA_LLM_MODEL"], lambda: _unsupported_body_parameter(client(), llm_model))
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
    assert_request_id(response.get("_request_id"), "models.list")
    return {"requestId": response.get("_request_id"), "itemCount": len(response["data"])}


def _model_retrieve(client: RunInfra, model: str) -> Dict[str, Any]:
    response = client.models.retrieve(model)
    assert_object(response, "models.retrieve response")
    if not isinstance(response.get("id"), str):
        raise AssertionError("models.retrieve response missing id")
    assert_request_id(response.get("_request_id"), "models.retrieve")
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
        assert_chat_stream_envelope(event, f"chat stream event {index}")
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
        max_output_tokens=16,
        metadata={"sdk_canary": "openai_params_responses"},
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
        if getattr(error, "status", None) != 0 or getattr(error, "type", None) != "invalid_request_options":
            raise AssertionError(
                f"invalid request option mapped unexpectedly: {getattr(error, 'status', None)} {getattr(error, 'type', None)}"
            )
        return {"errorType": getattr(error, "type", None), "errorStatus": getattr(error, "status", None)}
    raise AssertionError("invalid request option unexpectedly succeeded")


def _unsupported_body_parameter(client: RunInfra, model: str) -> Dict[str, Any]:
    try:
        client.responses.create(
            model=model,
            input="Reply with the single word ok.",
            max_output_tokens=1,
            runinfra_unsupported_parameter_probe="must_error",
        )
    except BaseException as error:  # noqa: BLE001
        return assert_clear_unsupported_parameter_error(error, "unsupported body parameter")
    raise AssertionError("unsupported body parameter unexpectedly succeeded")


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

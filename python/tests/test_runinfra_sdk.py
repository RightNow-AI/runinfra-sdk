import base64
import hashlib
import hmac
import io
import inspect
import importlib.util
import json
import math
import os
import re
import stat
import tarfile
import tempfile
import time
import traceback
import unittest
import warnings
import zipfile
from collections import UserDict
from email.message import Message
from email.utils import formatdate
from pathlib import Path
from typing import Any, Dict, List, Literal, Mapping, Optional, Sequence, Union, get_type_hints
from unittest.mock import patch

try:
    from typing import get_overloads
except ImportError:  # Python 3.9 and 3.10
    from typing_extensions import get_overloads

import runinfra
from runinfra import (
    __version__,
    AuthenticationError,
    ChatCompletionChoice,
    ChatCompletionMessageToolCall,
    ChatCompletionResponse,
    ChatCompletionStreamChoice,
    ChatCompletionStreamDelta,
    ChatCompletionStreamEvent,
    ChatCompletionStreamToolCallDelta,
    ChatCompletionStreamToolCallFunction,
    ChatCompletionToolCallFunction,
    ChatMessage,
    ChatToolMessage,
    DeploymentError,
    EmbeddingResponse,
    ImageGenerationResponse,
    InsufficientCreditsError,
    ModelListResponse,
    ModelObject,
    ModelNotFoundError,
    PermissionDeniedError,
    RateLimitError,
    RunInfra,
    RunInfraError,
    RunInfraConnectionError,
    RunInfraResponse,
    ResponsesCreateResponse,
    RunInfraStream,
    RunInfraStreamError,
    RunInfraStreamIncompleteError,
    RunInfraStreamParseError,
    RunInfraTimeoutError,
    TranscriptionResponse,
    WebhookVerificationError,
    construct_webhook_event,
    verify_batch_delivery,
)


class RecordingTransport:
    def __init__(self, *responses):
        self.responses = list(responses)
        self.calls = []

    def __call__(self, request):
        self.calls.append(request)
        if not self.responses:
            return RunInfraResponse(200, {"content-type": "application/json"}, b"{}")
        return self.responses.pop(0)


def json_response(payload, status=200, headers=None):
    return RunInfraResponse(
        status,
        {"content-type": "application/json", **(headers or {})},
        json.dumps(payload).encode("utf-8"),
    )


class RunInfraPythonSdkTest(unittest.TestCase):
    def assertSecretNotInExceptionChain(self, error, secret):
        self.assertNotIn(secret, str(error))
        self.assertNotIn(secret, "".join(traceback.format_exception(type(error), error, error.__traceback__)))
        current = error
        seen = set()
        while current is not None and id(current) not in seen:
            seen.add(id(current))
            self.assertNotIn(secret, str(current))
            self.assertNotIn(secret, repr(current))
            current = current.__cause__ or current.__context__

    def test_readme_documents_explicit_environment_guards(self):
        readme = Path(__file__).resolve().parents[1].joinpath("README.md").read_text()

        self.assertIn('api_key = os.environ.get("RUNINFRA_API_KEY")', readme)
        self.assertIn("Set RUNINFRA_API_KEY", readme)
        self.assertNotIn('os.environ["RUNINFRA_API_KEY"]', readme)
        self.assertIn('webhook_secret = os.environ.get("RUNINFRA_WEBHOOK_SECRET")', readme)
        self.assertIn("Set RUNINFRA_WEBHOOK_SECRET", readme)
        self.assertNotIn('os.environ["RUNINFRA_WEBHOOK_SECRET"]', readme)

    def test_readme_documents_workspace_keys_as_verified_active_only(self):
        readme = Path(__file__).resolve().parents[1].joinpath("README.md").read_text()

        self.assertIn("reach verified active deployments through the `model` field", readme)
        self.assertNotIn("reach any active deployment", readme)
        self.assertNotIn("reach every active deployment", readme)

    def test_readme_documents_sync_only_async_runtime_patterns(self):
        readme = Path(__file__).resolve().parents[1].joinpath("README.md").read_text()

        self.assertIn("`RunInfra` is intentionally sync-only", readme)
        self.assertIn("asyncio.to_thread", readme)
        self.assertIn("from fastapi import BackgroundTasks, FastAPI", readme)
        self.assertIn("background_tasks.add_task", readme)
        self.assertFalse(hasattr(runinfra, "AsyncRunInfra"))
        self.assertNotIn("AsyncRunInfra = RunInfra", readme)

    def test_readme_documents_voice_pipeline_as_preview_instead_of_unsupported(self):
        readme = Path(__file__).resolve().parents[1].joinpath("README.md").read_text()
        changelog = Path(__file__).resolve().parents[1].joinpath("CHANGELOG.md").read_text()
        source = Path(__file__).resolve().parents[1].joinpath("runinfra", "__init__.py").read_text()

        self.assertIn(
            "| Voice pipeline | `client.voice.pipeline.create` | Preview. Pipeline-scoped helper for co-located audio-to-response deployments. |",
            readme,
        )
        self.assertNotIn("Voice pipeline | `client.voice.pipeline.create` | Not shipped", readme)
        self.assertNotIn("client.voice.pipeline.create` is not shipped", changelog)
        self.assertIn("co-located voice pipelines", changelog)
        voice_start = source.index("class _Voice:")
        runinfra_start = source.index("class RunInfra:", voice_start)
        voice_block = source[voice_start:runinfra_start]
        self.assertIn("Preview helper for co-located voice pipelines", voice_block)
        self.assertNotIn("NOT been verified end-to-end", voice_block)
        self.assertNotIn("Live-canary verification is tracked", voice_block)

    def test_pyproject_uses_non_deprecated_license_metadata(self):
        pyproject = Path(__file__).resolve().parents[1].joinpath("pyproject.toml").read_text()

        self.assertIn('license = "LicenseRef-Proprietary"', pyproject)
        self.assertIn('license-files = ["LICENSE"]', pyproject)
        self.assertIn("optimized inference deployments across text, embeddings, image, and audio routes", pyproject)
        self.assertNotIn("LLM + embeddings tested", pyproject)
        self.assertNotIn("contract-tested", pyproject)
        self.assertNotIn("experimental", pyproject)
        self.assertNotIn('license = { file = "LICENSE" }', pyproject)

    def test_public_sdk_docs_are_customer_facing_instead_of_release_process_facing(self):
        package_readme = Path(__file__).resolve().parents[1].joinpath("README.md").read_text()
        root_readme = Path(__file__).resolve().parents[2].joinpath("README.md").read_text()
        changelog = Path(__file__).resolve().parents[1].joinpath("CHANGELOG.md").read_text()

        self.assertIn(
            "| Embeddings | `client.embeddings.create` | Beta. Typed helper for verified embedding deployments. |",
            package_readme,
        )
        self.assertIn(
            "| Embeddings | Beta. Typed helper for verified embedding deployments. |",
            root_readme,
        )
        self.assertIn(
            "| Chat completions, Responses | Beta. Typed helpers for verified LLM and vision-language deployments. |",
            root_readme,
        )
        self.assertIn("Added typed helpers for chat completions, Responses, embeddings", changelog)
        for text in (package_readme, root_readme, changelog):
            self.assertNotIn("LLM + embeddings tested", text)
            self.assertNotIn("Live-canary coverage is currently restricted to LLM + embeddings", text)
            self.assertNotIn("Not strict live-canary verified", text)
            self.assertNotIn("Current 0.1.4 promotion artifacts", text)
            self.assertNotIn("strict-live green", text)
            self.assertNotIn("zero skipped or failed rows", text)
            self.assertNotIn("For production promotion", text)
            self.assertNotIn("runinfra-sdk-promoted-artifacts", text)
            self.assertNotIn("streaming final/slow-consumer rows pass against production", text)
        for phrase in (
            "source maps",
            "debug source markers",
            "local private paths",
            "registry config files",
            "package token material",
            "publish dispatch",
            "dry-run",
            "workflow actions",
            "immutable commits",
            "wheel/sdist",
            "wheel and sdist",
            "version-sync",
            "workflow-policy",
            "CI and publish",
            "accidental credentials",
            "build metadata",
            "backtracking risk",
            "Development Status",
        ):
            self.assertNotIn(phrase, changelog)

    def test_readme_documents_safe_base_url_requirements(self):
        readme = Path(__file__).resolve().parents[1].joinpath("README.md").read_text()

        self.assertIn("Custom base URLs must use `http` or `https`.", readme)
        self.assertIn("Remote custom base URLs must use `https`.", readme)
        self.assertIn("local development hosts: `localhost`, `127.0.0.1`, `0.0.0.0`, and `[::1]`", readme)
        self.assertIn("Custom base URLs must not include usernames or passwords.", readme)
        self.assertIn("Custom base URLs must not include query strings or fragments.", readme)

    def test_readme_documents_full_webhook_verification_helper_surface(self):
        readme = Path(__file__).resolve().parents[1].joinpath("README.md").read_text()
        changelog = Path(__file__).resolve().parents[1].joinpath("CHANGELOG.md").read_text()

        self.assertIn("construct_webhook_event", readme)
        self.assertIn("verify_webhook_signature", readme)
        self.assertIn("WebhookVerificationError", readme)
        self.assertIn("Webhook delivery management is outside the public SDK surface", readme)
        self.assertNotIn("client.webhooks.create", readme)
        self.assertNotIn("client.webhooks.list", readme)
        self.assertIn("`UnsupportedOperationError` remains exported for compatibility", readme)
        self.assertIn("## [0.1.5]", changelog)
        self.assertIn("local signature", changelog)
        self.assertIn("webhook", changelog)
        self.assertIn("verification", changelog)

    def test_readme_documents_non_blank_idempotency_key_requirements(self):
        readme = Path(__file__).resolve().parents[1].joinpath("README.md").read_text()

        self.assertIn("Idempotency keys must be non-blank", readme)
        self.assertIn("255 characters or less", readme)
        self.assertIn("must not contain secrets or personal data", readme)
        self.assertIn("explicit OpenAI-style keyword parameters instead of arbitrary `**kwargs`", readme)
        self.assertIn("pass an `extra_body` mapping", readme)
        self.assertIn("`extra_body` cannot override typed request fields", readme)

    def test_readme_documents_exact_replay_safe_non_streaming_json_operations(self):
        readme = Path(__file__).resolve().parents[1].joinpath("README.md").read_text()

        self.assertIn("responses.create()", readme)
        self.assertIn("non-streaming `chat.completions.create()`", readme)
        self.assertIn("Only `responses.create()` and non-streaming `chat.completions.create()`", readme)
        self.assertNotIn("That covers `responses.create()`, non-streaming `chat.completions.create()`, `embeddings.create()`, and `images.generate()`", readme)
        self.assertIn("Embeddings, images, streaming calls, binary TTS responses, and multipart ASR uploads are sent once", readme)
        self.assertIn("even when you provide an idempotency key", readme)
        self.assertNotIn("The gateway still binds idempotency keys for TTS and ASR", readme)

    def test_readme_documents_tts_voice_and_reference_audio_request_modes(self):
        readme = Path(__file__).resolve().parents[1].joinpath("README.md").read_text()

        self.assertIn("Text to speech", readme)
        self.assertIn("RUNINFRA_TTS_VOICE", readme)
        self.assertIn("RUNINFRA_TTS_REF_AUDIO", readme)
        self.assertIn("RUNINFRA_TTS_REF_TEXT", readme)
        self.assertIn("ref_audio", readme)
        self.assertIn("ref_text", readme)
        self.assertIn("task_type", readme)
        self.assertNotIn('voice=process.env.RUNINFRA_TTS_VOICE ?? "default"', readme)

    def test_readme_documents_openai_parameter_subset_and_response_shape_guards(self):
        readme = Path(__file__).resolve().parents[1].joinpath("README.md").read_text()
        live_canaries = Path(__file__).resolve().parents[2].joinpath("LIVE-CANARIES.md").read_text()
        source = Path(__file__).resolve().parents[1].joinpath("runinfra", "__init__.py").read_text()

        self.assertIn("## OpenAI-compatible parameter scope", readme)
        self.assertIn("The typed native SDK subset is:", readme)
        for row in (
            "openai.params.chat.completions",
            "openai.params.chat.stream_options",
            "openai.params.responses",
            "openai.params.embeddings",
            "openai.params.images",
            "openai.params.audio.speech",
            "openai.params.audio.transcriptions",
        ):
            self.assertIn(row, live_canaries)
            self.assertNotIn(row, readme)
        self.assertIn("RUNINFRA_TTS_RESPONSE_FORMAT", live_canaries)
        self.assertIn("RUNINFRA_ASR_RESPONSE_FORMAT", live_canaries)
        self.assertIn("Optional for the base ASR row; required for the OpenAI ASR parameter row", live_canaries)
        self.assertIn("dimension control", readme)
        self.assertIn(
            "- Responses: `model`, `input`, `stream`, `instructions`, `temperature`,",
            readme,
        )
        self.assertIn(
            "`top_p`, `tools`, `tool_choice`, `response_format`, and `max_output_tokens`.",
            readme,
        )
        self.assertIn("options when the deployed image backend supports them", readme)
        self.assertIn("actual support depends on the deployed backend", readme)
        self.assertIn('`encoding_format` values other than `"float"`', readme)
        self.assertIn('`response_format` values other than `"json"` or `"verbose_json"`', readme)
        self.assertIn("Unsupported OpenAI-style body parameters must fail with a clear traced 4xx", readme)
        self.assertIn("error.model.not_found", live_canaries)
        self.assertIn("error.body.unsupported_parameter", live_canaries)
        self.assertIn("Gateway errors expose `request_id`, `type`, and, when returned by the API", readme)
        self.assertIn("OpenAI-style `code` and `param` metadata", readme)
        self.assertIn("RunInfra `/v1/responses` is a chat-completions compatibility adapter.", readme)
        self.assertIn("forwards the supported request through the chat-completions serving path", readme)
        self.assertIn(
            "does not claim full OpenAI Responses state, include, reasoning, tool, conversation-item, or background-job semantics",
            readme,
        )
        self.assertIn("Responses rows prove the compatibility adapter", live_canaries)
        self.assertIn("Responses compatibility adapter", source)
        self.assertIn("not a full stateful OpenAI Responses implementation", source)

    def test_child_canaries_cover_chat_stream_options_usage_chunks(self):
        runner = Path(__file__).resolve().parents[2].joinpath("scripts", "run-sdk-live-canaries.mjs").read_text()
        typescript_canary = Path(__file__).resolve().parents[2].joinpath("scripts", "sdk-live-canary-typescript.mjs").read_text()
        python_canary = Path(__file__).resolve().parents[2].joinpath("scripts", "sdk-live-canary-python.py").read_text()
        live_canaries = Path(__file__).resolve().parents[2].joinpath("LIVE-CANARIES.md").read_text()

        for text in (runner, typescript_canary, python_canary, live_canaries):
            self.assertIn("openai.params.chat.stream_options", text)
            self.assertIn("stream_options", text)
            self.assertIn("include_usage", text)
        self.assertIn("assertChatStreamUsageEvent", typescript_canary)
        self.assertIn("assertChatUsageObject", typescript_canary)
        self.assertIn('"prompt_tokens"', typescript_canary)
        self.assertIn('"completion_tokens"', typescript_canary)
        self.assertIn('"total_tokens"', typescript_canary)
        self.assertIn('usage: "present"', typescript_canary)
        self.assertIn("assert_chat_stream_usage_event", python_canary)
        self.assertIn("assert_chat_usage_object", python_canary)
        self.assertIn('"prompt_tokens"', python_canary)
        self.assertIn('"completion_tokens"', python_canary)
        self.assertIn('"total_tokens"', python_canary)
        self.assertIn('"usage": "present"', python_canary)
        self.assertIn("assertChatStreamCompatibilityEvent", typescript_canary)
        self.assertIn(
            "events.forEach((event, index) => assertChatStreamCompatibilityEvent(event, `chat stream event ${index}`))",
            typescript_canary,
        )
        self.assertIn(
            "events.forEach((event, index) => assertChatStreamCompatibilityEvent(event, `chat slow-consumer stream event ${index}`))",
            typescript_canary,
        )
        self.assertIn(
            "events.forEach((event, index) => assertChatStreamEnvelope(event, `chat cancellation stream event ${index}`))",
            typescript_canary,
        )
        self.assertIn("assert_chat_stream_compatibility_event", python_canary)
        self.assertIn(
            'assert_chat_stream_compatibility_event(event, f"chat stream event {index}")',
            python_canary,
        )
        self.assertIn(
            'assert_chat_stream_compatibility_event(event, f"chat slow-consumer stream event {index}")',
            python_canary,
        )
        self.assertIn(
            'assert_chat_stream_envelope(event, f"chat cancellation stream event {index}")',
            python_canary,
        )

    def test_child_canaries_cover_live_model_not_found_error_mapping(self):
        runner = Path(__file__).resolve().parents[2].joinpath("scripts", "run-sdk-live-canaries.mjs").read_text()
        typescript_canary = Path(__file__).resolve().parents[2].joinpath("scripts", "sdk-live-canary-typescript.mjs").read_text()
        python_canary = Path(__file__).resolve().parents[2].joinpath("scripts", "sdk-live-canary-python.py").read_text()

        self.assertIn('"error.model.not_found"', runner)
        self.assertIn("ModelNotFoundError", typescript_canary)
        self.assertIn('record("error.model.not_found"', typescript_canary)
        self.assertIn("runinfra-sdk-canary-missing-model", typescript_canary)
        self.assertIn("ModelNotFoundError", python_canary)
        self.assertIn('record("error.model.not_found"', python_canary)
        self.assertIn("runinfra-sdk-canary-missing-model", python_canary)

    def test_child_canaries_cover_local_rate_limit_error_mapping(self):
        runner = Path(__file__).resolve().parents[2].joinpath("scripts", "run-sdk-live-canaries.mjs").read_text()
        typescript_canary = Path(__file__).resolve().parents[2].joinpath("scripts", "sdk-live-canary-typescript.mjs").read_text()
        python_canary = Path(__file__).resolve().parents[2].joinpath("scripts", "sdk-live-canary-python.py").read_text()
        live_canaries = Path(__file__).resolve().parents[2].joinpath("LIVE-CANARIES.md").read_text()
        row = "error.rate_limit.local"

        self.assertIn(f'"{row}"', runner)
        self.assertIn(f'record("{row}"', typescript_canary)
        self.assertIn("RateLimitError", typescript_canary)
        self.assertIn("retryAfterMs", typescript_canary)
        self.assertIn(f'"{row}"', python_canary)
        self.assertIn("RateLimitError", python_canary)
        self.assertIn("retry_after_seconds", python_canary)
        self.assertIn(row, live_canaries)
        self.assertIn("rate-limit", live_canaries)

    def test_child_canaries_cover_local_insufficient_credits_error_mapping(self):
        runner = Path(__file__).resolve().parents[2].joinpath("scripts", "run-sdk-live-canaries.mjs").read_text()
        typescript_canary = Path(__file__).resolve().parents[2].joinpath("scripts", "sdk-live-canary-typescript.mjs").read_text()
        python_canary = Path(__file__).resolve().parents[2].joinpath("scripts", "sdk-live-canary-python.py").read_text()
        live_canaries = Path(__file__).resolve().parents[2].joinpath("LIVE-CANARIES.md").read_text()
        row = "error.insufficient_credits.local"

        self.assertIn(f'"{row}"', runner)
        self.assertIn(f'record("{row}"', typescript_canary)
        self.assertIn("InsufficientCreditsError", typescript_canary)
        self.assertIn(f'"{row}"', python_canary)
        self.assertIn("InsufficientCreditsError", python_canary)
        self.assertIn(row, live_canaries)
        self.assertIn("insufficient-credits", live_canaries)
        typescript_row_start = typescript_canary.index(f'await record("{row}"')
        typescript_row_end = typescript_canary.index('await record("error.rate_limit.local"', typescript_row_start)
        typescript_row = typescript_canary[typescript_row_start:typescript_row_end]
        python_row_start = python_canary.index("def _insufficient_credits_error_local()")
        python_row_end = python_canary.index("def _rate_limit_error_local()", python_row_start)
        python_row = python_canary[python_row_start:python_row_end]

        self.assertNotIn("maxRetries: 0", typescript_row)
        self.assertNotIn('"max_retries": 0', python_row)

    def test_models_list_canary_fails_when_configured_model_is_absent_from_catalog(self):
        typescript_canary = Path(__file__).resolve().parents[2].joinpath("scripts", "sdk-live-canary-typescript.mjs").read_text()
        python_canary = Path(__file__).resolve().parents[2].joinpath("scripts", "sdk-live-canary-python.py").read_text()
        live_canaries = Path(__file__).resolve().parents[2].joinpath("LIVE-CANARIES.md").read_text()

        self.assertIn("configuredCanaryModelIds", typescript_canary)
        self.assertIn("assertConfiguredModelsListed(response.data)", typescript_canary)
        self.assertIn("models.list did not include", typescript_canary)
        self.assertNotIn("missing.join", typescript_canary)
        self.assertIn("configured_canary_model_ids", python_canary)
        self.assertIn('assert_configured_models_listed(response["data"])', python_canary)
        self.assertIn("models.list did not include", python_canary)
        self.assertNotIn("join(missing", python_canary)
        self.assertIn("`models.list` must\ninclude every configured canary model ID", live_canaries)
        self.assertIn("Reports record\nonly the item count", live_canaries)
        typescript_report_env = typescript_canary.split("const relevantEnv = [", 1)[1].split("];", 1)[0]
        python_report_env = python_canary.split("relevant_env = [", 1)[1].split("]", 1)[0]
        self.assertNotIn('"TEST_PIPELINE_ID"', typescript_report_env)
        self.assertNotIn('"TEST_PIPELINE_ID"', python_report_env)
        self.assertIn('firstEnv("RUNINFRA_VOICE_PIPELINE_ID", "TEST_PIPELINE_ID")', typescript_canary)
        self.assertIn('first_env("RUNINFRA_VOICE_PIPELINE_ID", "TEST_PIPELINE_ID")', python_canary)

    def test_webhook_delivery_methods_are_absent_from_artifact_and_canary_public_surface(self):
        runner = Path(__file__).resolve().parents[2].joinpath("scripts", "run-sdk-live-canaries.mjs").read_text()
        typescript_canary = Path(__file__).resolve().parents[2].joinpath("scripts", "sdk-live-canary-typescript.mjs").read_text()
        python_canary = Path(__file__).resolve().parents[2].joinpath("scripts", "sdk-live-canary-python.py").read_text()
        clean_install_verifier = Path(__file__).resolve().parents[2].joinpath("scripts", "verify-clean-installs.mjs").read_text()
        live_canaries = Path(__file__).resolve().parents[2].joinpath("LIVE-CANARIES.md").read_text()

        for text in (runner, typescript_canary, python_canary, clean_install_verifier, live_canaries):
            self.assertIn("webhooks.delivery_surface.absent", text)
            self.assertNotIn("webhooks.create.unsupported", text)
            self.assertNotIn("webhooks.list.unsupported", text)
        self.assertIn('typeof client.webhooks.create !== "undefined"', clean_install_verifier)
        self.assertIn('typeof client.webhooks.list !== "undefined"', clean_install_verifier)
        self.assertIn('hasattr(client.webhooks, "create")', clean_install_verifier)
        self.assertIn('hasattr(client.webhooks, "list")', clean_install_verifier)

    def test_readme_documents_local_request_payload_validation_before_sending(self):
        readme = Path(__file__).resolve().parents[1].joinpath("README.md").read_text()

        self.assertIn("Required request fields are validated before any network request is sent.", readme)
        self.assertIn("model must be a non-blank string", readme)
        self.assertIn("chat messages must be a non-empty array", readme)
        self.assertIn("each chat message must be an object with a non-empty role", readme)
        self.assertIn("Responses input array items must be objects", readme)
        self.assertIn("JSON request bodies must be serializable and contain only finite numbers", readme)
        self.assertIn("embedding input must be a non-empty string or array of non-empty strings", readme)
        self.assertIn("TTS input and image prompts must be non-empty strings", readme)
        self.assertIn("ASR file must be non-empty bytes or bytearray", readme)
        self.assertIn("ASR multipart filenames and content types", readme)
        self.assertIn("`extra_body` is only accepted on JSON body helpers", readme)

    def test_readme_documents_credential_shaped_custom_header_guards(self):
        readme = Path(__file__).resolve().parents[1].joinpath("README.md").read_text()

        self.assertIn("`X-API-Key`", readme)
        self.assertIn("`X-Auth-Token`", readme)
        self.assertIn("`X-Access-Token`", readme)

    def test_readme_documents_typed_stalled_stream_timeouts(self):
        readme = Path(__file__).resolve().parents[1].joinpath("README.md").read_text()

        self.assertIn("stalled streaming reads and default non-streaming body reads after headers arrive", readme)
        self.assertIn("includes `request_id` when the response was traced", readme)
        self.assertIn(
            "streaming body transport failures and default non-streaming body transport failures after headers arrive",
            readme,
        )

    def test_readme_documents_streaming_cancellation_resource_release(self):
        readme = Path(__file__).resolve().parents[1].joinpath("README.md").read_text()
        live_canaries = Path(__file__).resolve().parents[2].joinpath("LIVE-CANARIES.md").read_text()

        self.assertIn("Close the active iterator when you stop consuming a stream early", readme)
        self.assertIn("iterator.close()", readme)
        self.assertIn("Streaming transport-level backend cancellation is best effort", readme)
        self.assertRegex(live_canaries, r"TypeScript cancellation rows break out of\s+`for await`")
        self.assertIn("Python cancellation rows close the active iterator", live_canaries)

    def test_child_canaries_cover_slow_consumer_streaming_rows(self):
        runner = Path(__file__).resolve().parents[2].joinpath("scripts", "run-sdk-live-canaries.mjs").read_text()
        typescript_canary = Path(__file__).resolve().parents[2].joinpath("scripts", "sdk-live-canary-typescript.mjs").read_text()
        python_canary = Path(__file__).resolve().parents[2].joinpath("scripts", "sdk-live-canary-python.py").read_text()
        live_canaries = Path(__file__).resolve().parents[2].joinpath("LIVE-CANARIES.md").read_text()

        for row in ("chat.completions.stream.slow_consumer", "responses.stream.slow_consumer"):
            self.assertIn(f'"{row}"', runner)
            self.assertIn(f'record("{row}"', typescript_canary)
            self.assertIn(f'"{row}"', python_canary)
            self.assertIn(row, live_canaries)

        self.assertIn("RUNINFRA_CANARY_STREAM_SLOW_CONSUMER_DELAY_MS", runner)
        self.assertIn("slowConsumerDelayMs", typescript_canary)
        self.assertIn("slow_consumer_delay_seconds", python_canary)
        self.assertIn("slow_stream_requirements", python_canary)
        self.assertIn("RUNINFRA_CANARY_STREAM_SLOW_CONSUMER_DELAY_MS", live_canaries)
        self.assertIn("Slow-consumer streaming rows", live_canaries)
        self.assertIn("bounded by `RUNINFRA_CANARY_TIMEOUT_SECONDS`", live_canaries)

    def test_child_canaries_cover_local_streaming_fault_rows(self):
        runner = Path(__file__).resolve().parents[2].joinpath("scripts", "run-sdk-live-canaries.mjs").read_text()
        typescript_canary = Path(__file__).resolve().parents[2].joinpath("scripts", "sdk-live-canary-typescript.mjs").read_text()
        python_canary = Path(__file__).resolve().parents[2].joinpath("scripts", "sdk-live-canary-python.py").read_text()
        live_canaries = Path(__file__).resolve().parents[2].joinpath("LIVE-CANARIES.md").read_text()
        rows = (
            "chat.completions.stream.malformed_frame.local",
            "responses.stream.malformed_frame.local",
            "chat.completions.stream.disconnect.local",
            "responses.stream.disconnect.local",
            "chat.completions.stream.stalled_read.local",
            "responses.stream.stalled_read.local",
        )

        for row in rows:
            self.assertIn(f'"{row}"', runner)
            self.assertIn(f'record("{row}"', typescript_canary)
            self.assertIn(f'"{row}"', python_canary)
            self.assertIn(row, live_canaries)

        self.assertIn("RunInfraStreamParseError", typescript_canary)
        self.assertIn("RunInfraConnectionError", typescript_canary)
        self.assertIn("RunInfraTimeoutError", typescript_canary)
        self.assertIn("localStreamClient", typescript_canary)
        self.assertIn("expectStreamError", typescript_canary)
        self.assertIn("RunInfraStreamParseError", python_canary)
        self.assertIn("RunInfraConnectionError", python_canary)
        self.assertIn("RunInfraTimeoutError", python_canary)
        self.assertIn("local_stream_client", python_canary)
        self.assertIn("expect_stream_error", python_canary)
        self.assertIn("Local streaming fault rows", live_canaries)
        self.assertIn("do not call the production gateway", live_canaries)

    def test_child_canaries_cover_local_retry_safety_rows(self):
        runner = Path(__file__).resolve().parents[2].joinpath("scripts", "run-sdk-live-canaries.mjs").read_text()
        typescript_canary = Path(__file__).resolve().parents[2].joinpath("scripts", "sdk-live-canary-typescript.mjs").read_text()
        python_canary = Path(__file__).resolve().parents[2].joinpath("scripts", "sdk-live-canary-python.py").read_text()
        live_canaries = Path(__file__).resolve().parents[2].joinpath("LIVE-CANARIES.md").read_text()
        rows = (
            "retry.safety.get.local",
            "retry.safety.post.requires_idempotency.local",
            "retry.safety.post.with_idempotency.local",
            "retry.safety.post.non_replayable_json.no_retry.local",
            "retry.safety.stream.no_retry.local",
            "retry.safety.audio_binary.no_retry.local",
            "retry.safety.audio_multipart.no_retry.local",
            "retry.safety.voice_binary.no_retry.local",
        )

        for row in rows:
            self.assertIn(f'"{row}"', runner)
            self.assertIn(f'record("{row}"', typescript_canary)
            self.assertIn(f'"{row}"', python_canary)
            self.assertIn(row, live_canaries)

        self.assertIn("localRetryClient", typescript_canary)
        self.assertIn("localRetryTransportError", typescript_canary)
        self.assertIn('failureModes: "http_503,transport_error"', typescript_canary)
        self.assertIn("assertRetryCallCount", typescript_canary)
        self.assertIn("local_retry_client", python_canary)
        self.assertIn("local_retry_transport_error", python_canary)
        self.assertIn('"failureModes": "http_503,transport_error"', python_canary)
        self.assertIn("assert_retry_call_count", python_canary)
        self.assertIn("Local retry-safety rows", live_canaries)
        self.assertIn("retryable HTTP status", live_canaries)
        self.assertIn("transport exceptions", live_canaries)
        self.assertIn("do not call the production gateway", live_canaries)

    def test_child_canaries_cover_local_client_request_id_row(self):
        runner = Path(__file__).resolve().parents[2].joinpath("scripts", "run-sdk-live-canaries.mjs").read_text()
        typescript_canary = Path(__file__).resolve().parents[2].joinpath("scripts", "sdk-live-canary-typescript.mjs").read_text()
        python_canary = Path(__file__).resolve().parents[2].joinpath("scripts", "sdk-live-canary-python.py").read_text()
        live_canaries = Path(__file__).resolve().parents[2].joinpath("LIVE-CANARIES.md").read_text()
        row = "request.client_request_id.local"

        self.assertIn(f'"{row}"', runner)
        self.assertIn(f'record("{row}"', typescript_canary)
        self.assertIn("assertClientRequestIdHeader", typescript_canary)
        self.assertIn(f'"{row}"', python_canary)
        self.assertIn("assert_client_request_id_header", python_canary)
        self.assertIn(row, live_canaries)
        self.assertIn("Local request-option rows", live_canaries)

    def test_child_canaries_cover_local_custom_headers_row(self):
        runner = Path(__file__).resolve().parents[2].joinpath("scripts", "run-sdk-live-canaries.mjs").read_text()
        typescript_canary = Path(__file__).resolve().parents[2].joinpath("scripts", "sdk-live-canary-typescript.mjs").read_text()
        python_canary = Path(__file__).resolve().parents[2].joinpath("scripts", "sdk-live-canary-python.py").read_text()
        live_canaries = Path(__file__).resolve().parents[2].joinpath("LIVE-CANARIES.md").read_text()
        row = "request.custom_headers.local"

        self.assertIn(f'"{row}"', runner)
        self.assertIn(f'record("{row}"', typescript_canary)
        self.assertIn("assertCustomHeader", typescript_canary)
        self.assertIn(f'"{row}"', python_canary)
        self.assertIn("assert_custom_header", python_canary)
        self.assertIn(row, live_canaries)
        self.assertIn("custom request headers", live_canaries)

    def test_child_canaries_cover_local_timeout_row(self):
        runner = Path(__file__).resolve().parents[2].joinpath("scripts", "run-sdk-live-canaries.mjs").read_text()
        typescript_canary = Path(__file__).resolve().parents[2].joinpath("scripts", "sdk-live-canary-typescript.mjs").read_text()
        python_canary = Path(__file__).resolve().parents[2].joinpath("scripts", "sdk-live-canary-python.py").read_text()
        live_canaries = Path(__file__).resolve().parents[2].joinpath("LIVE-CANARIES.md").read_text()
        row = "request.timeout.local"

        self.assertIn(f'"{row}"', runner)
        self.assertIn(f'record("{row}"', typescript_canary)
        self.assertIn("localTimeoutClient", typescript_canary)
        self.assertIn(f'"{row}"', python_canary)
        self.assertIn("local_timeout_client", python_canary)
        self.assertIn(row, live_canaries)
        self.assertIn("per-request timeout", live_canaries)

    def test_child_canaries_cover_local_extra_body_row(self):
        runner = Path(__file__).resolve().parents[2].joinpath("scripts", "run-sdk-live-canaries.mjs").read_text()
        typescript_canary = Path(__file__).resolve().parents[2].joinpath("scripts", "sdk-live-canary-typescript.mjs").read_text()
        python_canary = Path(__file__).resolve().parents[2].joinpath("scripts", "sdk-live-canary-python.py").read_text()
        live_canaries = Path(__file__).resolve().parents[2].joinpath("LIVE-CANARIES.md").read_text()
        row = "request.extra_body.local"

        self.assertIn(f'"{row}"', runner)
        self.assertIn(f'record("{row}"', typescript_canary)
        self.assertIn("assertExtraBodyJsonField", typescript_canary)
        self.assertIn(f'"{row}"', python_canary)
        self.assertIn("assert_extra_body_json_field", python_canary)
        self.assertIn(row, live_canaries)
        self.assertIn("explicit JSON extra-body", live_canaries)

    def test_child_canaries_cover_local_unknown_request_fields_row(self):
        runner = Path(__file__).resolve().parents[2].joinpath("scripts", "run-sdk-live-canaries.mjs").read_text()
        typescript_canary = Path(__file__).resolve().parents[2].joinpath("scripts", "sdk-live-canary-typescript.mjs").read_text()
        python_canary = Path(__file__).resolve().parents[2].joinpath("scripts", "sdk-live-canary-python.py").read_text()
        live_canaries = Path(__file__).resolve().parents[2].joinpath("LIVE-CANARIES.md").read_text()
        row = "request.unknown_fields.local"

        self.assertIn(f'"{row}"', runner)
        self.assertIn(f'record("{row}"', typescript_canary)
        self.assertIn("assertUnknownRequestFieldRejected", typescript_canary)
        self.assertIn(f'"{row}"', python_canary)
        self.assertIn("assert_unknown_request_field_rejected", python_canary)
        self.assertIn(row, live_canaries)
        self.assertIn("unknown direct request fields", live_canaries)

    def test_child_canaries_cover_local_browser_api_key_guard_row(self):
        runner = Path(__file__).resolve().parents[2].joinpath("scripts", "run-sdk-live-canaries.mjs").read_text()
        typescript_canary = Path(__file__).resolve().parents[2].joinpath("scripts", "sdk-live-canary-typescript.mjs").read_text()
        python_canary = Path(__file__).resolve().parents[2].joinpath("scripts", "sdk-live-canary-python.py").read_text()
        live_canaries = Path(__file__).resolve().parents[2].joinpath("LIVE-CANARIES.md").read_text()
        row = "browser.api_key_guard.local"

        self.assertIn(f'"{row}"', runner)
        self.assertIn(f'record("{row}"', typescript_canary)
        self.assertIn("assertBrowserApiKeyGuard", typescript_canary)
        self.assertIn(f'"{row}"', python_canary)
        self.assertIn("browser_token_surface", python_canary)
        self.assertIn(row, live_canaries)
        self.assertIn("browser API-key guard", live_canaries)

    def test_child_canaries_cover_local_api_key_redaction_row(self):
        runner = Path(__file__).resolve().parents[2].joinpath("scripts", "run-sdk-live-canaries.mjs").read_text()
        typescript_canary = Path(__file__).resolve().parents[2].joinpath("scripts", "sdk-live-canary-typescript.mjs").read_text()
        python_canary = Path(__file__).resolve().parents[2].joinpath("scripts", "sdk-live-canary-python.py").read_text()
        live_canaries = Path(__file__).resolve().parents[2].joinpath("LIVE-CANARIES.md").read_text()
        row = "security.api_key_redaction.local"

        self.assertIn(f'"{row}"', runner)
        self.assertIn(f'record("{row}"', typescript_canary)
        self.assertIn("assertApiKeyRedaction", typescript_canary)
        self.assertIn(f'"{row}"', python_canary)
        self.assertIn("assert_api_key_redaction", python_canary)
        self.assertIn(row, live_canaries)
        self.assertIn("API-key redaction", live_canaries)

    def test_runner_has_public_surface_coverage_gate(self):
        scripts_dir = Path(__file__).resolve().parents[2].joinpath("scripts")
        runner = scripts_dir.joinpath("run-sdk-live-canaries.mjs").read_text()
        coverage_manifest = scripts_dir.joinpath("live-canary-surface-coverage.mjs").read_text()

        self.assertIn("--verify-surface-coverage", runner)
        self.assertIn("publicSurfaceCoverage", runner)
        self.assertIn("live-canary-surface-coverage.mjs", runner)
        self.assertIn("client.chat.completions.create", coverage_manifest)
        self.assertIn("client.responses.create", coverage_manifest)
        self.assertIn("client.embeddings.create", coverage_manifest)
        self.assertIn("client.images.generate", coverage_manifest)
        self.assertIn("client.audio.speech.create", coverage_manifest)
        self.assertIn("client.audio.transcriptions.create", coverage_manifest)
        self.assertIn("client.voice.pipeline.create", coverage_manifest)
        self.assertIn("client.webhooks.verify_signature", coverage_manifest)
        self.assertIn("verify_webhook_signature", coverage_manifest)
        self.assertIn("RunInfraAudioResponse.blob", coverage_manifest)
        self.assertIn("declaredSurfaces", runner)
        self.assertIn("uncoveredSurfaces", runner)
        self.assertIn("uncoveredRows", runner)
        self.assertIn("RunInfraStream[Symbol.asyncIterator]", coverage_manifest)
        self.assertIn("RunInfraStream.__iter__", coverage_manifest)
        self.assertIn("surfaceCoverageFailureReport", runner)
        self.assertIn("canonicalEnvAliases", runner)
        self.assertIn("TEST_MODEL", runner)
        self.assertIn("TEST_ASR_FILE", runner)

    def test_python_live_canary_validates_slow_consumer_delay_before_opening_stream(self):
        canary_path = Path(__file__).resolve().parents[2].joinpath("scripts", "sdk-live-canary-python.py")
        spec = importlib.util.spec_from_file_location("sdk_live_canary_python", canary_path)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        live_canary = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(live_canary)

        class ExplodingCompletions:
            def create(self, **_kwargs):
                raise AssertionError("stream opened before delay validation")

        class FakeChat:
            completions = ExplodingCompletions()

        class FakeClient:
            chat = FakeChat()

        with patch.dict(os.environ, {"RUNINFRA_CANARY_STREAM_SLOW_CONSUMER_DELAY_MS": "6000"}):
            with self.assertRaisesRegex(AssertionError, "non-negative integer <= 5000"):
                live_canary._chat_stream_slow_consumer(FakeClient(), "model")

    def test_python_live_canary_bounds_slow_consumer_sleep_to_row_deadline(self):
        canary_path = Path(__file__).resolve().parents[2].joinpath("scripts", "sdk-live-canary-python.py")
        spec = importlib.util.spec_from_file_location("sdk_live_canary_python", canary_path)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        live_canary = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(live_canary)

        with patch.dict(
            os.environ,
            {
                "RUNINFRA_CANARY_STREAM_SLOW_CONSUMER_DELAY_MS": "2",
                "RUNINFRA_CANARY_TIMEOUT_SECONDS": "0.001",
            },
        ):
            with self.assertRaisesRegex(AssertionError, "slow-consumer timed out"):
                live_canary.read_slow_stream([{"event": 1}], "test slow stream", lambda _event: True)

    def test_python_live_canary_closes_active_stream_iterator_on_cancellation(self):
        canary_path = Path(__file__).resolve().parents[2].joinpath("scripts", "sdk-live-canary-python.py")
        canary = canary_path.read_text()

        self.assertIn("iterator = iter(stream)", canary)
        self.assertIn("iterator.close()", canary)
        self.assertNotIn('getattr(stream, "close", None)', canary)

        spec = importlib.util.spec_from_file_location("sdk_live_canary_python", canary_path)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        live_canary = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(live_canary)

        class CloseTrackingIterator:
            def __init__(self):
                self.index = 0
                self.closed = False

            def __iter__(self):
                return self

            def __next__(self):
                self.index += 1
                return {"event": self.index}

            def close(self):
                self.closed = True

        class CloseTrackingStream:
            def __init__(self):
                self.iterator = CloseTrackingIterator()

            def __iter__(self):
                return self.iterator

        stream = CloseTrackingStream()

        events = live_canary.read_some_stream(stream, "test stream")

        self.assertEqual(events, [{"event": 1}, {"event": 2}, {"event": 3}])
        self.assertTrue(stream.iterator.closed)

    def test_python_live_canary_rejects_unsafe_idempotency_evidence_field_paths(self):
        canary_path = Path(__file__).resolve().parents[2].joinpath("scripts", "sdk-live-canary-python.py")
        spec = importlib.util.spec_from_file_location("sdk_live_canary_python", canary_path)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        live_canary = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(live_canary)

        unsafe_field = "sk-ri-" + "A" * 24
        with patch.dict(os.environ, {"RUNINFRA_CANARY_IDEMPOTENCY_EVIDENCE_FIELD": unsafe_field}):
            with self.assertRaisesRegex(AssertionError, "RUNINFRA_CANARY_IDEMPOTENCY_EVIDENCE_FIELD"):
                live_canary.assert_idempotency_replay_evidence({unsafe_field: True})

    def test_readme_documents_sync_only_async_runtime_guidance(self):
        readme = Path(__file__).resolve().parents[1].joinpath("README.md").read_text()

        self.assertIn("## Async Python runtimes", readme)
        self.assertIn("`RunInfra` is intentionally sync-only in v0.3.2", readme)
        self.assertIn("does not block the event loop", readme)
        self.assertIn("Do not instantiate an\n`AsyncRunInfra` client", readme)

    def test_readme_documents_public_repo_promotion_without_stale_monorepo_commands(self):
        root = Path(__file__).resolve().parents[2]
        readme = Path(__file__).resolve().parents[1].joinpath("README.md").read_text()
        agent_notes = root.joinpath("AGENT-NOTES.md").read_text()
        live_canaries = root.joinpath("LIVE-CANARIES.md").read_text()

        self.assertNotIn("For production promotion", readme)
        self.assertNotIn("This public repo now includes live-canary runners for both SDKs.", readme)
        self.assertNotIn("node scripts/run-sdk-live-canaries.mjs", readme)
        self.assertNotIn("RUNINFRA_ASR_FIXTURE_BASE64", readme)
        self.assertNotIn("RUNINFRA_VOICE_PIPELINE_AUDIO_BASE64", readme)
        self.assertIn("## Voice pipelines and webhooks", readme)
        self.assertIn("candidate.sourceDigestSha256", live_canaries)
        self.assertIn("typescript/tsconfig.json", live_canaries)
        self.assertIn("python/MANIFEST.in", live_canaries)
        self.assertIn("candidate.artifacts", live_canaries)
        self.assertIn("canonical live canary matrix", live_canaries)
        self.assertIn("readiness `summary.ready` to equal the canonical matrix row count", live_canaries)
        self.assertIn("readiness `summary.blocked` to be `0`", live_canaries)
        self.assertIn(
            "artifact clean-install gate imports both the prebuilt Python wheel and an",
            live_canaries,
        )
        self.assertIn("sdist-built wheel", live_canaries)
        self.assertIn("RUNINFRA_ASR_FIXTURE_BASE64", live_canaries)
        self.assertIn("RUNINFRA_VOICE_PIPELINE_AUDIO_BASE64", live_canaries)
        self.assertIn("`dry_run=false` cannot bypass `promotion-gate`", agent_notes)
        self.assertIn("Clean artifact install/import now exercises the npm tarball, Python wheel, and", agent_notes)
        self.assertIn("node scripts/verify-github-security-status.mjs --repo RightNow-AI/runinfra-sdk", agent_notes)
        self.assertIn(
            "the publish jobs publish only the downloaded `runinfra-sdk-promoted-artifacts` files",
            agent_notes,
        )
        self.assertIn("readiness summary at all rows ready with zero blocked rows", agent_notes)
        self.assertIn("source digest includes `typescript/tsconfig.json` and `python/MANIFEST.in`", agent_notes)
        self.assertNotIn("The simplified workflow doesn't run the strict gate scripts", agent_notes)
        self.assertNotIn("Do not use npm or PyPI tokens", readme)
        self.assertNotIn("pnpm verify:sdk-release", readme)
        self.assertNotIn("pnpm test:sdk-canary:live", readme)
        self.assertNotIn("RUNINFRA_SDK_CI_TOKEN", readme)

    def test_docs_document_safe_live_canary_env_file_flag(self):
        root = Path(__file__).resolve().parents[2]
        docs = [
            root.joinpath("LIVE-CANARIES.md").read_text(),
            root.joinpath("AGENT-NOTES.md").read_text(),
        ]

        for doc in docs:
            self.assertIn("`--runinfra-env-file <path-to-env-file>`", doc)
            self.assertIn("Do not use Node's `--env-file` option in promotion commands", doc)

    def test_python_child_canary_reports_explicit_production_base_url_without_redacting_it(self):
        root = Path(__file__).resolve().parents[2]
        canary_path = root.joinpath("scripts", "sdk-live-canary-python.py")
        spec = importlib.util.spec_from_file_location("sdk_live_canary_python", canary_path)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        canary = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(canary)

        with patch.dict(os.environ, {}, clear=True):
            self.assertEqual(canary.report_base_url(canary.PRODUCTION_BASE_URL), canary.PRODUCTION_BASE_URL)

        with patch.dict(os.environ, {"RUNINFRA_BASE_URL": canary.PRODUCTION_BASE_URL}, clear=True):
            self.assertEqual(canary.report_base_url(canary.PRODUCTION_BASE_URL), canary.PRODUCTION_BASE_URL)

        with patch.dict(os.environ, {"RUNINFRA_BASE_URL": "https://staging.runinfra.ai/v1"}, clear=True):
            self.assertEqual(
                canary.report_base_url("https://staging.runinfra.ai/v1"),
                "custom_set_redacted",
            )

    def test_python_child_canary_error_summary_adds_safe_diagnostics_without_messages(self):
        root = Path(__file__).resolve().parents[2]
        canary_path = root.joinpath("scripts", "sdk-live-canary-python.py")
        spec = importlib.util.spec_from_file_location("sdk_live_canary_python", canary_path)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        canary = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(canary)

        summary = canary.error_summary(AssertionError("unsupported body parameter unexpectedly succeeded"))
        unknown = canary.error_summary(AssertionError("local path RUNINFRA_LOCAL_PATH_SENTINEL"))

        self.assertEqual(summary["diagnostic"], "unexpected_success")
        self.assertEqual(summary["message"], "redacted")
        self.assertNotIn("unsupported body parameter", json.dumps(summary))
        self.assertIsNone(unknown["diagnostic"])
        self.assertEqual(unknown["message"], "redacted")
        self.assertNotIn("RUNINFRA_LOCAL_PATH_SENTINEL", json.dumps(unknown))

    def test_python_package_verifier_blocks_broader_secret_and_path_families(self):
        verifier_path = Path(__file__).resolve().parents[2].joinpath("scripts", "verify-python-package.py")
        spec = importlib.util.spec_from_file_location("verify_python_package", verifier_path)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        verifier = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(verifier)

        samples = [
            "github_pat_" + "A" * 82,
            "ghs_" + "A" * 36,
            "AKIA" + "A" * 16,
            "sk_live_" + "A" * 24,
            "whsec_" + "A" * 32,
            "eyJ" + "A" * 20 + "." + "B" * 20 + "." + "C" * 20,
            "-----BEGIN ENCRYPTED PRIVATE KEY-----",
            "-----BEGIN PGP PRIVATE KEY BLOCK-----",
            r"C:\Users\someone\project",
            "/Users/someone/project/.env.local",
            "/home/someone/project/.env.local",
            "//registry.npmjs.org/:_authToken=TOKEN",
            "[pypi]\nusername = __token__\npassword = TOKEN",
            "machine upload.pypi.org login __token__ password TOKEN",
            "[global]\nindex-url = https://user:pass@example.invalid/simple",
            "[global]\nextra-index-url = https://user:pass@example.invalid/simple",
            ".env",
            ".env.local",
            "package/.env.local",
            "/tmp/project/.env.local",
            "//# sourceMappingURL=index.py.map",
            "sourceURL=runinfra-sdk://dist/index.py",
            '{"sourcesContent":["secret source"]}',
            "webpack://runinfra-sdk/./runinfra/__init__.py",
        ]

        for sample in samples:
            with self.subTest(sample=sample[:12]):
                self.assertTrue(verifier.has_forbidden_content(sample.encode("utf-8")))
        self.assertFalse(
            verifier.has_forbidden_content(
                b"Package scanners reject `.pypirc`, `.netrc`, `pip.conf`, and `pip.ini` files."
            )
        )

    def test_python_package_verifier_rejects_duplicate_archive_entries(self):
        verifier_path = Path(__file__).resolve().parents[2].joinpath("scripts", "verify-python-package.py")
        spec = importlib.util.spec_from_file_location("verify_python_package", verifier_path)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        verifier = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(verifier)

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            wheel_path = tmp_path.joinpath("runinfra-0.0.0-py3-none-any.whl")
            with zipfile.ZipFile(wheel_path, "w") as wheel:
                wheel.writestr("runinfra/__init__.py", "__version__ = '0.0.0'\n")
                wheel.writestr("runinfra/py.typed", "")
                wheel.writestr("runinfra-0.0.0.dist-info/METADATA", "Name: runinfra\n")
                wheel.writestr("runinfra-0.0.0.dist-info/RECORD", "")
                wheel.writestr("runinfra-0.0.0.dist-info/WHEEL", "Wheel-Version: 1.0\n")
                wheel.writestr("runinfra-0.0.0.dist-info/top_level.txt", "runinfra\n")
                wheel.writestr("runinfra-0.0.0.dist-info/licenses/LICENSE", "MIT\n")
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", UserWarning)
                    wheel.writestr("runinfra/__init__.py", "__version__ = '0.0.0'\n")

            sdist_path = tmp_path.joinpath("runinfra-0.0.0.tar.gz")
            with tarfile.open(sdist_path, "w:gz") as sdist:
                def add_file(name, content):
                    payload = content.encode("utf-8")
                    member = tarfile.TarInfo(f"runinfra-0.0.0/{name}")
                    member.size = len(payload)
                    sdist.addfile(member, io.BytesIO(payload))

                for name in verifier.SDIST_ALLOWED:
                    add_file(name, "placeholder\n")
                add_file("runinfra/__init__.py", "placeholder\n")

            for archive_path, verify_archive in (
                (wheel_path, verifier.verify_wheel),
                (sdist_path, verifier.verify_sdist),
            ):
                with self.subTest(archive=archive_path.name):
                    with self.assertRaises(SystemExit) as raised:
                        verify_archive(archive_path)
                    self.assertEqual(raised.exception.code, 1)

    def test_python_package_verifier_rejects_wrong_package_metadata(self):
        verifier_path = Path(__file__).resolve().parents[2].joinpath("scripts", "verify-python-package.py")
        spec = importlib.util.spec_from_file_location("verify_python_package", verifier_path)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        verifier = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(verifier)

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            wheel_path = tmp_path.joinpath(f"runinfra-{__version__}-py3-none-any.whl")
            dist_info = f"runinfra-{__version__}.dist-info"
            with zipfile.ZipFile(wheel_path, "w") as wheel:
                wheel.writestr("runinfra/__init__.py", "__version__ = '0.0.0'\n")
                wheel.writestr("runinfra/py.typed", "")
                wheel.writestr(
                    f"{dist_info}/METADATA",
                    "Metadata-Version: 2.4\nName: wrong-runinfra\nVersion: 0.0.0\n",
                )
                wheel.writestr(f"{dist_info}/RECORD", "")
                wheel.writestr(f"{dist_info}/WHEEL", "Wheel-Version: 1.0\n")
                wheel.writestr(f"{dist_info}/top_level.txt", "runinfra\n")
                wheel.writestr(f"{dist_info}/licenses/LICENSE", "MIT\n")

            sdist_path = tmp_path.joinpath(f"runinfra-{__version__}.tar.gz")
            with tarfile.open(sdist_path, "w:gz") as sdist:
                def add_file(name, content):
                    payload = content.encode("utf-8")
                    member = tarfile.TarInfo(f"runinfra-{__version__}/{name}")
                    member.size = len(payload)
                    sdist.addfile(member, io.BytesIO(payload))

                for name in verifier.SDIST_ALLOWED:
                    if name in {"PKG-INFO", "runinfra.egg-info/PKG-INFO"}:
                        add_file(name, "Metadata-Version: 2.4\nName: wrong-runinfra\nVersion: 0.0.0\n")
                    elif name == "runinfra/__init__.py":
                        add_file(name, "__version__ = '0.0.0'\n")
                    else:
                        add_file(name, "placeholder\n")

            for archive_path, verify_archive in (
                (wheel_path, verifier.verify_wheel),
                (sdist_path, verifier.verify_sdist),
            ):
                with self.subTest(archive=archive_path.name):
                    with self.assertRaises(SystemExit) as raised:
                        verify_archive(archive_path)
                    self.assertEqual(raised.exception.code, 1)

    def test_python_package_verifier_rejects_runtime_dependencies(self):
        verifier_path = Path(__file__).resolve().parents[2].joinpath("scripts", "verify-python-package.py")
        spec = importlib.util.spec_from_file_location("verify_python_package", verifier_path)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        verifier = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(verifier)

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            wheel_path = tmp_path.joinpath(f"runinfra-{__version__}-py3-none-any.whl")
            dist_info = f"runinfra-{__version__}.dist-info"
            package_metadata = (
                f"Metadata-Version: 2.4\nName: runinfra\nVersion: {__version__}\n"
                "Requires-Dist: requests>=2\n"
            )
            with zipfile.ZipFile(wheel_path, "w") as wheel:
                wheel.writestr("runinfra/__init__.py", f"__version__ = '{__version__}'\n")
                wheel.writestr("runinfra/py.typed", "")
                wheel.writestr(f"{dist_info}/METADATA", package_metadata)
                wheel.writestr(f"{dist_info}/RECORD", "")
                wheel.writestr(f"{dist_info}/WHEEL", "Wheel-Version: 1.0\n")
                wheel.writestr(f"{dist_info}/top_level.txt", "runinfra\n")
                wheel.writestr(f"{dist_info}/licenses/LICENSE", "MIT\n")

            sdist_path = tmp_path.joinpath(f"runinfra-{__version__}.tar.gz")
            with tarfile.open(sdist_path, "w:gz") as sdist:
                def add_file(name, content):
                    payload = content.encode("utf-8")
                    member = tarfile.TarInfo(f"runinfra-{__version__}/{name}")
                    member.size = len(payload)
                    sdist.addfile(member, io.BytesIO(payload))

                for name in verifier.SDIST_ALLOWED:
                    if name in {"PKG-INFO", "runinfra.egg-info/PKG-INFO"}:
                        add_file(name, package_metadata)
                    elif name == "runinfra/__init__.py":
                        add_file(name, f"__version__ = '{__version__}'\n")
                    else:
                        add_file(name, "placeholder\n")

            for archive_path, verify_archive in (
                (wheel_path, verifier.verify_wheel),
                (sdist_path, verifier.verify_sdist),
            ):
                with self.subTest(archive=archive_path.name):
                    with self.assertRaises(SystemExit) as raised:
                        verify_archive(archive_path)
                    self.assertEqual(raised.exception.code, 1)

    def test_python_package_verifier_rejects_wheels_with_stale_record_metadata(self):
        verifier_path = Path(__file__).resolve().parents[2].joinpath("scripts", "verify-python-package.py")
        spec = importlib.util.spec_from_file_location("verify_python_package", verifier_path)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        verifier = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(verifier)

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            wheel_path = tmp_path.joinpath(f"runinfra-{__version__}-py3-none-any.whl")
            dist_info = f"runinfra-{__version__}.dist-info"
            with zipfile.ZipFile(wheel_path, "w") as wheel:
                wheel.writestr("runinfra/__init__.py", f"__version__ = '{__version__}'\n")
                wheel.writestr("runinfra/py.typed", "")
                wheel.writestr(f"{dist_info}/METADATA", f"Metadata-Version: 2.4\nName: runinfra\nVersion: {__version__}\n")
                wheel.writestr(f"{dist_info}/WHEEL", "Wheel-Version: 1.0\nRoot-Is-Purelib: true\nTag: py3-none-any\n")
                wheel.writestr(f"{dist_info}/top_level.txt", "runinfra\n")
                wheel.writestr(f"{dist_info}/licenses/LICENSE", "RunInfra license\n")
                wheel.writestr(f"{dist_info}/RECORD", "")

            with self.assertRaises(SystemExit) as raised:
                verifier.verify_wheel(wheel_path)
            self.assertEqual(raised.exception.code, 1)

    def test_python_package_verifier_rejects_sdist_with_stale_sources_manifest(self):
        verifier_path = Path(__file__).resolve().parents[2].joinpath("scripts", "verify-python-package.py")
        spec = importlib.util.spec_from_file_location("verify_python_package", verifier_path)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        verifier = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(verifier)

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            sdist_path = tmp_path.joinpath(f"runinfra-{__version__}.tar.gz")
            package_metadata = f"Metadata-Version: 2.4\nName: runinfra\nVersion: {__version__}\n"
            with tarfile.open(sdist_path, "w:gz") as sdist:
                def add_file(name, content):
                    payload = content.encode("utf-8")
                    member = tarfile.TarInfo(f"runinfra-{__version__}/{name}")
                    member.size = len(payload)
                    sdist.addfile(member, io.BytesIO(payload))

                for name in verifier.SDIST_ALLOWED:
                    if name in {"PKG-INFO", "runinfra.egg-info/PKG-INFO"}:
                        add_file(name, package_metadata)
                    elif name == "runinfra/__init__.py":
                        add_file(name, f"__version__ = '{__version__}'\n")
                    elif name == "runinfra.egg-info/SOURCES.txt":
                        add_file(name, "")
                    else:
                        add_file(name, "placeholder\n")

            with self.assertRaises(SystemExit) as raised:
                verifier.verify_sdist(sdist_path)
            self.assertEqual(raised.exception.code, 1)

    def test_python_package_verifier_rejects_wheel_layout_and_sdist_root_metadata(self):
        verifier_path = Path(__file__).resolve().parents[2].joinpath("scripts", "verify-python-package.py")
        spec = importlib.util.spec_from_file_location("verify_python_package", verifier_path)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        verifier = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(verifier)

        package_metadata = f"Metadata-Version: 2.4\nName: runinfra\nVersion: {__version__}\n"

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            dist_info = f"runinfra-{__version__}.dist-info"

            def write_wheel(path, *, root_is_purelib="true", tag="py3-none-any", top_level="runinfra\n"):
                with zipfile.ZipFile(path, "w") as wheel:
                    wheel.writestr("runinfra/__init__.py", f"__version__ = '{__version__}'\n")
                    wheel.writestr("runinfra/py.typed", "")
                    wheel.writestr(f"{dist_info}/METADATA", package_metadata)
                    wheel.writestr(f"{dist_info}/RECORD", "")
                    wheel.writestr(
                        f"{dist_info}/WHEEL",
                        f"Wheel-Version: 1.0\nRoot-Is-Purelib: {root_is_purelib}\nTag: {tag}\n",
                    )
                    wheel.writestr(f"{dist_info}/top_level.txt", top_level)
                    wheel.writestr(f"{dist_info}/licenses/LICENSE", "MIT\n")

            def write_sdist(path, *, root_name):
                with tarfile.open(path, "w:gz") as sdist:
                    for name in verifier.SDIST_ALLOWED:
                        if name in {"PKG-INFO", "runinfra.egg-info/PKG-INFO"}:
                            add_file(sdist, root_name, name, package_metadata)
                        elif name == "runinfra/__init__.py":
                            add_file(sdist, root_name, name, f"__version__ = '{__version__}'\n")
                        else:
                            add_file(sdist, root_name, name, "placeholder\n")

            def add_file(sdist, root_name, name, content):
                payload = content.encode("utf-8")
                member = tarfile.TarInfo(f"{root_name}/{name}")
                member.size = len(payload)
                sdist.addfile(member, io.BytesIO(payload))

            invalid_purelib_wheel = tmp_path.joinpath("runinfra-invalid-purelib.whl")
            write_wheel(invalid_purelib_wheel, root_is_purelib="false")
            invalid_tag_wheel = tmp_path.joinpath("runinfra-invalid-tag.whl")
            write_wheel(invalid_tag_wheel, tag="cp311-cp311-win_amd64")
            invalid_top_level_wheel = tmp_path.joinpath("runinfra-invalid-top-level.whl")
            write_wheel(invalid_top_level_wheel, top_level="runinfra_internal\n")

            wrong_root_sdist = tmp_path.joinpath("runinfra-wrong-root.tar.gz")
            write_sdist(wrong_root_sdist, root_name=f"wrong-runinfra-{__version__}")
            absolute_root_sdist = tmp_path.joinpath("runinfra-absolute-root.tar.gz")
            write_sdist(absolute_root_sdist, root_name=f"/runinfra-{__version__}")

            for archive_path, verify_archive in (
                (invalid_purelib_wheel, verifier.verify_wheel),
                (invalid_tag_wheel, verifier.verify_wheel),
                (invalid_top_level_wheel, verifier.verify_wheel),
                (wrong_root_sdist, verifier.verify_sdist),
                (absolute_root_sdist, verifier.verify_sdist),
            ):
                with self.subTest(archive=archive_path.name):
                    with self.assertRaises(SystemExit) as raised:
                        verify_archive(archive_path)
                    self.assertEqual(raised.exception.code, 1)

    def test_python_package_verifier_rejects_non_regular_archive_entries(self):
        root = Path(__file__).resolve().parents[2]
        verifier_path = root.joinpath("scripts", "verify-python-package.py")
        spec = importlib.util.spec_from_file_location("verify_python_package", verifier_path)
        self.assertIsNotNone(spec)
        self.assertIsNotNone(spec.loader)
        verifier = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(verifier)

        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = Path(tmp)
            wheel_path = tmp_path.joinpath("runinfra-0.0.0-py3-none-any.whl")
            with zipfile.ZipFile(wheel_path, "w") as wheel:
                wheel.writestr("runinfra/__init__.py", "__version__ = '0.0.0'\n")
                symlink = zipfile.ZipInfo("runinfra/py.typed")
                symlink.create_system = 3
                symlink.external_attr = (stat.S_IFLNK | 0o777) << 16
                wheel.writestr(symlink, "runinfra/__init__.py")
                wheel.writestr("runinfra-0.0.0.dist-info/METADATA", "Name: runinfra\n")
                wheel.writestr("runinfra-0.0.0.dist-info/RECORD", "")
                wheel.writestr("runinfra-0.0.0.dist-info/WHEEL", "Wheel-Version: 1.0\n")
                wheel.writestr("runinfra-0.0.0.dist-info/top_level.txt", "runinfra\n")
                wheel.writestr("runinfra-0.0.0.dist-info/licenses/LICENSE", "MIT\n")

            sdist_path = tmp_path.joinpath("runinfra-0.0.0.tar.gz")
            with tarfile.open(sdist_path, "w:gz") as sdist:
                def add_file(name, content):
                    payload = content.encode("utf-8")
                    member = tarfile.TarInfo(f"runinfra-0.0.0/{name}")
                    member.size = len(payload)
                    sdist.addfile(member, io.BytesIO(payload))

                for name in sorted(verifier.SDIST_ALLOWED - {"runinfra/py.typed"}):
                    add_file(name, "placeholder\n")
                link = tarfile.TarInfo("runinfra-0.0.0/runinfra/py.typed")
                link.type = tarfile.SYMTYPE
                link.linkname = "__init__.py"
                sdist.addfile(link)

            top_level_sdist_path = tmp_path.joinpath("runinfra-0.0.0-top-level.tar.gz")
            with tarfile.open(top_level_sdist_path, "w:gz") as sdist:
                def add_top_level_file(name, content):
                    payload = content.encode("utf-8")
                    member = tarfile.TarInfo(f"runinfra-0.0.0/{name}")
                    member.size = len(payload)
                    sdist.addfile(member, io.BytesIO(payload))

                for name in sorted(verifier.SDIST_ALLOWED):
                    add_top_level_file(name, "placeholder\n")
                link = tarfile.TarInfo("evil-link")
                link.type = tarfile.SYMTYPE
                link.linkname = "runinfra-0.0.0/README.md"
                sdist.addfile(link)

            for archive_path, verify_archive in (
                (wheel_path, verifier.verify_wheel),
                (sdist_path, verifier.verify_sdist),
                (top_level_sdist_path, verifier.verify_sdist),
            ):
                with self.subTest(archive=archive_path.name):
                    with self.assertRaises(SystemExit) as raised:
                        verify_archive(archive_path)
                    self.assertEqual(raised.exception.code, 1)

    def test_public_methods_expose_typed_response_annotations(self):
        client = RunInfra(api_key="sk-ri-test", transport=RecordingTransport())

        self.assertEqual(
            get_type_hints(client.chat.completions.create)["return"],
            Union[ChatCompletionResponse, RunInfraStream],
        )
        self.assertEqual(
            get_type_hints(client.responses.create)["return"],
            Union[ResponsesCreateResponse, RunInfraStream],
        )
        self.assertIs(get_type_hints(client.embeddings.create)["return"], EmbeddingResponse)
        self.assertIs(get_type_hints(client.audio.transcriptions.create)["return"], TranscriptionResponse)
        self.assertIs(get_type_hints(client.images.generate)["return"], ImageGenerationResponse)
        self.assertIs(get_type_hints(client.models.list)["return"], ModelListResponse)
        self.assertIs(get_type_hints(client.models.retrieve)["return"], ModelObject)

    def test_streaming_methods_expose_literal_true_overloads(self):
        client = RunInfra(api_key="sk-ri-test", transport=RecordingTransport())

        for method, non_stream_response in (
            (client.chat.completions.create, ChatCompletionResponse),
            (client.responses.create, ResponsesCreateResponse),
        ):
            with self.subTest(method=method.__qualname__):
                overload_hints = [
                    get_type_hints(overload)
                    for overload in get_overloads(method)
                ]
                stream_returns = {
                    hints.get("stream"): hints.get("return")
                    for hints in overload_hints
                }

                if Literal[True] not in stream_returns:
                    class_source = inspect.getsource(method.__self__.__class__)
                    self.assertIn("stream: Literal[True]", class_source)
                    self.assertIn(") -> RunInfraStream: ...", class_source)
                    self.assertIn("stream: Literal[False] = False", class_source)
                    self.assertIn(f") -> {non_stream_response.__name__}: ...", class_source)
                    self.assertIn("stream: bool = False", class_source)
                    self.assertIn(
                        f") -> Union[{non_stream_response.__name__}, RunInfraStream]: ...",
                        class_source,
                    )
                    continue

                self.assertIs(stream_returns[Literal[True]], RunInfraStream)
                self.assertIs(stream_returns[Literal[False]], non_stream_response)
                self.assertEqual(
                    stream_returns[bool],
                    Union[non_stream_response, RunInfraStream],
                )

    def test_public_request_methods_do_not_accept_arbitrary_kwargs(self):
        client = RunInfra(api_key="sk-ri-test", transport=RecordingTransport())
        methods = [
            client.chat.completions.create,
            client.responses.create,
            client.embeddings.create,
            client.audio.speech.create,
            client.audio.transcriptions.create,
            client.images.generate,
            client.webhooks.verify_signature,
            client.webhooks.construct_event,
            client.voice.pipeline.create,
        ]

        for method in methods:
            with self.subTest(method=method):
                signature = inspect.signature(method)
                self.assertNotIn(
                    inspect.Parameter.VAR_KEYWORD,
                    {parameter.kind for parameter in signature.parameters.values()},
                )

    def test_responses_signature_exposes_only_gateway_supported_adapter_fields(self):
        client = RunInfra(api_key="sk-ri-test", transport=RecordingTransport())
        signature = inspect.signature(client.responses.create)

        for name in [
            "metadata",
            "store",
            "include",
            "reasoning",
            "previous_response_id",
            "user",
        ]:
            with self.subTest(name=name):
                self.assertNotIn(name, signature.parameters)

    def test_child_responses_param_canaries_use_supported_adapter_fields(self):
        root = Path(__file__).resolve().parents[2]
        typescript_canary = root.joinpath("scripts", "sdk-live-canary-typescript.mjs").read_text()
        python_canary = root.joinpath("scripts", "sdk-live-canary-python.py").read_text()
        typescript_block = re.search(
            r'await record\("openai\.params\.responses"[\s\S]*?await record\("responses\.stream\.final"',
            typescript_canary,
        )
        python_block = re.search(
            r"def _responses_params\([\s\S]*?def _responses_stream_final",
            python_canary,
        )

        self.assertIsNotNone(typescript_block)
        self.assertIsNotNone(python_block)
        self.assertIn("top_p: 1", typescript_block.group(0))
        self.assertNotIn("metadata", typescript_block.group(0))
        self.assertIn("top_p=1", python_block.group(0))
        self.assertNotIn("metadata", python_block.group(0))

    def test_runtime_package_source_does_not_define_kwargs_parameters(self):
        source_path = Path(runinfra.__file__).resolve()
        source = source_path.read_text()

        self.assertNotRegex(source, re.compile(r"def\s+\w+\([^)]*\*\*", re.DOTALL))

    def test_extra_body_is_the_explicit_escape_hatch_for_request_body_extensions(self):
        transport = RecordingTransport(json_response({"object": "response", "output_text": "hi"}))
        client = RunInfra(api_key="sk-ri-test", transport=transport)

        client.responses.create(
            model="llama-3.1-8b",
            input="Hi",
            extra_body={"runinfra_unsupported_parameter_probe": "must_error"},
        )

        self.assertIn(b'"runinfra_unsupported_parameter_probe":"must_error"', transport.calls[0].body)

    def test_extra_body_cannot_override_typed_request_fields(self):
        transport = RecordingTransport(json_response({"object": "response", "output_text": "hi"}))
        client = RunInfra(api_key="sk-ri-test", transport=transport)

        with self.assertRaisesRegex(RunInfraError, "extra_body must not override typed request field: model"):
            client.responses.create(
                model="llama-3.1-8b",
                input="Hi",
                extra_body={"model": "other"},
            )

        with self.assertRaisesRegex(RunInfraError, "extra_body must not override typed request field: stream"):
            client.responses.create(
                model="llama-3.1-8b",
                input="Hi",
                extra_body={"stream": True},
            )

        self.assertEqual(len(transport.calls), 0)

    def test_extra_body_is_not_exposed_on_multipart_asr(self):
        signature = inspect.signature(RunInfra(api_key="sk-ri-test").audio.transcriptions.create)

        self.assertNotIn("extra_body", signature.parameters)

    def test_pipeline_chat_uses_openai_compatible_path(self):
        transport = RecordingTransport(json_response({"choices": []}))
        client = RunInfra(
            api_key="sk-ri-test",
            pipeline_id="pipe-123",
            base_url="https://api.runinfra.ai/v1",
            transport=transport,
        )

        client.chat.completions.create(
            model="llama-3.1-8b",
            messages=[{"role": "user", "content": "Hi"}],
        )

        request = transport.calls[0]
        self.assertEqual(
            request.url,
            "https://api.runinfra.ai/v1/pipe-123/chat/completions",
        )
        self.assertEqual(request.headers["Authorization"], "Bearer sk-ri-test")
        self.assertEqual(request.headers["X-RunInfra-SDK"], "python")
        self.assertEqual(request.headers["X-RunInfra-SDK-Version"], __version__)

    def test_rejects_missing_api_keys_before_any_request_is_sent(self):
        with self.assertRaises(AuthenticationError):
            RunInfra(api_key="")
        with self.assertRaises(AuthenticationError):
            RunInfra(api_key="   ")

    def test_rejects_non_string_api_keys_before_any_request_is_sent(self):
        for api_key in (None, 123):
            with self.subTest(api_key=api_key):
                with self.assertRaisesRegex(RunInfraError, "api_key must be a string"):
                    RunInfra(api_key=api_key)  # type: ignore[arg-type]

    def test_normalizes_environment_style_api_keys_before_sending_authorization(self):
        transport = RecordingTransport(json_response({"object": "list", "data": []}))
        client = RunInfra(api_key=" \tsk-ri-test\n", transport=transport)

        client.models.list()

        self.assertEqual(transport.calls[0].headers["Authorization"], "Bearer sk-ri-test")

    def test_rejects_api_keys_with_non_printable_characters_after_trimming(self):
        with self.assertRaisesRegex(RunInfraError, "api_key must be ASCII"):
            RunInfra(api_key="sk-ri-\ntest")

    def test_rejects_unsafe_or_malformed_base_urls_before_sending_bearer_keys(self):
        for base_url in [
            "javascript:alert(1)",
            "file:///tmp/key",
            "ftp://runinfra.ai/api/v1",
            "not-a-url",
        ]:
            with self.subTest(base_url=base_url):
                with self.assertRaisesRegex(RunInfraError, "base_url must be an http or https URL"):
                    RunInfra(api_key="sk-ri-test", base_url=base_url)

    def test_rejects_non_string_base_urls_before_sending_bearer_keys(self):
        with self.assertRaisesRegex(RunInfraError, "base_url must be a string"):
            RunInfra(api_key="sk-ri-test", base_url=123)  # type: ignore[arg-type]

    def test_rejects_remote_cleartext_base_urls_but_permits_local_development_hosts(self):
        with self.assertRaisesRegex(RunInfraError, "Remote base_url must use https"):
            RunInfra(api_key="sk-ri-test", base_url="http://runinfra.ai/api/v1")

        for base_url in [
            "http://localhost:3000/api/v1",
            "http://127.0.0.1:3000/api/v1",
            "http://0.0.0.0:3000/api/v1",
            "http://[::1]:3000/api/v1",
        ]:
            with self.subTest(base_url=base_url):
                transport = RecordingTransport(json_response({"object": "list", "data": []}))
                client = RunInfra(
                    api_key="sk-ri-test",
                    base_url=base_url,
                    transport=transport,
                )

                client.models.list()

                self.assertEqual(transport.calls[0].url, f"{base_url}/models")

    def test_rejects_base_urls_with_embedded_credentials_before_sending_bearer_keys(self):
        for base_url in [
            "https://user:pass@runinfra.ai/api/v1",
            "https://user@runinfra.ai/api/v1",
            "http://user:pass@127.0.0.1:3000/api/v1",
        ]:
            with self.subTest(base_url=base_url):
                with self.assertRaisesRegex(RunInfraError, "base_url must not include credentials"):
                    RunInfra(api_key="sk-ri-test", base_url=base_url)

    def test_rejects_base_urls_with_query_strings_or_fragments_before_path_construction(self):
        for base_url in [
            "https://api.runinfra.ai/v1?api_key=secret",
            "https://api.runinfra.ai/v1#models",
        ]:
            with self.subTest(base_url=base_url):
                with self.assertRaisesRegex(
                    RunInfraError,
                    "base_url must not include query strings or fragments",
                ):
                    RunInfra(api_key="sk-ri-test", base_url=base_url)

    def test_pipeline_id_is_url_encoded(self):
        transport = RecordingTransport(json_response({"object": "list", "data": []}))
        client = RunInfra(
            api_key="sk-ri-test",
            pipeline_id="pipe/needs encoding",
            base_url="https://api.runinfra.ai/v1",
            transport=transport,
        )

        client.models.list()

        self.assertEqual(
            transport.calls[0].url,
            "https://api.runinfra.ai/v1/pipe%2Fneeds%20encoding/models",
        )

    def test_rejects_blank_pipeline_ids_before_any_request_is_sent(self):
        with self.assertRaisesRegex(RunInfraError, "pipeline_id must not be blank"):
            RunInfra(api_key="sk-ri-test", pipeline_id="   ")

    def test_pipeline_id_is_not_double_appended_when_base_url_is_already_scoped(self):
        transport = RecordingTransport(json_response({"object": "list", "data": []}))
        client = RunInfra(
            api_key="sk-ri-test",
            pipeline_id="pipe-123",
            base_url="https://api.runinfra.ai/v1/pipe-123",
            transport=transport,
        )

        client.models.list()

        self.assertEqual(
            transport.calls[0].url,
            "https://api.runinfra.ai/v1/pipe-123/models",
        )

    def test_workspace_embeddings_do_not_require_pipeline_id(self):
        transport = RecordingTransport(json_response({"data": []}))
        client = RunInfra(api_key="sk-ri-test", transport=transport)

        client.embeddings.create(model="bge-m3", input=["a", "b"])

        self.assertEqual(transport.calls[0].url, "https://api.runinfra.ai/v1/embeddings")

    def test_embedding_passes_through_float_format_and_dimensions(self):
        transport = RecordingTransport(json_response({"data": [{"embedding": [0.1, 0.2], "index": 0}]}))
        client = RunInfra(api_key="sk-ri-test", transport=transport)

        client.embeddings.create(
            model="bge-m3",
            input="hello",
            encoding_format="float",
            dimensions=256,
        )

        self.assertEqual(
            json.loads(transport.calls[0].body.decode("utf-8")),
            {
                "model": "bge-m3",
                "input": "hello",
                "encoding_format": "float",
                "dimensions": 256,
            },
        )

    def test_voice_pipeline_posts_audio_to_verified_pipeline_route(self):
        transport = RecordingTransport(json_response({
            "transcript": "what is my balance",
            "responseText": "Your balance is current.",
        }))
        client = RunInfra(
            api_key="sk-ri-test",
            pipeline_id="pipe-voice",
            transport=transport,
        )

        result = client.voice.pipeline.create(
            audio=b"\x01\x02\x03",
            mime_type="audio/wav",
            request_options={"idempotency_key": "idem-voice"},
        )

        self.assertEqual(result["transcript"], "what is my balance")
        self.assertEqual(result["responseText"], "Your balance is current.")
        self.assertEqual(
            transport.calls[0].url,
            "https://api.runinfra.ai/v1/pipe-voice/pipeline",
        )
        self.assertEqual(transport.calls[0].body, b"\x01\x02\x03")
        self.assertEqual(transport.calls[0].headers["Content-Type"], "audio/wav")
        self.assertEqual(transport.calls[0].headers["Accept"], "application/json")
        self.assertEqual(transport.calls[0].headers["Idempotency-Key"], "idem-voice")

    def test_voice_pipeline_requires_pipeline_scoped_client_before_sending(self):
        transport = RecordingTransport(json_response({}))
        client = RunInfra(api_key="sk-ri-test", transport=transport)

        with self.assertRaisesRegex(
            RunInfraError,
            "voice pipeline requests require pipeline_id or a pipeline-scoped base_url",
        ):
            client.voice.pipeline.create(audio=b"\x01\x02\x03", mime_type="audio/wav")

        self.assertEqual(transport.calls, [])

    def test_rejects_blank_inference_model_ids_before_sending(self):
        cases = (
            lambda client: client.chat.completions.create(
                model="   ",
                messages=[{"role": "user", "content": "Hi"}],
            ),
            lambda client: client.responses.create(model="   ", input="Hi"),
            lambda client: client.embeddings.create(model="   ", input="Hi"),
            lambda client: client.audio.speech.create(
                model="   ",
                input="Hi",
                voice="default",
            ),
            lambda client: client.audio.transcriptions.create(
                model="   ",
                file=b"\x00",
            ),
            lambda client: client.images.generate(model="   ", prompt="cat"),
        )

        for run_case in cases:
            with self.subTest(run_case=run_case):
                transport = RecordingTransport(json_response({}))
                client = RunInfra(api_key="sk-ri-test", transport=transport)

                with self.assertRaises(RunInfraError) as caught:
                    run_case(client)

                self.assertEqual(caught.exception.type, "invalid_request_options")
                self.assertEqual(str(caught.exception), "model must not be blank")
                self.assertEqual(transport.calls, [])

    def test_rejects_non_string_inference_model_ids_before_sending(self):
        transport = RecordingTransport(json_response({}))
        client = RunInfra(api_key="sk-ri-test", transport=transport)

        with self.assertRaises(RunInfraError) as caught:
            client.embeddings.create(model=123, input="Hi")  # type: ignore[arg-type]

        self.assertEqual(caught.exception.type, "invalid_request_options")
        self.assertEqual(str(caught.exception), "model must be a string")
        self.assertEqual(transport.calls, [])

    def test_rejects_invalid_required_inference_payload_fields_before_sending(self):
        cases = (
            (
                lambda client: client.chat.completions.create(
                    model="llama",
                    messages=[],
                ),
                "messages must be a non-empty array",
            ),
            (
                lambda client: client.chat.completions.create(
                    model="llama",
                    messages=["bad"],
                ),
                "messages[0] must be an object with a non-empty role",
            ),
            (
                lambda client: client.chat.completions.create(
                    model="llama",
                    messages=[{}],
                ),
                "messages[0] must be an object with a non-empty role",
            ),
            (
                lambda client: client.responses.create(model="llama", input="   "),
                "input must be a non-empty string or array",
            ),
            (
                lambda client: client.responses.create(model="llama", input=["bad"]),
                "input[0] must be an object",
            ),
            (
                lambda client: client.embeddings.create(model="bge-m3", input=[]),
                "input must be a non-empty string or array of strings",
            ),
            (
                lambda client: client.audio.speech.create(
                    model="kokoro",
                    input="   ",
                    voice="default",
                ),
                "input must be a non-empty string",
            ),
            (
                lambda client: client.audio.speech.create(
                    model="kokoro",
                    input="hello",
                    voice="   ",
                ),
                "voice must be a non-empty string",
            ),
            (
                lambda client: client.audio.transcriptions.create(
                    model="whisper",
                    file=None,  # type: ignore[arg-type]
                ),
                "file must be bytes or bytearray",
            ),
            (
                lambda client: client.images.generate(model="flux", prompt="   "),
                "prompt must be a non-empty string",
            ),
            (
                lambda client: client.responses.create(
                    model="llama",
                    input="Hi",
                    extra_body={"metadata": {"value": math.nan}},
                ),
                "JSON request body must be serializable and contain only finite numbers",
            ),
            (
                lambda client: client.responses.create(
                    model="llama",
                    input="Hi",
                    extra_body={"metadata": object()},
                ),
                "JSON request body must be serializable and contain only finite numbers",
            ),
        )

        for run_case, message in cases:
            with self.subTest(message=message):
                transport = RecordingTransport(json_response({}))
                client = RunInfra(api_key="sk-ri-test", transport=transport)

                with self.assertRaises(RunInfraError) as caught:
                    run_case(client)

                self.assertEqual(caught.exception.type, "invalid_request_options")
                self.assertEqual(str(caught.exception), message)
                self.assertEqual(transport.calls, [])

    def test_pipeline_responses_uses_openai_compatible_path(self):
        transport = RecordingTransport(json_response({"object": "response", "output_text": "hi"}))
        client = RunInfra(
            api_key="sk-ri-test",
            pipeline_id="pipe-123",
            base_url="https://api.runinfra.ai/v1",
            transport=transport,
        )

        client.responses.create(
            model="llama-3.1-8b",
            input="Hi",
            max_output_tokens=64,
        )

        self.assertEqual(
            transport.calls[0].url,
            "https://api.runinfra.ai/v1/pipe-123/responses",
        )
        self.assertIn(b'"max_output_tokens":64', transport.calls[0].body)

    def test_request_options_add_trace_and_idempotency_headers_only(self):
        transport = RecordingTransport(json_response({"object": "response", "output_text": "hi"}))
        client = RunInfra(
            api_key="sk-ri-test",
            pipeline_id="pipe-123",
            transport=transport,
        )

        client.responses.create(
            model="llama-3.1-8b",
            input="Hi",
            request_options={
                "client_request_id": "req-user-123",
                "idempotency_key": "idem-user-123",
                "headers": {"X-RunInfra-Test": "trace"},
            },
        )

        request = transport.calls[0]
        self.assertEqual(request.headers["X-Client-Request-Id"], "req-user-123")
        self.assertEqual(request.headers["Idempotency-Key"], "idem-user-123")
        self.assertEqual(request.headers["X-RunInfra-Test"], "trace")
        self.assertNotIn(b"request_options", request.body)

    def test_request_options_accept_custom_header_mappings(self):
        transport = RecordingTransport(json_response({"object": "response", "output_text": "hi"}))
        client = RunInfra(api_key="sk-ri-test", transport=transport)

        client.responses.create(
            model="llama-3.1-8b",
            input="Hi",
            request_options={
                "headers": UserDict({"X-RunInfra-App": "worker-a"}),
            },
        )

        request = transport.calls[0]
        self.assertEqual(request.headers["X-RunInfra-App"], "worker-a")

    def test_rejects_blank_client_request_ids_and_idempotency_keys_before_sending(self):
        transport = RecordingTransport(json_response({"object": "response"}))
        client = RunInfra(api_key="sk-ri-test", transport=transport)

        for request_options in (
            {"client_request_id": "   "},
            {"idempotency_key": "   "},
        ):
            with self.subTest(request_options=request_options):
                with self.assertRaises(RunInfraError) as caught:
                    client.responses.create(
                        model="llama-3.1-8b",
                        input="Hi",
                        request_options=request_options,
                    )
                self.assertEqual(caught.exception.type, "invalid_request_options")

        self.assertEqual(len(transport.calls), 0)

    def test_rejects_idempotency_keys_over_255_characters_before_sending(self):
        transport = RecordingTransport(json_response({"object": "response"}))
        client = RunInfra(api_key="sk-ri-test", transport=transport)

        with self.assertRaises(RunInfraError) as caught:
            client.responses.create(
                model="llama-3.1-8b",
                input="Hi",
                request_options={"idempotency_key": "i" * 256},
            )

        self.assertEqual(caught.exception.type, "invalid_request_options")
        self.assertEqual(
            str(caught.exception),
            "idempotency_key must be ASCII and 255 characters or less",
        )
        self.assertEqual(len(transport.calls), 0)

    def test_rejects_custom_headers_that_try_to_override_sdk_controlled_headers(self):
        transport = RecordingTransport(json_response({"object": "response"}))
        client = RunInfra(api_key="sk-ri-test", transport=transport)

        with self.assertRaises(RunInfraError) as caught:
            client.responses.create(
                model="llama-3.1-8b",
                input="Hi",
                request_options={
                    "headers": {
                        "authorization": "Bearer attacker",
                        "X-RunInfra-Test": "trace",
                    }
                },
            )

        self.assertEqual(caught.exception.type, "invalid_request_options")
        self.assertEqual(len(transport.calls), 0)

    def test_rejects_custom_transport_and_credential_headers_before_sending(self):
        transport = RecordingTransport(json_response({"object": "response"}))
        client = RunInfra(api_key="sk-ri-test", transport=transport)

        for header_name in (
            "Host",
            "Cookie",
            "Content-Length",
            "Transfer-Encoding",
            "Connection",
            "Proxy-Authorization",
            "X-API-Key",
            "Api-Key",
            "X-Auth-Token",
            "X-Access-Token",
        ):
            with self.subTest(header_name=header_name):
                with self.assertRaisesRegex(
                    RunInfraError,
                    f"{header_name} is controlled by the RunInfra SDK",
                ):
                    client.responses.create(
                        model="llama-3.1-8b",
                        input="Hi",
                        request_options={"headers": {header_name: "bad"}},
                    )

        self.assertEqual(len(transport.calls), 0)

    def test_rejects_non_mapping_custom_headers_before_sending(self):
        transport = RecordingTransport(json_response({"object": "response"}))
        client = RunInfra(api_key="sk-ri-test", transport=transport)

        for headers in ("bad", ["bad"]):
            with self.subTest(headers=headers):
                with self.assertRaisesRegex(
                    RunInfraError,
                    "headers must be a mapping of string names to string values",
                ):
                    client.responses.create(
                        model="llama-3.1-8b",
                        input="Hi",
                        request_options={"headers": headers},  # type: ignore[dict-item]
                    )

        self.assertEqual(len(transport.calls), 0)

    def test_rejects_custom_header_values_with_control_characters_before_sending(self):
        transport = RecordingTransport(json_response({"object": "response"}))
        client = RunInfra(api_key="sk-ri-test", transport=transport)

        with self.assertRaises(RunInfraError) as caught:
            client.responses.create(
                model="llama-3.1-8b",
                input="Hi",
                request_options={"headers": {"X-RunInfra-Test": "bad\r\nvalue"}},
            )

        self.assertEqual(caught.exception.type, "invalid_request_options")
        self.assertEqual(len(transport.calls), 0)

    def test_rejects_invalid_constructor_retry_and_timeout_options(self):
        transport = RecordingTransport(json_response({"object": "response"}))

        for kwargs in (
            {"timeout_seconds": 0},
            {"max_retries": -1},
            {"retry_base_seconds": -1},
        ):
            with self.subTest(kwargs=kwargs):
                with self.assertRaises(RunInfraError) as caught:
                    RunInfra(api_key="sk-ri-test", transport=transport, **kwargs)
                self.assertEqual(caught.exception.type, "invalid_request_options")

        self.assertEqual(len(transport.calls), 0)

    def test_rejects_invalid_custom_transport_before_any_request_is_sent(self):
        for transport in (object(), ""):
            with self.subTest(transport=transport):
                with self.assertRaisesRegex(RunInfraError, "transport must be callable"):
                    RunInfra(api_key="sk-ri-test", transport=transport)  # type: ignore[arg-type]

    def test_rejects_invalid_per_request_retry_and_timeout_options_before_sending(self):
        transport = RecordingTransport(json_response({"object": "response"}))
        client = RunInfra(api_key="sk-ri-test", transport=transport)

        for request_options in (
            {"timeout_seconds": 0},
            {"max_retries": -1},
            {"retry_base_seconds": -1},
        ):
            with self.subTest(request_options=request_options):
                with self.assertRaises(RunInfraError) as caught:
                    client.responses.create(
                        model="llama-3.1-8b",
                        input="Hi",
                        request_options=request_options,
                    )
                self.assertEqual(caught.exception.type, "invalid_request_options")

        self.assertEqual(len(transport.calls), 0)

    def test_rejects_non_mapping_request_options_before_sending(self):
        transport = RecordingTransport(json_response({"object": "response"}))
        client = RunInfra(api_key="sk-ri-test", transport=transport)

        for request_options in ("bad", ["bad"]):
            with self.subTest(request_options=request_options):
                with self.assertRaisesRegex(RunInfraError, "request_options must be a mapping"):
                    client.responses.create(
                        model="llama-3.1-8b",
                        input="Hi",
                        request_options=request_options,  # type: ignore[arg-type]
                    )

        self.assertEqual(len(transport.calls), 0)

    def test_rejects_unknown_request_option_keys_before_sending(self):
        transport = RecordingTransport(json_response({"object": "response"}))
        client = RunInfra(api_key="sk-ri-test", transport=transport)

        for request_options, message in (
            ({"idempotency_key_typo": "idem-123"}, "Unknown request option: idempotency_key_typo"),
            ({"timeoutMs": 20_000}, "Unknown request option: timeoutMs"),
        ):
            with self.subTest(request_options=request_options):
                with self.assertRaisesRegex(RunInfraError, message):
                    client.responses.create(
                        model="llama-3.1-8b",
                        input="Hi",
                        request_options=request_options,
                    )

        self.assertEqual(len(transport.calls), 0)

    def test_rejects_conflicting_request_option_aliases_before_sending(self):
        transport = RecordingTransport(json_response({"object": "response"}))
        client = RunInfra(api_key="sk-ri-test", transport=transport)

        for request_options, message in (
            (
                {"idempotency_key": "idem-a", "idempotencyKey": "idem-b"},
                "Conflicting request option aliases: idempotency_key, idempotencyKey",
            ),
            (
                {"max_retries": 0, "maxRetries": 1},
                "Conflicting request option aliases: max_retries, maxRetries",
            ),
            (
                {"retry_base_seconds": 0, "retryBaseSeconds": 1},
                "Conflicting request option aliases: retry_base_seconds, retryBaseSeconds",
            ),
            (
                {"timeout_seconds": 20, "timeoutSeconds": 30},
                "Conflicting request option aliases: timeout_seconds, timeoutSeconds",
            ),
            (
                {"client_request_id": "req-a", "clientRequestId": "req-b"},
                "Conflicting request option aliases: client_request_id, clientRequestId",
            ),
        ):
            with self.subTest(request_options=request_options):
                with self.assertRaisesRegex(RunInfraError, message):
                    client.responses.create(
                        model="llama-3.1-8b",
                        input="Hi",
                        request_options=request_options,
                    )

        self.assertEqual(len(transport.calls), 0)

    def test_successful_json_responses_include_server_request_id(self):
        transport = RecordingTransport(
            RunInfraResponse(
                200,
                {
                    "content-type": "application/json",
                    "x-request-id": "req-server-123",
                    "x-runinfra-idempotent-replay": "true",
                },
                json.dumps({"object": "list", "data": []}).encode("utf-8"),
            )
        )
        client = RunInfra(api_key="sk-ri-test", transport=transport)

        response = client.models.list()

        self.assertEqual(response["_request_id"], "req-server-123")
        self.assertTrue(response["_idempotent_replay"])

    def test_request_ids_are_header_case_insensitive(self):
        transport = RecordingTransport(
            RunInfraResponse(
                200,
                {"content-type": "application/json", "X-REQUEST-ID": "req-json-case"},
                json.dumps({"object": "list", "data": []}).encode("utf-8"),
            ),
            RunInfraResponse(
                200,
                {"content-type": "text/event-stream", "X-REQUEST-ID": "req-stream-case"},
                b'data: {"type":"response.completed","response":{"status":"completed"}}\n\n',
            ),
            RunInfraResponse(
                200,
                {"Content-Type": "audio/mpeg", "X-REQUEST-ID": "req-audio-case"},
                b"\x01\x02",
            ),
        )
        client = RunInfra(api_key="sk-ri-test", transport=transport)

        self.assertEqual(client.models.list()["_request_id"], "req-json-case")
        stream = client.responses.create(model="llama-3.1-8b", input="Hi", stream=True)
        self.assertEqual(stream.request_id, "req-stream-case")
        self.assertEqual(
            list(stream),
            [{"type": "response.completed", "response": {"status": "completed"}}],
        )
        audio = client.audio.speech.create(model="kokoro", input="hello", voice="default")
        self.assertEqual(audio.request_id, "req-audio-case")

    def test_rejects_malformed_json_response_shapes_before_returning_user_data(self):
        transport = RecordingTransport(
            RunInfraResponse(
                200,
                {"content-type": "application/json", "x-request-id": "req-raw-text"},
                json.dumps("OK.").encode("utf-8"),
            )
        )
        client = RunInfra(
            api_key="sk-ri-test",
            pipeline_id="pipe-chat",
            transport=transport,
        )

        with self.assertRaises(RunInfraError) as raised:
            client.chat.completions.create(
                model="llama-3.1-8b",
                messages=[{"role": "user", "content": "Hi"}],
            )

        self.assertEqual(raised.exception.status, 200)
        self.assertEqual(raised.exception.type, "response_shape_error")
        self.assertEqual(raised.exception.request_id, "req-raw-text")

    def test_tts_returns_binary_audio(self):
        transport = RecordingTransport(
            RunInfraResponse(
                200,
                {"content-type": "audio/mpeg", "x-request-id": "req-audio-123"},
                b"\x01\x02",
            )
        )
        client = RunInfra(
            api_key="sk-ri-test",
            pipeline_id="pipe-tts",
            transport=transport,
        )

        audio = client.audio.speech.create(
            model="kokoro",
            input="hello",
            voice="default",
        )

        self.assertEqual(audio.content_type, "audio/mpeg")
        self.assertEqual(audio.request_id, "req-audio-123")
        self.assertEqual(audio.content, b"\x01\x02")

    def test_tts_allows_reference_audio_without_configured_voice(self):
        transport = RecordingTransport(
            RunInfraResponse(200, {"content-type": "audio/wav"}, b"\x01\x02")
        )
        client = RunInfra(
            api_key="sk-ri-test",
            pipeline_id="pipe-tts",
            transport=transport,
        )

        client.audio.speech.create(
            model="qwen3-tts",
            input="hello",
            task_type="Base",
            ref_audio="https://example.com/ref.wav",
            ref_text="reference voice text",
        )

        self.assertEqual(
            json.loads(transport.calls[0].body.decode("utf-8")),
            {
                "model": "qwen3-tts",
                "input": "hello",
                "task_type": "Base",
                "ref_audio": "https://example.com/ref.wav",
                "ref_text": "reference voice text",
            },
        )

    def test_transcription_uses_multipart(self):
        transport = RecordingTransport(json_response({"text": "hello"}))
        client = RunInfra(
            api_key="sk-ri-test",
            pipeline_id="pipe-asr",
            transport=transport,
        )

        client.audio.transcriptions.create(
            model="whisper-large-v3",
            file=b"abc",
            filename="clip.wav",
        )

        request = transport.calls[0]
        self.assertIn("multipart/form-data", request.headers["Content-Type"])
        self.assertIn(b'name="model"', request.body)
        self.assertIn(b'name="file"; filename="clip.wav"', request.body)

    def test_transcription_rejects_empty_audio_before_network(self):
        transport = RecordingTransport(json_response({"text": "hello"}))
        client = RunInfra(
            api_key="sk-ri-test",
            pipeline_id="pipe-asr",
            transport=transport,
        )

        for file_value in (b"", bytearray()):
            with self.subTest(file_type=type(file_value).__name__):
                with self.assertRaises(RunInfraError) as raised:
                    client.audio.transcriptions.create(
                        model="whisper-large-v3",
                        file=file_value,
                        filename="clip.wav",
                    )
                self.assertEqual(raised.exception.type, "invalid_request_options")
                self.assertEqual(str(raised.exception), "file must not be empty")

        self.assertEqual(transport.calls, [])

    def test_transcription_rejects_unsafe_multipart_metadata_before_network(self):
        transport = RecordingTransport(json_response({"text": "hello"}))
        client = RunInfra(
            api_key="sk-ri-test",
            pipeline_id="pipe-asr",
            transport=transport,
        )

        cases = [
            {"filename": 'clip"\r\nX-Bad: 1.wav'},
            {"content_type": "audio/wav\r\nX-Bad: 1"},
            {"temperature": {"value": 0}},
            {"prompt": ["bad"]},
            {"temperature": math.nan},
            {"temperature": math.inf},
        ]

        for kwargs in cases:
            with self.subTest(kwargs=kwargs):
                with self.assertRaises(RunInfraError) as raised:
                    client.audio.transcriptions.create(
                        model="whisper-large-v3",
                        file=b"abc",
                        **kwargs,
                    )
                self.assertEqual(raised.exception.type, "invalid_request_options")

        self.assertEqual(transport.calls, [])

    def test_native_embedding_rejects_response_shapes_it_cannot_type_before_network(self):
        transport = RecordingTransport(json_response({}))
        client = RunInfra(api_key="sk-ri-test", transport=transport)

        with self.assertRaises(RunInfraError) as raised:
            client.embeddings.create(model="bge-m3", input="hello", encoding_format="base64")
        self.assertEqual(raised.exception.type, "invalid_request_options")
        self.assertEqual(
            str(raised.exception),
            "embedding encoding_format must be float for native SDK typed responses",
        )

        with self.assertRaises(RunInfraError) as raised:
            client.embeddings.create(model="bge-m3", input="hello", dimensions=0)
        self.assertEqual(raised.exception.type, "invalid_request_options")
        self.assertEqual(str(raised.exception), "embedding dimensions must be a positive integer")
        self.assertEqual(transport.calls, [])

    def test_native_asr_rejects_response_formats_it_cannot_parse_before_network(self):
        transport = RecordingTransport(json_response({"text": "hello"}))
        client = RunInfra(api_key="sk-ri-test", transport=transport)

        with self.assertRaises(RunInfraError) as raised:
            client.audio.transcriptions.create(
                model="whisper-large-v3",
                file=b"abc",
                response_format="text",
            )
        self.assertEqual(raised.exception.type, "invalid_request_options")
        self.assertEqual(
            str(raised.exception),
            "audio transcription response_format must be json or verbose_json for native SDK typed responses",
        )
        self.assertEqual(transport.calls, [])

    def test_typed_errors_and_retries(self):
        transport = RecordingTransport(
            json_response({"error": {"message": "busy"}}, status=503),
            json_response({"object": "list", "data": []}),
            json_response(
                {"error": {"message": "Invalid API key", "type": "auth_error"}},
                status=401,
            ),
            json_response(
                {"error": {"message": "slow down", "type": "rate_limit_error"}},
                status=429,
            ),
            json_response({"object": "list", "data": []}),
        )
        client = RunInfra(
            api_key="sk-ri-test",
            transport=transport,
            max_retries=1,
            retry_base_seconds=0,
        )

        self.assertEqual(client.models.list()["data"], [])
        with self.assertRaises(AuthenticationError):
            client.models.list()
        self.assertEqual(client.models.list()["data"], [])

    def test_retries_close_failed_response_bodies_before_retrying(self):
        class CloseableBody:
            def __init__(self):
                self.closed = False

            def __iter__(self):
                yield b'{"error":{"message":"busy"}}'

            def close(self):
                self.closed = True

        failed_body = CloseableBody()
        transport = RecordingTransport(
            RunInfraResponse(503, {"content-type": "application/json"}, failed_body),
            json_response({"object": "list", "data": []}),
        )
        client = RunInfra(
            api_key="sk-ri-test",
            transport=transport,
            max_retries=1,
            retry_base_seconds=0,
        )

        self.assertEqual(client.models.list()["data"], [])

        self.assertTrue(failed_body.closed)
        self.assertEqual(len(transport.calls), 2)

    def test_retries_respect_http_date_retry_after_headers(self):
        retry_at = formatdate(1_700_000_010, usegmt=True)
        transport = RecordingTransport(
            RunInfraResponse(
                503,
                {"Retry-After": retry_at},
                json.dumps({"error": {"message": "busy"}}).encode("utf-8"),
            ),
            json_response({"object": "list", "data": []}),
        )
        client = RunInfra(
            api_key="sk-ri-test",
            transport=transport,
            max_retries=1,
            retry_base_seconds=0.25,
        )

        with patch("runinfra.time.time", return_value=1_700_000_000), patch(
            "runinfra.time.sleep"
        ) as sleep:
            self.assertEqual(client.models.list()["data"], [])

        sleep.assert_called_once_with(10.0)
        self.assertEqual(len(transport.calls), 2)

    def test_a_retry_after_above_the_longest_wait_is_raised_at_once_with_the_wait(self):
        transport = RecordingTransport(
            RunInfraResponse(
                503,
                {"Retry-After": "120"},
                json.dumps({"error": {"message": "busy"}}).encode("utf-8"),
            ),
            json_response({"object": "list", "data": []}),
        )
        client = RunInfra(
            api_key="sk-ri-test",
            transport=transport,
            max_retries=1,
            retry_base_seconds=0.25,
        )

        # Nothing is slept, and no second request is sent sooner than the API asked.
        with patch("runinfra.time.sleep") as sleep, self.assertRaises(RunInfraError) as raised:
            client.models.list()

        sleep.assert_not_called()
        self.assertEqual(len(transport.calls), 1)
        self.assertEqual((raised.exception.status, raised.exception.retry_after_seconds), (503, 120.0))

    def test_retries_ignore_non_plain_retry_after_delay_seconds(self):
        for retry_after in ["-1", "+1", "1.5", "0x10", "Infinity"]:
            with self.subTest(retry_after=retry_after):
                transport = RecordingTransport(
                    RunInfraResponse(
                        503,
                        {"Retry-After": retry_after},
                        json.dumps({"error": {"message": "busy"}}).encode("utf-8"),
                    ),
                    json_response({"object": "list", "data": []}),
                )
                client = RunInfra(
                    api_key="sk-ri-test",
                    transport=transport,
                    max_retries=1,
                    retry_base_seconds=0.25,
                )

                with patch("runinfra.time.sleep") as sleep, patch("runinfra.random.random", return_value=0.0):
                    self.assertEqual(client.models.list()["data"], [])

                sleep.assert_called_once_with(0.25)
                self.assertEqual(len(transport.calls), 2)

    def test_rate_limit_errors_expose_retry_after_seconds(self):
        transport = RecordingTransport(
            json_response(
                {"error": {"message": "slow down", "type": "rate_limit_error"}},
                status=429,
                headers={"Retry-After": "2"},
            )
        )
        client = RunInfra(api_key="sk-ri-test", transport=transport, max_retries=0)

        with self.assertRaises(RateLimitError) as raised:
            client.models.list()

        self.assertEqual(raised.exception.retry_after_seconds, 2.0)

    def test_status_mapped_errors_expose_stable_sdk_error_types(self):
        cases = (
            (401, AuthenticationError, "auth_error"),
            (403, PermissionDeniedError, "permission_denied"),
            (402, InsufficientCreditsError, "insufficient_credits"),
            (404, ModelNotFoundError, "model_not_found"),
            (429, RateLimitError, "rate_limit_error"),
        )

        for status, error_class, expected_type in cases:
            with self.subTest(status=status):
                transport = RecordingTransport(
                    json_response(
                        {"error": {"message": "mapped", "type": "api_error"}},
                        status=status,
                    )
                )
                client = RunInfra(
                    api_key="sk-ri-test",
                    transport=transport,
                    max_retries=0,
                )

                with self.assertRaises(error_class) as raised:
                    client.models.list()

                self.assertEqual(raised.exception.type, expected_type)

    def test_permission_denied_preserves_gateway_discriminator(self):
        transport = RecordingTransport(
            json_response(
                {
                    "error": {
                        "message": "Deploying endpoints requires a Core or Enterprise plan.",
                        "type": "byoc_plan_required",
                    }
                },
                status=403,
                headers={"x-request-id": "req-byoc"},
            )
        )
        client = RunInfra(api_key="sk-ri-test", transport=transport, max_retries=0)

        with self.assertRaises(PermissionDeniedError) as raised:
            client.models.list()

        self.assertEqual(raised.exception.type, "byoc_plan_required")
        self.assertEqual(raised.exception.status, 403)
        self.assertEqual(raised.exception.request_id, "req-byoc")

    def test_insufficient_credits_exposes_structured_topup_fields(self):
        transport = RecordingTransport(
            json_response(
                {
                    "error": {
                        "message": "Insufficient credits to run this request.",
                        "type": "insufficient_credits",
                        "current_balance_cents": 125,
                        "required_cents": 500,
                        "topup_url": "/settings/cost#credits",
                    }
                },
                status=402,
                headers={"x-request-id": "req-credits"},
            )
        )
        client = RunInfra(api_key="sk-ri-test", transport=transport, max_retries=0)

        with self.assertRaises(InsufficientCreditsError) as raised:
            client.models.list()

        self.assertEqual(raised.exception.current_balance_cents, 125)
        self.assertEqual(raised.exception.required_cents, 500)
        self.assertEqual(raised.exception.topup_url, "/settings/cost#credits")
        self.assertEqual(raised.exception.request_id, "req-credits")

    def test_insufficient_credits_topup_fields_default_to_none(self):
        transport = RecordingTransport(
            json_response(
                {"error": {"message": "Insufficient credits.", "type": "insufficient_credits"}},
                status=402,
            )
        )
        client = RunInfra(api_key="sk-ri-test", transport=transport, max_retries=0)

        with self.assertRaises(InsufficientCreditsError) as raised:
            client.models.list()

        self.assertIsNone(raised.exception.current_balance_cents)
        self.assertIsNone(raised.exception.required_cents)
        self.assertIsNone(raised.exception.topup_url)

    def test_gateway_deployment_errors_keep_deployment_error_type(self):
        transport = RecordingTransport(
            json_response(
                {"error": {"message": "endpoint not verified", "type": "deployment_error"}},
                status=409,
            )
        )
        client = RunInfra(api_key="sk-ri-test", transport=transport, max_retries=0)

        with self.assertRaises(DeploymentError) as raised:
            client.models.list()

        self.assertEqual(raised.exception.type, "deployment_error")

    def test_errors_preserve_api_code_and_parameter_metadata(self):
        transport = RecordingTransport(
            json_response(
                {
                    "error": {
                        "message": "The embeddings parameter 'dimensions' is not supported.",
                        "type": "invalid_request_error",
                        "code": "unsupported_parameter",
                        "param": "dimensions",
                    }
                },
                status=400,
                headers={"x-request-id": "req-dimensions"},
            )
        )
        client = RunInfra(api_key="sk-ri-test", transport=transport, max_retries=0)

        with self.assertRaises(RunInfraError) as raised:
            client.embeddings.create(
                model="bge-small",
                input="hello",
                dimensions=1,
            )

        self.assertEqual(raised.exception.status, 400)
        self.assertEqual(raised.exception.type, "invalid_request_error")
        self.assertEqual(raised.exception.code, "unsupported_parameter")
        self.assertEqual(raised.exception.param, "dimensions")
        self.assertEqual(raised.exception.request_id, "req-dimensions")

    def test_redacts_api_keys_from_status_error_metadata_fields(self):
        api_key = "sk-ri-redact-local"
        transport = RecordingTransport(
            json_response(
                {
                    "error": {
                        "message": "metadata redaction canary",
                        "type": "invalid_request_error",
                        "code": f"unsupported_{api_key}",
                        "param": f"field_{api_key}",
                    }
                },
                status=400,
                headers={"x-request-id": "req-status-metadata-redact"},
            )
        )
        client = RunInfra(
            api_key=api_key,
            transport=transport,
            max_retries=0,
            retry_base_seconds=0,
        )

        with self.assertRaises(RunInfraError) as raised:
            client.models.list()

        self.assertEqual(raised.exception.status, 400)
        self.assertEqual(raised.exception.type, "invalid_request_error")
        self.assertEqual(raised.exception.code, "unsupported_[redacted]")
        self.assertEqual(raised.exception.param, "field_[redacted]")
        self.assertEqual(raised.exception.request_id, "req-status-metadata-redact")
        self.assertSecretNotInExceptionChain(raised.exception, api_key)

    def test_request_options_can_disable_retries_for_cost_sensitive_calls(self):
        transport = RecordingTransport(
            json_response({"error": {"message": "busy"}}, status=503),
            json_response({"object": "list", "data": []}),
        )
        client = RunInfra(
            api_key="sk-ri-test",
            transport=transport,
            max_retries=1,
            retry_base_seconds=0,
        )

        with self.assertRaises(RunInfraError):
            client.responses.create(
                model="llama-3.1-8b",
                input="Hi",
                request_options={"max_retries": 0, "retry_base_seconds": 0},
            )

        self.assertEqual(len(transport.calls), 1)

    def test_post_retries_require_idempotency_key(self):
        transport = RecordingTransport(
            json_response({"error": {"message": "busy"}}, status=503),
            json_response({"id": "resp_123"}),
        )
        client = RunInfra(
            api_key="sk-ri-test",
            transport=transport,
            max_retries=1,
            retry_base_seconds=0,
        )

        with self.assertRaises(RunInfraError) as raised:
            client.responses.create(model="llama-3.1-8b", input="Hi")

        self.assertEqual(raised.exception.status, 503)
        self.assertEqual(len(transport.calls), 1)

        retry_safe_transport = RecordingTransport(
            json_response({"error": {"message": "busy"}}, status=503),
            json_response({"id": "resp_123"}),
        )
        retry_safe_client = RunInfra(
            api_key="sk-ri-test",
            transport=retry_safe_transport,
            max_retries=1,
            retry_base_seconds=0,
        )

        result = retry_safe_client.responses.create(
            model="llama-3.1-8b",
            input="Hi",
            request_options={"idempotency_key": "idem-resp-123"},
        )

        self.assertEqual(result["id"], "resp_123")
        self.assertEqual(len(retry_safe_transport.calls), 2)

    def test_non_replayable_json_posts_do_not_retry_with_idempotency_key(self):
        embeddings_transport = RecordingTransport(
            json_response({"error": {"message": "busy"}}, status=503),
            json_response({"object": "list", "data": []}),
        )
        embeddings_client = RunInfra(
            api_key="sk-ri-test",
            transport=embeddings_transport,
            max_retries=1,
            retry_base_seconds=0,
        )

        with self.assertRaises(RunInfraError) as embeddings_error:
            embeddings_client.embeddings.create(
                model="bge-m3",
                input="hello",
                request_options={"idempotency_key": "idem-embeddings-123"},
            )

        self.assertEqual(embeddings_error.exception.status, 503)
        self.assertEqual(len(embeddings_transport.calls), 1)
        self.assertEqual(embeddings_transport.calls[0].headers["Idempotency-Key"], "idem-embeddings-123")

        images_transport = RecordingTransport(
            json_response({"error": {"message": "busy"}}, status=503),
            json_response({"created": 1, "data": []}),
        )
        images_client = RunInfra(
            api_key="sk-ri-test",
            transport=images_transport,
            max_retries=1,
            retry_base_seconds=0,
        )

        with self.assertRaises(RunInfraError) as images_error:
            images_client.images.generate(
                model="flux",
                prompt="cat",
                request_options={"idempotency_key": "idem-images-123"},
            )

        self.assertEqual(images_error.exception.status, 503)
        self.assertEqual(len(images_transport.calls), 1)
        self.assertEqual(images_transport.calls[0].headers["Idempotency-Key"], "idem-images-123")

    def test_streaming_posts_do_not_retry_with_idempotency_key(self):
        transport = RecordingTransport(
            json_response({"error": {"message": "busy"}}, status=503),
            json_response({"id": "resp_123"}),
        )
        client = RunInfra(
            api_key="sk-ri-test",
            transport=transport,
            max_retries=1,
            retry_base_seconds=0,
        )

        with self.assertRaises(RunInfraError) as raised:
            client.responses.create(
                model="llama-3.1-8b",
                input="Hi",
                stream=True,
                request_options={"idempotency_key": "idem-stream-123"},
            )

        self.assertEqual(raised.exception.status, 503)
        self.assertEqual(len(transport.calls), 1)

    def test_binary_posts_do_not_retry_with_idempotency_key(self):
        transport = RecordingTransport(
            json_response({"error": {"message": "busy"}}, status=503),
            RunInfraResponse(200, {"content-type": "audio/mpeg"}, b"\x01\x02"),
        )
        client = RunInfra(
            api_key="sk-ri-test",
            transport=transport,
            max_retries=1,
            retry_base_seconds=0,
        )

        with self.assertRaises(RunInfraError) as raised:
            client.audio.speech.create(
                model="kokoro",
                input="hello",
                voice="default",
                request_options={"idempotency_key": "idem-tts-123"},
            )

        self.assertEqual(raised.exception.status, 503)
        self.assertEqual(len(transport.calls), 1)

    def test_multipart_posts_do_not_retry_with_idempotency_key(self):
        transport = RecordingTransport(
            json_response({"error": {"message": "busy"}}, status=503),
            json_response({"text": "hello"}),
        )
        client = RunInfra(
            api_key="sk-ri-test",
            transport=transport,
            max_retries=1,
            retry_base_seconds=0,
        )

        with self.assertRaises(RunInfraError) as raised:
            client.audio.transcriptions.create(
                model="whisper-large-v3",
                file=b"abc",
                filename="clip.wav",
                request_options={"idempotency_key": "idem-asr-123"},
            )

        self.assertEqual(raised.exception.status, 503)
        self.assertEqual(len(transport.calls), 1)

    def test_retrieves_openai_compatible_model_object_by_id(self):
        transport = RecordingTransport(
            json_response(
                {
                    "id": "bge-m3",
                    "object": "model",
                    "created": 1,
                    "owned_by": "runinfra",
                }
            )
        )
        client = RunInfra(
            api_key="sk-ri-test",
            pipeline_id="pipe-123",
            base_url="https://api.runinfra.ai/v1",
            transport=transport,
        )

        model = client.models.retrieve("bge-m3")

        self.assertEqual(model["id"], "bge-m3")
        self.assertEqual(
            transport.calls[0].url,
            "https://api.runinfra.ai/v1/pipe-123/models/bge-m3",
        )

    def test_rejects_blank_model_ids_for_model_retrieval_before_sending(self):
        transport = RecordingTransport(json_response({"id": "bge-m3"}))
        client = RunInfra(api_key="sk-ri-test", transport=transport)

        with self.assertRaises(RunInfraError) as caught:
            client.models.retrieve("   ")

        self.assertEqual(caught.exception.type, "invalid_request_options")
        self.assertEqual(str(caught.exception), "model must not be blank")
        self.assertEqual(len(transport.calls), 0)

    def test_rejects_non_string_model_ids_for_model_retrieval_before_sending(self):
        transport = RecordingTransport(json_response({"id": "bge-m3"}))
        client = RunInfra(api_key="sk-ri-test", transport=transport)

        with self.assertRaises(RunInfraError) as caught:
            client.models.retrieve(123)  # type: ignore[arg-type]

        self.assertEqual(caught.exception.type, "invalid_request_options")
        self.assertEqual(str(caught.exception), "model must be a string")
        self.assertEqual(len(transport.calls), 0)

    def test_maps_exhausted_network_failures_to_typed_error(self):
        class FailingTransport:
            def __init__(self):
                self.calls = []

            def __call__(self, request):
                self.calls.append(request)
                raise OSError("connection reset")

        transport = FailingTransport()
        client = RunInfra(
            api_key="sk-ri-test",
            transport=transport,
            max_retries=1,
            retry_base_seconds=0,
        )

        with self.assertRaises(RunInfraConnectionError):
            client.models.list()
        self.assertEqual(len(transport.calls), 2)

    def test_maps_exhausted_timeouts_to_typed_error(self):
        def transport(_request):
            raise TimeoutError("timed out")

        client = RunInfra(
            api_key="sk-ri-test",
            transport=transport,
            max_retries=0,
            retry_base_seconds=0,
        )

        with self.assertRaises(RunInfraTimeoutError):
            client.models.list()

    def test_redacts_api_keys_from_exhausted_transport_errors(self):
        api_key = "sk-ri-redact-local"

        def transport(_request):
            raise OSError(f"lower transport exposed {api_key}")

        client = RunInfra(
            api_key=api_key,
            transport=transport,
            max_retries=0,
            retry_base_seconds=0,
        )

        with self.assertRaises(RunInfraConnectionError) as raised:
            client.models.list()

        self.assertEqual(raised.exception.status, 0)
        self.assertEqual(raised.exception.type, "connection_error")
        self.assertSecretNotInExceptionChain(raised.exception, api_key)

    def test_redacts_api_keys_from_sdk_error_causes(self):
        api_key = "sk-ri-redact-local"

        def transport(_request):
            try:
                raise OSError(f"sdk cause exposed {api_key}")
            except OSError as exc:
                raise RunInfraConnectionError(
                    "safe public message",
                    status=0,
                    error_type="connection_error",
                    request_id="req-sdk-cause-redact",
                ) from exc

        client = RunInfra(
            api_key=api_key,
            transport=transport,
            max_retries=0,
            retry_base_seconds=0,
        )

        with self.assertRaises(RunInfraConnectionError) as raised:
            client.models.list()

        self.assertEqual(str(raised.exception), "safe public message")
        self.assertEqual(raised.exception.request_id, "req-sdk-cause-redact")
        self.assertSecretNotInExceptionChain(raised.exception, api_key)

    def test_redacts_api_keys_from_default_transport_body_read_errors(self):
        api_key = "sk-ri-redact-local"

        class FailingBodyResponse:
            status = 200
            headers = {"content-type": "application/json", "x-request-id": "req-body-redact"}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                raise OSError(f"body reader exposed {api_key}")

        with patch("runinfra._keepalive_urlopen", return_value=FailingBodyResponse()):
            client = RunInfra(
                api_key=api_key,
                transport=runinfra._default_transport(120),
                max_retries=0,
            )

            with self.assertRaises(RunInfraConnectionError) as raised:
                client.models.list()

        self.assertEqual(raised.exception.request_id, "req-body-redact")
        self.assertEqual(raised.exception.type, "connection_error")
        self.assertSecretNotInExceptionChain(raised.exception, api_key)

    def test_redacts_api_keys_from_status_error_bodies(self):
        api_key = "sk-ri-redact-local"
        client = RunInfra(
            api_key=api_key,
            transport=RecordingTransport(
                json_response(
                    {"error": {"message": f"auth body exposed {api_key}", "type": "auth_error"}},
                    status=401,
                    headers={"x-request-id": "req-status-redact"},
                ),
            ),
            max_retries=0,
            retry_base_seconds=0,
        )

        with self.assertRaises(AuthenticationError) as raised:
            client.models.list()

        self.assertEqual(raised.exception.request_id, "req-status-redact")
        self.assertEqual(raised.exception.type, "auth_error")
        self.assertSecretNotInExceptionChain(raised.exception, api_key)

    def test_redacts_api_keys_from_custom_transport_iterable_body_read_errors(self):
        api_key = "sk-ri-redact-local"

        def chunks():
            raise OSError(f"custom body exposed {api_key}")
            yield b""  # pragma: no cover

        def transport(_request):
            return RunInfraResponse(
                200,
                {"content-type": "application/json", "x-request-id": "req-custom-body-redact"},
                chunks(),
            )

        client = RunInfra(
            api_key=api_key,
            transport=transport,
            max_retries=0,
            retry_base_seconds=0,
        )

        with self.assertRaises(RunInfraConnectionError) as raised:
            client.models.list()

        self.assertEqual(raised.exception.request_id, "req-custom-body-redact")
        self.assertEqual(raised.exception.type, "connection_error")
        self.assertSecretNotInExceptionChain(raised.exception, api_key)

    def test_redacts_api_keys_from_stream_read_errors(self):
        api_key = "sk-ri-redact-local"

        def chunks():
            raise OSError(f"stream reader exposed {api_key}")
            yield b""  # pragma: no cover

        def transport(_request):
            return RunInfraResponse(
                200,
                {"content-type": "text/event-stream", "x-request-id": "req-stream-redact"},
                chunks(),
            )

        client = RunInfra(
            api_key=api_key,
            transport=transport,
            max_retries=0,
            retry_base_seconds=0,
        )

        stream = client.chat.completions.create(
            model="llama",
            messages=[{"role": "user", "content": "hello"}],
            stream=True,
        )
        with self.assertRaises(RunInfraConnectionError) as raised:
            next(iter(stream))

        self.assertEqual(raised.exception.request_id, "req-stream-redact")
        self.assertEqual(raised.exception.type, "connection_error")
        self.assertSecretNotInExceptionChain(raised.exception, api_key)

    def test_default_transport_maps_body_read_failures_with_request_ids(self):
        class FailingBodyResponse:
            status = 200
            headers = {"content-type": "application/json", "x-request-id": "req-body-fail"}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                raise OSError("socket closed")

        with patch("runinfra._keepalive_urlopen", return_value=FailingBodyResponse()):
            client = RunInfra(
                api_key="sk-ri-test",
                transport=runinfra._default_transport(120),
                max_retries=0,
            )

            with self.assertRaises(RunInfraConnectionError) as raised:
                client.models.list()

        self.assertEqual(raised.exception.request_id, "req-body-fail")
        self.assertEqual(raised.exception.type, "connection_error")
        self.assertEqual(str(raised.exception), "socket closed")

    def test_default_transport_retries_safe_get_body_read_failures(self):
        class FailingBodyResponse:
            status = 200
            headers = {"content-type": "application/json", "x-request-id": "req-body-fail"}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                raise OSError("socket closed")

        class SuccessfulBodyResponse:
            status = 200
            headers = {"content-type": "application/json", "x-request-id": "req-body-ok"}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return b'{"object":"list","data":[]}'

        responses = [FailingBodyResponse(), SuccessfulBodyResponse()]

        def fake_urlopen(_request, timeout=None):
            return responses.pop(0)

        with patch("runinfra._keepalive_urlopen", side_effect=fake_urlopen), patch("runinfra.time.sleep") as sleep:
            client = RunInfra(
                api_key="sk-ri-test",
                transport=runinfra._default_transport(120),
                max_retries=1,
                retry_base_seconds=0,
            )
            result = client.models.list()

        self.assertEqual(result["data"], [])
        self.assertEqual(result["_request_id"], "req-body-ok")
        sleep.assert_called_once_with(0)
        self.assertEqual(responses, [])

    def test_default_transport_retries_idempotent_json_post_body_read_failures(self):
        class FailingBodyResponse:
            status = 200
            headers = {"content-type": "application/json", "x-request-id": "req-post-body-fail"}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                raise OSError("socket closed")

        class SuccessfulBodyResponse:
            status = 200
            headers = {"content-type": "application/json", "x-request-id": "req-post-body-ok"}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return b'{"id":"resp_123"}'

        responses = [FailingBodyResponse(), SuccessfulBodyResponse()]

        def fake_urlopen(_request, timeout=None):
            return responses.pop(0)

        with patch("runinfra._keepalive_urlopen", side_effect=fake_urlopen), patch("runinfra.time.sleep") as sleep:
            client = RunInfra(
                api_key="sk-ri-test",
                transport=runinfra._default_transport(120),
                max_retries=1,
                retry_base_seconds=0,
            )
            result = client.responses.create(
                model="llama-3.1-8b",
                input="Hi",
                request_options={"idempotency_key": "idem-json-body-read"},
            )

        self.assertEqual(result["id"], "resp_123")
        self.assertEqual(result["_request_id"], "req-post-body-ok")
        sleep.assert_called_once_with(0)
        self.assertEqual(responses, [])

    def test_default_transport_does_not_retry_non_idempotent_json_post_body_read_failures(self):
        class FailingBodyResponse:
            status = 200
            headers = {"content-type": "application/json", "x-request-id": "req-post-body-fail"}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                raise OSError("socket closed")

        class SuccessfulBodyResponse:
            status = 200
            headers = {"content-type": "application/json"}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return b'{"id":"resp_123"}'

        responses = [FailingBodyResponse(), SuccessfulBodyResponse()]

        def fake_urlopen(_request, timeout=None):
            return responses.pop(0)

        with patch("runinfra._keepalive_urlopen", side_effect=fake_urlopen), patch("runinfra.time.sleep") as sleep:
            client = RunInfra(
                api_key="sk-ri-test",
                transport=runinfra._default_transport(120),
                max_retries=1,
                retry_base_seconds=0,
            )
            with self.assertRaises(RunInfraConnectionError) as raised:
                client.responses.create(model="llama-3.1-8b", input="Hi")

        self.assertEqual(raised.exception.request_id, "req-post-body-fail")
        self.assertEqual(raised.exception.type, "connection_error")
        sleep.assert_not_called()
        self.assertEqual(len(responses), 1)

    def test_default_transport_maps_body_read_timeouts_with_request_ids(self):
        class TimeoutBodyResponse:
            status = 200
            headers = {"content-type": "application/json", "x-request-id": "req-body-timeout"}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                raise TimeoutError("body timed out")

        with patch("runinfra._keepalive_urlopen", return_value=TimeoutBodyResponse()):
            client = RunInfra(
                api_key="sk-ri-test",
                transport=runinfra._default_transport(120),
                max_retries=0,
            )

            with self.assertRaises(RunInfraTimeoutError) as raised:
                client.models.list()

        self.assertEqual(raised.exception.request_id, "req-body-timeout")
        self.assertEqual(raised.exception.type, "timeout_error")
        self.assertEqual(str(raised.exception), "body timed out")

    def test_image_generation_uses_openai_compatible_path(self):
        transport = RecordingTransport(json_response({"created": 1, "data": [{"b64_json": "abc"}]}))
        client = RunInfra(
            api_key="sk-ri-test",
            pipeline_id="pipe-image",
            transport=transport,
        )

        result = client.images.generate(model="flux", prompt="cat", n=1)

        self.assertEqual(result["data"][0]["b64_json"], "abc")
        self.assertEqual(
            transport.calls[0].url,
            "https://api.runinfra.ai/v1/pipe-image/images/generations",
        )
        self.assertIn(b'"prompt":"cat"', transport.calls[0].body)

    def test_chat_streaming_returns_iterable_sse_chunks_without_trailing_newline(self):
        transport = RecordingTransport(
            RunInfraResponse(
                200,
                {"content-type": "text/event-stream", "x-request-id": "req-stream-123"},
                (
                    b'data: {"choices":[{"delta":{"content":"hel"}}]}\n\n'
                    b'data: {"choices":[{"delta":{"content":"lo"}}]}\n\n'
                    b'data: [DONE]'
                ),
            )
        )
        client = RunInfra(
            api_key="sk-ri-test",
            pipeline_id="pipe-stream",
            transport=transport,
        )

        stream = client.chat.completions.create(
            model="llama-3.1-8b",
            messages=[{"role": "user", "content": "Hi"}],
            stream=True,
        )

        self.assertIsInstance(stream, RunInfraStream)
        self.assertEqual(stream.request_id, "req-stream-123")
        self.assertEqual(
            list(stream),
            [
                {"choices": [{"delta": {"content": "hel"}}]},
                {"choices": [{"delta": {"content": "lo"}}]},
            ],
        )
        self.assertIn(b'"stream":true', transport.calls[0].body)

    def test_streaming_preserves_multibyte_utf8_split_across_chunks(self):
        payload = (
            b'data: {"choices":[{"delta":{"content":"caf'
            + bytes([0xC3, 0xA9])
            + b'"}}]}\n\n'
        )
        split_at = payload.index(bytes([0xC3, 0xA9])) + 1

        def chunks():
            yield payload[:split_at]
            yield payload[split_at:]
            yield b"data: [DONE]\n\n"

        transport = RecordingTransport(
            RunInfraResponse(
                200,
                {"content-type": "text/event-stream", "x-request-id": "req-stream-utf8"},
                chunks(),
            )
        )
        client = RunInfra(
            api_key="sk-ri-test",
            pipeline_id="pipe-stream",
            transport=transport,
        )

        stream = client.chat.completions.create(
            model="llama-3.1-8b",
            messages=[{"role": "user", "content": "Hi"}],
            stream=True,
        )

        self.assertEqual(
            list(stream),
            [{"choices": [{"delta": {"content": "caf\u00e9"}}]}],
        )

    def test_chat_streaming_marks_transport_request_and_consumes_incremental_chunks(self):
        def chunks():
            yield b'data: {"choices":[{"delta":{"content":"hel"}}]}\n'
            yield b"\n"
            yield b'data: {"choices":[{"delta":{"content":"lo"}}]}\n'
            yield b"\ndata: [DONE]"

        transport = RecordingTransport(
            RunInfraResponse(200, {"content-type": "text/event-stream"}, chunks())
        )
        client = RunInfra(
            api_key="sk-ri-test",
            pipeline_id="pipe-stream",
            transport=transport,
        )

        stream = client.chat.completions.create(
            model="llama-3.1-8b",
            messages=[{"role": "user", "content": "Hi"}],
            stream=True,
        )

        self.assertTrue(transport.calls[0].stream)
        self.assertEqual(
            list(stream),
            [
                {"choices": [{"delta": {"content": "hel"}}]},
                {"choices": [{"delta": {"content": "lo"}}]},
            ],
        )

    def test_responses_streaming_parses_semantic_openai_event_frames(self):
        transport = RecordingTransport(
            RunInfraResponse(
                200,
                {"content-type": "text/event-stream"},
                (
                    b': keepalive\r\n\r\n'
                    b'event: response.output_text.delta\r\n'
                    b'data:{"type":"response.output_text.delta","delta":"hi"}\r\n\r\n'
                    b'data: [DONE]\r\n\r\n'
                    b'event: response.completed\n'
                    b'data: {"type":"response.completed","response":{"status":"completed"}}'
                ),
            )
        )
        client = RunInfra(
            api_key="sk-ri-test",
            pipeline_id="pipe-stream",
            transport=transport,
        )

        stream = client.responses.create(
            model="llama-3.1-8b",
            input="Hi",
            stream=True,
        )

        self.assertEqual(
            list(stream),
            [
                {"type": "response.output_text.delta", "delta": "hi"},
                {"type": "response.completed", "response": {"status": "completed"}},
            ],
        )
        self.assertTrue(transport.calls[0].stream)

    def test_malformed_sse_payloads_raise_typed_stream_parse_errors_with_request_ids(self):
        transport = RecordingTransport(
            RunInfraResponse(
                200,
                {"content-type": "text/event-stream", "x-request-id": "req-stream-bad-json"},
                b"data: {not-json}\n\n",
            )
        )
        client = RunInfra(
            api_key="sk-ri-test",
            pipeline_id="pipe-stream",
            transport=transport,
        )

        stream = client.responses.create(
            model="llama-3.1-8b",
            input="Hi",
            stream=True,
        )

        with self.assertRaises(RunInfraStreamParseError) as raised:
            list(stream)
        self.assertEqual(raised.exception.request_id, "req-stream-bad-json")
        self.assertEqual(raised.exception.type, "stream_parse_error")

    def test_streaming_body_timeouts_raise_typed_timeout_errors(self):
        def chunks():
            yield b'data: {"type":"response.output_text.delta","delta":"hi"}\n\n'
            raise TimeoutError("stream read timed out")

        transport = RecordingTransport(
            RunInfraResponse(
                200,
                {"content-type": "text/event-stream", "x-request-id": "req-stream-timeout"},
                chunks(),
            )
        )
        client = RunInfra(
            api_key="sk-ri-test",
            pipeline_id="pipe-stream",
            transport=transport,
        )

        stream = client.responses.create(
            model="llama-3.1-8b",
            input="Hi",
            stream=True,
        )
        iterator = iter(stream)

        self.assertEqual(
            next(iterator),
            {"type": "response.output_text.delta", "delta": "hi"},
        )
        with self.assertRaises(RunInfraTimeoutError) as raised:
            next(iterator)
        self.assertEqual(raised.exception.request_id, "req-stream-timeout")
        self.assertEqual(raised.exception.type, "timeout_error")

    def test_streaming_iterator_closes_underlying_iterable_when_consumer_stops_early(self):
        class CloseableChunks:
            def __init__(self):
                self.closed = False

            def __iter__(self):
                yield b'data: {"type":"response.output_text.delta","delta":"hi"}\n\n'
                yield b'data: {"type":"response.output_text.delta","delta":"there"}\n\n'

            def close(self):
                self.closed = True

        chunks = CloseableChunks()
        stream = RunInfraStream(chunks)
        iterator = iter(stream)

        self.assertEqual(
            next(iterator),
            {"type": "response.output_text.delta", "delta": "hi"},
        )
        iterator.close()

        self.assertTrue(chunks.closed)

    def test_unshipped_webhook_delivery_helpers_are_not_public_runtime_surface(self):
        transport = RecordingTransport()
        client = RunInfra(api_key="sk-ri-test", transport=transport)

        self.assertFalse(hasattr(client.webhooks, "create"))
        self.assertFalse(hasattr(client.webhooks, "list"))
        self.assertTrue(callable(client.webhooks.verify_signature))
        self.assertTrue(callable(client.webhooks.construct_event))
        self.assertEqual(transport.calls, [])

    def test_construct_webhook_event_verifies_exact_raw_body(self):
        payload = b'{"id":"evt_123","type":"deployment.verified","data":{"pipeline_id":"pipe-1"}}'
        timestamp = 1_700_000_000
        secret = "whsec_test_123"
        signature = hmac.new(
            secret.encode("utf-8"),
            str(timestamp).encode("utf-8") + b"." + payload,
            hashlib.sha256,
        ).hexdigest()

        event = construct_webhook_event(
            payload=payload,
            signature_header=f"t={timestamp},v1={signature}",
            secret=secret,
            now=timestamp + 60,
        )

        self.assertEqual(event["id"], "evt_123")
        self.assertEqual(event["type"], "deployment.verified")
        self.assertEqual(event["data"]["pipeline_id"], "pipe-1")

    def test_construct_webhook_event_rejects_modified_or_stale_payload(self):
        payload = b'{"id":"evt_123","type":"deployment.verified"}'
        timestamp = 1_700_000_000
        secret = "whsec_test_123"
        signature = hmac.new(
            secret.encode("utf-8"),
            str(timestamp).encode("utf-8") + b"." + payload,
            hashlib.sha256,
        ).hexdigest()

        with self.assertRaises(WebhookVerificationError):
            construct_webhook_event(
                payload=b'{"id":"evt_123","type":"deployment.failed"}',
                signature_header=f"t={timestamp},v1={signature}",
                secret=secret,
                now=timestamp + 60,
            )

        with self.assertRaises(WebhookVerificationError):
            construct_webhook_event(
                payload=payload,
                signature_header=f"t={timestamp},v1={signature}",
                secret=secret,
                now=timestamp + 301,
            )

    def test_construct_webhook_event_uses_secret_exactly(self):
        payload = b'{"id":"evt_123","type":"deployment.verified"}'
        timestamp = 1_700_000_000
        secret = " whsec_test_123 "
        signature = hmac.new(
            secret.encode("utf-8"),
            str(timestamp).encode("utf-8") + b"." + payload,
            hashlib.sha256,
        ).hexdigest()

        event = construct_webhook_event(
            payload=payload,
            signature_header=f"t={timestamp},v1={signature}",
            secret=secret,
            now=timestamp + 60,
        )

        self.assertEqual(event["id"], "evt_123")

    def test_construct_webhook_event_rejects_trailing_odd_hex_nibbles(self):
        payload = b'{"id":"evt_123","type":"deployment.verified"}'
        timestamp = 1_700_000_000
        secret = "whsec_test_123"
        signature = hmac.new(
            secret.encode("utf-8"),
            str(timestamp).encode("utf-8") + b"." + payload,
            hashlib.sha256,
        ).hexdigest()

        with self.assertRaises(WebhookVerificationError):
            construct_webhook_event(
                payload=payload,
                signature_header=f"t={timestamp},v1={signature}0",
                secret=secret,
                now=timestamp + 60,
            )

    def test_construct_webhook_event_rejects_blank_secret_and_invalid_tolerance(self):
        payload = b'{"id":"evt_123","type":"deployment.verified"}'
        timestamp = 1_700_000_000
        signature = hmac.new(
            b"not-blank",
            str(timestamp).encode("utf-8") + b"." + payload,
            hashlib.sha256,
        ).hexdigest()

        with self.assertRaises(WebhookVerificationError):
            construct_webhook_event(
                payload=payload,
                signature_header=f"t={timestamp},v1={signature}",
                secret="   ",
                now=timestamp + 60,
            )

        with self.assertRaises(WebhookVerificationError):
            construct_webhook_event(
                payload=payload,
                signature_header=f"t={timestamp},v1={signature}",
                secret="not-blank",
                tolerance_seconds=float("nan"),
                now=timestamp + 60,
            )

        with self.assertRaises(WebhookVerificationError):
            construct_webhook_event(
                payload=payload,
                signature_header=f"t={timestamp},v1={signature}",
                secret="not-blank",
                tolerance_seconds="300",  # type: ignore[arg-type]
                now=timestamp + 60,
            )

    def test_construct_webhook_event_rejects_non_plain_integer_timestamps(self):
        payload = b'{"id":"evt_123","type":"deployment.verified"}'
        secret = "whsec_test_123"

        for timestamp, signed_timestamp in (
            ("1700000000.5", "1700000000.5"),
            ("-1", "-1"),
            ("+1", "1"),
            ("1e3", "1000"),
            ("0x1", "1"),
        ):
            signature = hmac.new(
                secret.encode("utf-8"),
                signed_timestamp.encode("utf-8") + b"." + payload,
                hashlib.sha256,
            ).hexdigest()

            with self.assertRaises(WebhookVerificationError):
                construct_webhook_event(
                    payload=payload,
                    signature_header=f"t={timestamp},v1={signature}",
                    secret=secret,
                    now=1,
                )

    def test_construct_webhook_event_rejects_invalid_verification_clocks(self):
        payload = b'{"id":"evt_123","type":"deployment.verified"}'
        timestamp = 1_700_000_000
        secret = "whsec_test_123"
        signature = hmac.new(
            secret.encode("utf-8"),
            str(timestamp).encode("utf-8") + b"." + payload,
            hashlib.sha256,
        ).hexdigest()

        for now in (float("nan"), float("inf"), -1):
            with self.assertRaises(WebhookVerificationError):
                construct_webhook_event(
                    payload=payload,
                    signature_header=f"t={timestamp},v1={signature}",
                    secret=secret,
                    now=now,
                )

    def test_construct_webhook_event_rejects_invalid_input_types_with_typed_errors(self):
        payload = b'{"id":"evt_123","type":"deployment.verified"}'
        timestamp = 1_700_000_000
        secret = "whsec_test_123"
        signature = hmac.new(
            secret.encode("utf-8"),
            str(timestamp).encode("utf-8") + b"." + payload,
            hashlib.sha256,
        ).hexdigest()

        for invalid_secret in (None, 123):
            with self.subTest(invalid_secret=invalid_secret):
                with self.assertRaises(WebhookVerificationError):
                    construct_webhook_event(
                        payload=payload,
                        signature_header=f"t={timestamp},v1={signature}",
                        secret=invalid_secret,  # type: ignore[arg-type]
                        now=timestamp + 60,
                    )

        for invalid_signature_header in (None, 123):
            with self.subTest(invalid_signature_header=invalid_signature_header):
                with self.assertRaises(WebhookVerificationError):
                    construct_webhook_event(
                        payload=payload,
                        signature_header=invalid_signature_header,  # type: ignore[arg-type]
                        secret=secret,
                        now=timestamp + 60,
                    )

    def test_construct_webhook_event_rejects_oversized_signature_headers(self):
        payload = b'{"id":"evt_123","type":"deployment.verified"}'
        timestamp = 1_700_000_000

        with self.assertRaises(WebhookVerificationError) as caught:
            construct_webhook_event(
                payload=payload,
                signature_header=f"t={timestamp},v1={'a' * 8193}",
                secret="whsec_test_123",
                now=timestamp + 60,
            )
        self.assertEqual(str(caught.exception), "Webhook signature header is too large.")

    def test_construct_webhook_event_rejects_invalid_payload_types_with_typed_errors(self):
        payload = b'{"id":"evt_123","type":"deployment.verified"}'
        timestamp = 1_700_000_000
        secret = "whsec_test_123"
        signature = hmac.new(
            secret.encode("utf-8"),
            str(timestamp).encode("utf-8") + b"." + payload,
            hashlib.sha256,
        ).hexdigest()

        for invalid_payload in (None, 123, object()):
            with self.subTest(invalid_payload=invalid_payload):
                with self.assertRaises(WebhookVerificationError) as caught:
                    construct_webhook_event(
                        payload=invalid_payload,  # type: ignore[arg-type]
                        signature_header=f"t={timestamp},v1={signature}",
                        secret=secret,
                        now=timestamp + 60,
                    )
                self.assertEqual(
                    str(caught.exception),
                    "Webhook payload must be a string, bytes, or bytearray.",
                )


# --- Batch jobs -------------------------------------------------------------
#
# The answers under tests/fixtures/batch are recorded shapes with made-up identifiers (get-completed,
# get-first-job, list, create-model-not-sold, create-no-authorization, deliveries) or typed from the service's
# documented wire (the files named built-*). Nothing here opens a socket: every call goes through an injected
# transport.

BATCH_FIXTURES = Path(__file__).resolve().parent.joinpath("fixtures", "batch")
# Obviously fake values, built at run time: no key and no signing secret is written in this file.
BATCH_TEST_API_KEY = "-".join(["sk", "ri", "batch", "unit", "test"])
BATCH_TEST_SECRET_BYTES = b"runinfra batch unit test secret!"
BATCH_TEST_SECRET = "whsec_" + base64.b64encode(BATCH_TEST_SECRET_BYTES).decode("ascii")
BATCH_BASE_URL = "https://api.runinfra.ai/v1"
BATCH_ID = "00000000-0000-4000-8000-0000000000a1"
BATCH_CREATE_REQUEST = {
    "model": "deepseek-v4-1-flash-1017",
    "input_url": "https://example.org/batch-fixture/file.jsonl",
    "destination": {"type": "webhook", "url": "https://example.org/batch-fixture/hook"},
    "max_cost_cents": 100,
    "window_hours": 24,
    "name": "nightly-evals",
}
BATCH_ERROR_CLASSES = {
    "AuthenticationError": AuthenticationError,
    "InsufficientCreditsError": InsufficientCreditsError,
    "ModelNotFoundError": ModelNotFoundError,
    "PermissionDeniedError": PermissionDeniedError,
    "RateLimitError": RateLimitError,
    "RunInfraError": RunInfraError,
}


def batch_fixture(name):
    return json.loads(BATCH_FIXTURES.joinpath(name).read_text(encoding="utf-8"))


def batch_answer(fixture, headers=None):
    return json_response(
        fixture["body"],
        status=fixture["status"],
        headers={"x-request-id": fixture["request_id"], **(headers or {})},
    )


def batch_refusal_response(refusal, headers=None):
    return json_response(
        refusal["body"],
        status=refusal["status"],
        headers={"x-request-id": refusal["expect"]["request_id"], **(refusal["headers"] if headers is None else headers)},
    )


def busy_answer(retry_after):
    """A plain 503 that names a wait, as any route can answer one."""
    return json_response(
        {"error": {"message": "busy", "type": "api_error", "param": None, "code": None}, "request_id": "req_built-fixture-busy"},
        status=503,
        headers={"x-request-id": "req_built-fixture-busy", "Retry-After": retry_after},
    )


def recorded_batch_refusal(name, error_class, error_type):
    """One of the two recorded refusals, in the shape of the built ones."""
    fixture = batch_fixture(name)
    error = fixture["body"]["error"]
    return {
        "name": name,
        "status": fixture["status"],
        "headers": {},
        "body": fixture["body"],
        "expect": {
            "error_class": error_class,
            "type": error_type,
            "status": fixture["status"],
            "code": error["code"],
            "param": error["param"],
            "reason": None,
            "retry_after_seconds": None,
            "request_id": fixture["request_id"],
        },
    }


def all_batch_refusals():
    return [
        *batch_fixture("built-refusals.json")["refusals"],
        recorded_batch_refusal("create-model-not-sold.json", "ModelNotFoundError", "model_not_found"),
        recorded_batch_refusal("create-no-authorization.json", "AuthenticationError", "auth_error"),
    ]


def batch_refusal(name):
    return next(refusal for refusal in all_batch_refusals() if refusal["name"] == name)


def batch_client(transport, **options):
    return RunInfra(api_key=BATCH_TEST_API_KEY, transport=transport, **options)


class ScriptedTransport(RecordingTransport):
    """A recording transport whose scripted answers may also be transport failures to raise."""

    def __call__(self, request):
        answer = super().__call__(request)
        if isinstance(answer, BaseException):
            raise answer
        return answer


def sent_header(request, name):
    for key, value in request.headers.items():
        if key.lower() == name.lower():
            return value
    return None


def sign_batch_delivery(body, delivery_id, timestamp, key=BATCH_TEST_SECRET_BYTES):
    """Sign a delivery by the gateway's rule: "v1," + base64(HMAC-SHA-256(key, "<id>.<timestamp>.<raw body>"))."""
    raw = body.encode("utf-8") if isinstance(body, str) else body
    signed = f"{delivery_id}.{timestamp}.".encode("utf-8") + raw
    signature = base64.b64encode(hmac.new(key, signed, hashlib.sha256).digest()).decode("ascii")
    return {
        "webhook-id": delivery_id,
        "webhook-timestamp": str(timestamp),
        "webhook-signature": f"v1,{signature}",
        "x-rightnow-signature-version": "1",
        "content-type": "application/json",
    }


class RunInfraPythonSdkBatchTest(unittest.TestCase):
    def test_create_sends_the_recorded_request_shape_and_parses_the_job(self):
        fixture = batch_fixture("built-create-200.json")
        transport = RecordingTransport(batch_answer(fixture))
        client = batch_client(transport)

        answer = client.batches.create(
            model="deepseek-v4-1-flash-1017",
            input_url="https://example.org/batch-fixture/file.jsonl",
            destination={"type": "webhook", "url": "https://example.org/batch-fixture/hook"},
            max_cost_cents=100,
            window_hours=24,
            name="nightly-evals",
            request_options={"idempotency_key": "batch-unit-create-01"},
        )

        self.assertEqual(len(transport.calls), 1)
        request = transport.calls[0]
        self.assertEqual(request.url, fixture["request"]["url"])
        self.assertEqual(request.url, f"{BATCH_BASE_URL}/batches")
        self.assertEqual(request.method, fixture["request"]["method"])
        self.assertEqual(json.loads(request.body), fixture["request"]["body"])
        for name in fixture["request"]["header_names"]:
            self.assertTrue(sent_header(request, name), name)
        self.assertEqual(sent_header(request, "Authorization"), f"Bearer {BATCH_TEST_API_KEY}")
        self.assertEqual(sent_header(request, "Content-Type"), "application/json")
        self.assertEqual(sent_header(request, "Idempotency-Key"), "batch-unit-create-01")
        self.assertEqual(sent_header(request, "X-RunInfra-SDK"), "python")

        self.assertEqual(answer["_request_id"], fixture["request_id"])
        self.assertEqual(answer["batch"], fixture["body"]["batch"])
        self.assertEqual(answer["batch"]["batch_state"], "validating")
        self.assertEqual(answer["batch"]["made_by"], {"kind": "key"})
        self.assertEqual(answer["batch"]["max_cost_cents"], 100)
        self.assertIsNone(answer["batch"]["end_reason"])
        self.assertNotIn("errors", answer["batch"])
        self.assertNotIn("quote", answer["batch"])

    def test_readme_example_creates_with_an_idempotency_key_then_reads_the_job(self):
        transport = RecordingTransport(
            batch_answer(batch_fixture("built-create-200.json")),
            batch_answer(batch_fixture("get-completed.json")),
        )
        client = batch_client(transport)

        created = client.batches.create(
            model="deepseek-v4-1-flash-1017",
            input_url="https://example.org/batch/input.jsonl",
            destination={"type": "webhook", "url": "https://example.org/batch/answers"},
            max_cost_cents=100,
            window_hours=24,
            name="nightly-evals",
            request_options={"idempotency_key": "nightly-evals-2026-11-16"},
        )

        job = client.batches.retrieve(created["batch"]["id"])

        create_request, read_request = transport.calls
        self.assertEqual((create_request.method, create_request.url), ("POST", f"{BATCH_BASE_URL}/batches"))
        self.assertEqual(sent_header(create_request, "Idempotency-Key"), "nightly-evals-2026-11-16")
        self.assertEqual(
            create_request.body,
            b'{"model":"deepseek-v4-1-flash-1017","input_url":"https://example.org/batch/input.jsonl",'
            b'"destination":{"type":"webhook","url":"https://example.org/batch/answers"},"max_cost_cents":100,'
            b'"window_hours":24,"name":"nightly-evals"}',
        )
        self.assertEqual((read_request.method, read_request.url), ("GET", f"{BATCH_BASE_URL}/batches/{BATCH_ID}"))
        self.assertEqual(
            (job["batch"]["batch_state"], job["batch"]["errors"], job["batch"]["cost_microcents"]),
            ("completed", [{"code": "invalid_request", "count": 1, "first_lines": [2]}], 2127),
        )

    def test_create_leaves_out_optional_members_and_sends_no_idempotency_header_unless_asked(self):
        transport = RecordingTransport(batch_answer(batch_fixture("built-create-200.json")))

        batch_client(transport).batches.create(
            model="deepseek-v4-1-flash-1017",
            input_url="https://example.org/batch-fixture/file.jsonl",
            destination={"type": "webhook", "url": "https://example.org/batch-fixture/hook"},
            max_cost_cents=1,
        )

        request = transport.calls[0]
        self.assertEqual(
            request.body,
            b'{"model":"deepseek-v4-1-flash-1017","input_url":"https://example.org/batch-fixture/file.jsonl",'
            b'"destination":{"type":"webhook","url":"https://example.org/batch-fixture/hook"},"max_cost_cents":1}',
        )
        self.assertIsNone(sent_header(request, "Idempotency-Key"))

    def test_create_is_never_retried_without_an_idempotency_key(self):
        transport = RecordingTransport(busy_answer("5"))
        client = batch_client(transport, max_retries=2, retry_base_seconds=0)

        with patch("runinfra.time.sleep") as sleep, self.assertRaises(RunInfraError) as caught:
            client.batches.create(**BATCH_CREATE_REQUEST)

        self.assertEqual(caught.exception.status, 503)
        self.assertEqual(caught.exception.retry_after_seconds, 5.0)
        self.assertEqual(caught.exception.request_id, "req_built-fixture-busy")
        self.assertEqual(len(transport.calls), 1)
        sleep.assert_not_called()

    def test_the_same_create_sent_again_answers_the_earlier_job_as_a_plain_success_and_another_body_is_refused(self):
        fixture = batch_fixture("built-create-200.json")
        earlier = fixture["body"]["batch"]
        # The gateway answers a repeat of the same create with the earlier job: the same id, a 200, no error.
        transport = RecordingTransport(
            batch_answer(fixture),
            batch_answer(fixture),
            batch_refusal_response(batch_refusal("idempotency-key-reused")),
        )
        client = batch_client(transport, max_retries=0)
        options = {"idempotency_key": "batch-unit-same-create"}

        first = client.batches.create(**BATCH_CREATE_REQUEST, request_options=options)
        again = client.batches.create(**BATCH_CREATE_REQUEST, request_options=options)

        self.assertEqual(first["batch"]["id"], earlier["id"])
        self.assertEqual(again["batch"], first["batch"])
        self.assertEqual(again["batch"]["id"], earlier["id"])
        self.assertEqual(
            sent_header(transport.calls[1], "Idempotency-Key"),
            sent_header(transport.calls[0], "Idempotency-Key"),
        )
        self.assertEqual(transport.calls[1].body, transport.calls[0].body)

        # The same key with another body is the gateway's 409, raised as it is and not retried.
        with self.assertRaises(RunInfraError) as caught:
            client.batches.create(**{**BATCH_CREATE_REQUEST, "max_cost_cents": 250}, request_options=options)
        self.assertEqual(
            (caught.exception.status, caught.exception.code, caught.exception.param),
            (409, "invalid_request", "Idempotency-Key"),
        )
        self.assertEqual(len(transport.calls), 3)

    def test_both_402_refusals_are_insufficient_credits_errors_each_with_its_own_code(self):
        codes = []
        for name in ("needs-funds", "key-spend-limit-reached"):
            with self.subTest(refusal=name):
                transport = RecordingTransport(batch_refusal_response(batch_refusal(name)))
                with self.assertRaises(InsufficientCreditsError) as caught:
                    batch_client(transport).batches.create(
                        **BATCH_CREATE_REQUEST,
                        request_options={"idempotency_key": "batch-unit-402"},
                    )
                self.assertIs(type(caught.exception), InsufficientCreditsError)
                self.assertEqual((caught.exception.status, caught.exception.type), (402, "insufficient_credits"))
                self.assertEqual(len(transport.calls), 1)
                codes.append(caught.exception.code)
        self.assertEqual(codes, ["needs_funds", "key_spend_limit_reached"])

    def test_create_asked_again_is_retried_with_the_same_idempotency_key_and_body(self):
        fixture = batch_fixture("built-create-200.json")
        transport = ScriptedTransport(
            busy_answer("5"),
            OSError("socket closed"),
            batch_answer(fixture),
        )
        client = batch_client(transport, max_retries=2, retry_base_seconds=0)

        with patch("runinfra.time.sleep") as sleep:
            answer = client.batches.create(
                **BATCH_CREATE_REQUEST,
                request_options={"idempotency_key": "batch-unit-create-02"},
            )

        self.assertEqual(answer["batch"]["id"], fixture["body"]["batch"]["id"])
        self.assertEqual(len(transport.calls), 3)
        self.assertEqual(
            [sent_header(request, "Idempotency-Key") for request in transport.calls],
            ["batch-unit-create-02"] * 3,
        )
        self.assertEqual(len({request.body for request in transport.calls}), 1)
        self.assertEqual(len({sent_header(request, "X-Client-Request-Id") for request in transport.calls}), 1)
        # The first wait is the gateway's own Retry-After; the second is the client's backoff.
        self.assertEqual([call.args[0] for call in sleep.call_args_list], [5.0, 0])

    def test_a_409_on_a_batch_route_is_a_final_refusal_and_is_never_retried(self):
        create_transport = RecordingTransport(batch_refusal_response(batch_refusal("idempotency-key-reused")))
        with patch("runinfra.time.sleep") as sleep, self.assertRaises(RunInfraError) as caught:
            batch_client(create_transport, max_retries=2, retry_base_seconds=0).batches.create(
                **BATCH_CREATE_REQUEST,
                request_options={"idempotency_key": "batch-unit-create-03"},
            )
        self.assertEqual(
            (caught.exception.status, caught.exception.code, caught.exception.param),
            (409, "invalid_request", "Idempotency-Key"),
        )
        self.assertEqual(len(create_transport.calls), 1)

        read_transport = RecordingTransport(batch_refusal_response(batch_refusal("batch-ended")))
        with self.assertRaises(RunInfraError) as caught:
            batch_client(read_transport, max_retries=2, retry_base_seconds=0).batches.retrieve(BATCH_ID)
        self.assertEqual((caught.exception.status, caught.exception.code), (409, "batch_ended"))
        self.assertEqual(len(read_transport.calls), 1)
        sleep.assert_not_called()

    def test_create_default_timeout_is_at_least_30_seconds_and_an_explicit_one_is_honored(self):
        fixture = batch_fixture("built-create-200.json")

        def timeouts(method_call, **options):
            transport = RecordingTransport(batch_answer(fixture))
            method_call(batch_client(transport, **options))
            return transport.calls[0].timeout_seconds

        create = lambda client: client.batches.create(**BATCH_CREATE_REQUEST)  # noqa: E731
        # A client whose own timeout is shorter: the create alone is given 30 seconds.
        self.assertEqual(timeouts(create, timeout_seconds=5), 30.0)
        self.assertEqual(
            timeouts(
                lambda client: client.batches.create(**BATCH_CREATE_REQUEST, request_options={"timeout_seconds": 1}),
                timeout_seconds=5,
            ),
            1.0,
        )
        self.assertIsNone(timeouts(lambda client: client.batches.list(), timeout_seconds=5))
        # A client whose timeout is already longer keeps it (None leaves the transport's own default in force).
        self.assertIsNone(timeouts(create))
        self.assertIsNone(timeouts(create, timeout_seconds=30))

    def test_create_default_timeout_reaches_the_default_transport(self):
        fixture = batch_fixture("built-create-200.json")
        seen = []

        class Answer:
            status = 200
            headers = {"content-type": "application/json", "x-request-id": fixture["request_id"]}

            def __enter__(self):
                return self

            def __exit__(self, *_args):
                return False

            def read(self):
                return json.dumps(fixture["body"]).encode("utf-8")

        def fake_urlopen(_request, timeout=None):
            seen.append(timeout)
            return Answer()

        with patch("runinfra._keepalive_urlopen", side_effect=fake_urlopen):
            RunInfra(api_key=BATCH_TEST_API_KEY, timeout_seconds=5).batches.create(**BATCH_CREATE_REQUEST)
            RunInfra(api_key=BATCH_TEST_API_KEY).batches.create(**BATCH_CREATE_REQUEST)
            RunInfra(api_key=BATCH_TEST_API_KEY, timeout_seconds=5).batches.retrieve(BATCH_ID)

        # With no timeout named anywhere, the create is given the default of a non-streamed call.
        self.assertEqual(seen, [30.0, 750.0, 5.0])

    def test_list_sends_the_gateway_query_names_and_parses_the_recorded_page(self):
        fixture = batch_fixture("list.json")
        transport = RecordingTransport(batch_answer(fixture), batch_answer(fixture), batch_answer(fixture))
        client = batch_client(transport)

        page = client.batches.list()

        request = transport.calls[0]
        self.assertEqual(request.url, fixture["request"]["url"])
        self.assertEqual(request.method, "GET")
        self.assertIsNone(request.body)
        self.assertIsNone(sent_header(request, "Content-Type"))
        self.assertEqual(sent_header(request, "Authorization"), f"Bearer {BATCH_TEST_API_KEY}")
        self.assertEqual(page["batches"], fixture["body"]["batches"])
        self.assertIsNone(page["next_cursor"])
        self.assertEqual(page["_request_id"], fixture["request_id"])
        self.assertEqual(
            [job["id"] for job in page["batches"]],
            [BATCH_ID, "00000000-0000-4000-8000-0000000000a2"],
        )
        for job in page["batches"]:
            self.assertEqual(job["batch_state"], "completed")
            self.assertEqual(job["end_reason"], "all_done")
            self.assertEqual(job["notice"], "batch_ended")
            self.assertEqual(job["destination_type"], "webhook")
            self.assertEqual(job["lines_total"] - job["lines_invalid"], job["succeeded"])
            self.assertNotIn("errors", job)

        client.batches.list(limit=2, cursor="bmV4dC1wYWdl", state="completed", model="deepseek-v4-1-flash-1017")
        self.assertEqual(
            transport.calls[1].url,
            f"{BATCH_BASE_URL}/batches?limit=2&cursor=bmV4dC1wYWdl&state=completed&model=deepseek-v4-1-flash-1017",
        )
        client.batches.list(state="running")
        self.assertEqual(transport.calls[2].url, f"{BATCH_BASE_URL}/batches?state=running")

    def test_retrieve_reads_the_recorded_job_with_its_check_errors_and_quote(self):
        for name in ("get-completed.json", "get-first-job.json"):
            with self.subTest(name=name):
                fixture = batch_fixture(name)
                recorded = fixture["body"]["batch"]
                transport = RecordingTransport(batch_answer(fixture))

                answer = batch_client(transport).batches.retrieve(recorded["id"])

                request = transport.calls[0]
                self.assertEqual(request.url, fixture["request"]["url"])
                self.assertEqual(request.method, "GET")
                self.assertIsNone(request.body)
                self.assertEqual(answer["batch"], recorded)
                self.assertEqual(answer["_request_id"], fixture["request_id"])
                self.assertEqual(answer["batch"]["batch_state"], "completed")
                self.assertIsNone(answer["batch"]["pause_reason"])
                self.assertIsNone(answer["batch"]["check_error"])
                self.assertEqual(
                    answer["batch"]["errors"],
                    [{"code": "invalid_request", "count": 1, "first_lines": [2]}],
                )
                self.assertIsNone(answer["batch"]["quote"])
                self.assertGreater(answer["batch"]["cost_microcents"], 0)
                self.assertEqual(set(recorded), set(get_type_hints(runinfra.BatchJobDetail)))

    def test_typed_job_names_exactly_the_members_the_recorded_answers_carry(self):
        listed = batch_fixture("list.json")["body"]["batches"][0]
        self.assertEqual(set(listed), set(get_type_hints(runinfra.BatchJob)))
        self.assertEqual(
            set(get_type_hints(runinfra.BatchJobDetail)) - set(get_type_hints(runinfra.BatchJob)),
            {"errors", "quote"},
        )
        self.assertIs(get_type_hints(runinfra.RunInfra(api_key=BATCH_TEST_API_KEY).batches.create)["return"], runinfra.BatchCreateResponse)
        client = batch_client(RecordingTransport())
        self.assertIs(get_type_hints(client.batches.list)["return"], runinfra.BatchListResponse)
        self.assertIs(get_type_hints(client.batches.retrieve)["return"], runinfra.BatchRetrieveResponse)
        self.assertIs(get_type_hints(client.batches.cancel)["return"], runinfra.BatchCancelResponse)
        for method in (client.batches.create, client.batches.list, client.batches.retrieve, client.batches.cancel):
            self.assertNotIn(
                inspect.Parameter.VAR_KEYWORD,
                {parameter.kind for parameter in inspect.signature(method).parameters.values()},
            )

    def test_cancel_is_a_bodyless_post_that_is_sent_once(self):
        fixture = batch_fixture("built-cancel-200.json")
        batch_id = fixture["body"]["batch_id"]
        transport = RecordingTransport(batch_answer(fixture))

        answer = batch_client(transport).batches.cancel(batch_id)

        request = transport.calls[0]
        self.assertEqual(request.url, fixture["request"]["url"])
        self.assertEqual(request.url, f"{BATCH_BASE_URL}/batches/{batch_id}/cancel")
        self.assertEqual(request.method, "POST")
        self.assertIsNone(request.body)
        self.assertIsNone(sent_header(request, "Content-Type"))
        self.assertEqual(
            answer,
            {"batch_id": batch_id, "batch_state": "cancelled", "_request_id": fixture["request_id"]},
        )

        busy = RecordingTransport(busy_answer("5"))
        with patch("runinfra.time.sleep") as sleep, self.assertRaises(RunInfraError) as caught:
            batch_client(busy, max_retries=2, retry_base_seconds=0).batches.cancel(
                batch_id,
                request_options={"idempotency_key": "batch-unit-cancel"},
            )
        self.assertEqual((caught.exception.status, caught.exception.retry_after_seconds), (503, 5.0))
        self.assertEqual(len(busy.calls), 1)
        sleep.assert_not_called()

    def test_a_503_that_asks_for_a_wait_above_five_seconds_is_raised_after_one_request_with_that_wait(self):
        not_open = batch_refusal("batch-not-open")
        self.assertEqual(not_open["headers"]["Retry-After"], "60")
        calls = {
            "retrieve": lambda client: client.batches.retrieve(BATCH_ID),
            "list": lambda client: client.batches.list(),
            "create": lambda client: client.batches.create(
                **BATCH_CREATE_REQUEST,
                request_options={"idempotency_key": "batch-unit-long-wait"},
            ),
        }

        for method, call in calls.items():
            with self.subTest(method=method):
                transport = RecordingTransport(batch_refusal_response(not_open), batch_answer(batch_fixture("get-completed.json")))
                with patch("runinfra.time.sleep") as sleep, self.assertRaises(RunInfraError) as caught:
                    call(batch_client(transport, max_retries=2, retry_base_seconds=0))

                self.assertEqual(len(transport.calls), 1)
                sleep.assert_not_called()
                self.assertEqual(
                    (caught.exception.status, caught.exception.code, caught.exception.retry_after_seconds),
                    (503, "batch_not_open", 60.0),
                )

        # Six seconds is above the line too; an HTTP date far ahead as well.
        for retry_after in ("6", formatdate(time.time() + 3_600, usegmt=True)):
            with self.subTest(retry_after=retry_after):
                transport = RecordingTransport(batch_refusal_response(not_open, headers={"Retry-After": retry_after}))
                with patch("runinfra.time.sleep") as sleep, self.assertRaises(RunInfraError) as caught:
                    batch_client(transport, max_retries=2, retry_base_seconds=0).batches.retrieve(BATCH_ID)
                self.assertEqual(caught.exception.status, 503)
                self.assertEqual(len(transport.calls), 1)
                sleep.assert_not_called()

    def test_a_read_is_asked_again_on_a_503_whose_retry_after_is_five_seconds_or_less(self):
        fixture = batch_fixture("get-completed.json")
        transport = RecordingTransport(busy_answer("5"), batch_answer(fixture))

        with patch("runinfra.time.sleep") as sleep:
            answer = batch_client(transport, max_retries=1, retry_base_seconds=0).batches.retrieve(BATCH_ID)

        self.assertEqual(answer["batch"]["id"], BATCH_ID)
        self.assertEqual(len(transport.calls), 2)
        sleep.assert_called_once_with(5.0)

    def test_every_other_route_keeps_waiting_for_a_long_retry_after(self):
        transport = RecordingTransport(
            json_response({"error": {"message": "busy", "type": "api_error"}}, status=503, headers={"Retry-After": "60"}),
            json_response({"object": "list", "data": []}),
        )

        with patch("runinfra.time.sleep") as sleep:
            answer = batch_client(transport, max_retries=1, retry_base_seconds=0).models.list()

        self.assertEqual(answer["data"], [])
        self.assertEqual(len(transport.calls), 2)
        sleep.assert_called_once_with(60.0)

    def test_every_refusal_of_the_batch_routes_is_a_typed_error_with_its_code_member_reason_wait_and_request_id(self):
        refusals = all_batch_refusals()
        self.assertGreater(len(refusals), 20)
        calls = {
            "create": lambda client: client.batches.create(
                **BATCH_CREATE_REQUEST,
                request_options={"idempotency_key": "batch-unit-refusal"},
            ),
            "list": lambda client: client.batches.list(),
            "retrieve": lambda client: client.batches.retrieve(BATCH_ID),
            "cancel": lambda client: client.batches.cancel(BATCH_ID),
        }

        for refusal in refusals:
            expected = refusal["expect"]
            for method, call in calls.items():
                with self.subTest(refusal=refusal["name"], method=method):
                    transport = RecordingTransport(batch_refusal_response(refusal))
                    with self.assertRaises(RunInfraError) as caught:
                        call(batch_client(transport, max_retries=0))
                    error = caught.exception

                    self.assertEqual(len(transport.calls), 1)
                    self.assertIs(type(error), BATCH_ERROR_CLASSES[expected["error_class"]])
                    self.assertEqual(error.status, expected["status"])
                    self.assertEqual(error.type, expected["type"])
                    self.assertEqual(error.code, expected["code"])
                    self.assertEqual(error.param, expected["param"])
                    self.assertEqual(error.reason, expected["reason"])
                    self.assertEqual(error.retry_after_seconds, expected["retry_after_seconds"])
                    self.assertEqual(error.request_id, expected["request_id"])
                    self.assertEqual(str(error), refusal["body"]["error"]["message"])

    def test_a_refusal_keeps_its_reason_and_wait_when_the_api_key_is_redacted_from_its_message(self):
        transport = RecordingTransport(
            json_response(
                {
                    "error": {
                        "reason": "partner",
                        "message": f"echoed {BATCH_TEST_API_KEY} by mistake",
                        "type": "invalid_request_error",
                        "param": None,
                        "code": "flex_not_available",
                    },
                    "request_id": "req_built-fixture-redaction",
                },
                status=409,
                headers={"x-request-id": "req_built-fixture-redaction", "Retry-After": "7"},
            )
        )

        with self.assertRaises(RunInfraError) as caught:
            batch_client(transport).batches.list()

        error = caught.exception
        self.assertEqual(str(error), "echoed [redacted] by mistake")
        self.assertNotIn(BATCH_TEST_API_KEY, str(error))
        self.assertEqual(
            (error.status, error.code, error.reason, error.retry_after_seconds),
            (409, "flex_not_available", "partner", 7.0),
        )

    def test_errors_of_every_other_route_keep_their_class_and_type_and_carry_the_wait_and_no_reason(self):
        transport = RecordingTransport(
            json_response(
                {"error": {"reason": "model", "message": "busy", "type": "api_error"}},
                status=503,
                headers={"Retry-After": "5"},
            ),
            json_response({"error": {"message": "gone", "type": "not_found_error", "code": "not_found"}}, status=404),
        )
        client = batch_client(transport, max_retries=0)

        with self.assertRaises(RunInfraError) as unavailable:
            client.models.list()
        self.assertEqual(unavailable.exception.status, 503)
        # Since 0.3.1 every error keeps the wait the API named; the cause word stays a batch route's alone.
        self.assertEqual(unavailable.exception.retry_after_seconds, 5.0)
        self.assertIsNone(unavailable.exception.reason)

        with self.assertRaises(ModelNotFoundError) as not_found:
            client.models.retrieve("some-model")
        self.assertEqual(not_found.exception.type, "model_not_found")

    def test_malformed_batch_calls_are_refused_before_anything_is_sent(self):
        transport = RecordingTransport()
        client = batch_client(transport)
        base = dict(BATCH_CREATE_REQUEST)
        cases = [
            (lambda: client.batches.create(**{**base, "model": " "}), "model must not be blank"),
            (lambda: client.batches.create(**{**base, "input_url": ""}), "input_url must be a non-empty string"),
            (lambda: client.batches.create(**{**base, "destination": "https://example.org"}), "destination must be a mapping"),
            (lambda: client.batches.create(**{**base, "destination": {"type": "webhook"}}), "destination.url must be a string"),
            (lambda: client.batches.create(**{**base, "max_cost_cents": 1.5}), "max_cost_cents must be an integer"),
            (lambda: client.batches.create(**{**base, "max_cost_cents": "100"}), "max_cost_cents must be an integer"),
            (lambda: client.batches.create(**{**base, "max_cost_cents": True}), "max_cost_cents must be an integer"),
            (lambda: client.batches.create(**{**base, "window_hours": "24"}), "window_hours must be an integer"),
            (lambda: client.batches.create(**{**base, "name": 7}), "name must be a string"),
            (
                lambda: client.batches.create(**base, request_options={"idempotency_key": "   "}),
                "idempotency_key must not be blank",
            ),
            (
                lambda: client.batches.create(**base, extra_body={"model": "other"}),
                "extra_body must not override typed request field: model",
            ),
            (lambda: client.batches.list(limit="2"), "limit must be an integer"),
            (lambda: client.batches.list(state=""), "state must be a non-empty string"),
            (lambda: client.batches.retrieve("  "), "batch_id must not be blank"),
            (lambda: client.batches.cancel(None), "batch_id must be a string"),
        ]

        for call, message in cases:
            with self.subTest(message=message):
                with self.assertRaises(RunInfraError) as caught:
                    call()
                self.assertEqual((caught.exception.status, caught.exception.type), (0, "invalid_request_options"))
                self.assertEqual(str(caught.exception), message)
        with self.assertRaises(TypeError):
            client.batches.create(**base, unknown_member=True)
        with self.assertRaises(TypeError):
            client.batches.list(page=2)
        self.assertEqual(transport.calls, [])

    def test_gateway_bounds_are_not_re_enforced_locally(self):
        transport = RecordingTransport(batch_refusal_response(batch_refusal("invalid-request-member")))

        with self.assertRaises(RunInfraError) as caught:
            batch_client(transport).batches.create(**{**BATCH_CREATE_REQUEST, "max_cost_cents": 0})

        self.assertEqual(
            (caught.exception.status, caught.exception.code, caught.exception.param),
            (400, "invalid_request", "max_cost_cents"),
        )
        self.assertEqual(len(transport.calls), 1)

    def test_a_batch_id_is_encoded_into_the_path(self):
        transport = RecordingTransport(
            json_response({"batch_id": "x", "batch_state": "cancelling"}),
            json_response({"batch": {}}),
        )
        client = batch_client(transport)

        client.batches.cancel("a/b?c")
        client.batches.retrieve(" spaced id ")

        self.assertEqual(transport.calls[0].url, f"{BATCH_BASE_URL}/batches/a%2Fb%3Fc/cancel")
        self.assertEqual(transport.calls[1].url, f"{BATCH_BASE_URL}/batches/spaced%20id")

    def test_extra_body_rides_a_create_for_deliberate_extensions(self):
        transport = RecordingTransport(batch_answer(batch_fixture("built-create-200.json")))

        batch_client(transport).batches.create(**BATCH_CREATE_REQUEST, extra_body={"future_member": 1})

        self.assertEqual(json.loads(transport.calls[0].body), {**BATCH_CREATE_REQUEST, "future_member": 1})


class RunInfraPythonSdkBatchDeliveryTest(unittest.TestCase):
    TEST_ID = "bdt_0123456789abcdef0123456789abcdef"
    TEST_BODY = '{"id":"bdt_0123456789abcdef0123456789abcdef","test":true,"value":"unit-test-echo-value"}'
    ANSWER_ID = "bdl_000000000000400080000000000000a1_1_1"
    ANSWER_BODY = json.dumps(
        {
            "id": "bdl_000000000000400080000000000000a1_1_1",
            "batch_id": BATCH_ID,
            "custom_id": "line-1",
            "line": 1,
            "attempt": 1,
            "test": False,
            "response": {
                "id": "chatcmpl-unit",
                "object": "chat.completion",
                "choices": [{"index": 0, "message": {"role": "assistant", "content": "one"}}],
            },
            "usage": {"prompt_tokens": 37, "completion_tokens": 14, "total_tokens": 51},
            "cost": {"microcents": 679},
        },
        separators=(",", ":"),
    )
    ERROR_ID = "bdl_000000000000400080000000000000a1_3_2"
    ERROR_BODY = json.dumps(
        {
            "id": "bdl_000000000000400080000000000000a1_3_2",
            "batch_id": BATCH_ID,
            "custom_id": None,
            "line": 3,
            "attempt": 2,
            "test": False,
            "error": {"code": "link_changed"},
            "usage": None,
            "cost": None,
        },
        separators=(",", ":"),
    )
    # When the deliveries below were signed. A check that is not about the clock names this moment as `now`.
    TIMESTAMP = 1_794_788_172
    FAILURE = "Batch delivery signature verification failed."
    OUTSIDE_TOLERANCE = "Batch delivery timestamp is outside the allowed tolerance."

    def verify(self, body, headers, secret=BATCH_TEST_SECRET):
        return verify_batch_delivery(payload=body, headers=headers, secret=secret, now=self.TIMESTAMP)

    def test_verifies_and_types_the_three_deliveries_signed_by_the_gateway_rule(self):
        test = self.verify(self.TEST_BODY, sign_batch_delivery(self.TEST_BODY, self.TEST_ID, self.TIMESTAMP))
        self.assertEqual(test, {"id": self.TEST_ID, "test": True, "value": "unit-test-echo-value"})

        answer = self.verify(self.ANSWER_BODY, sign_batch_delivery(self.ANSWER_BODY, self.ANSWER_ID, self.TIMESTAMP))
        self.assertIs(answer["test"], False)
        self.assertEqual(answer["custom_id"], "line-1")
        self.assertEqual(answer["line"], 1)
        self.assertEqual(answer["response"]["object"], "chat.completion")
        self.assertEqual(answer["usage"], {"prompt_tokens": 37, "completion_tokens": 14, "total_tokens": 51})
        self.assertEqual(answer["cost"], {"microcents": 679})
        self.assertNotIn("error", answer)

        failed = self.verify(self.ERROR_BODY, sign_batch_delivery(self.ERROR_BODY, self.ERROR_ID, self.TIMESTAMP))
        self.assertIs(failed["test"], False)
        self.assertEqual(failed["error"], {"code": "link_changed"})
        self.assertIsNone(failed["custom_id"])
        self.assertEqual(failed["line"], 3)
        self.assertIsNone(failed["usage"])
        self.assertIsNone(failed["cost"])
        self.assertNotIn("response", failed)

    def test_typed_delivery_shapes_name_the_members_a_delivery_carries(self):
        self.assertEqual(set(json.loads(self.TEST_BODY)), set(get_type_hints(runinfra.BatchTestDelivery)))
        self.assertEqual(set(json.loads(self.ANSWER_BODY)), set(get_type_hints(runinfra.BatchAnswerDelivery)))
        self.assertEqual(set(json.loads(self.ERROR_BODY)), set(get_type_hints(runinfra.BatchErrorDelivery)))
        self.assertEqual(
            get_type_hints(verify_batch_delivery)["return"],
            Union[runinfra.BatchTestDelivery, runinfra.BatchAnswerDelivery, runinfra.BatchErrorDelivery],
        )
        self.assertEqual(inspect.signature(verify_batch_delivery).parameters["tolerance_seconds"].default, 300)

    def test_readme_handler_sends_the_test_value_back_and_acknowledges_a_line(self):
        signing_secret = BATCH_TEST_SECRET
        seen = []

        def handle(raw_body, request_headers):
            delivery = verify_batch_delivery(
                payload=raw_body,
                headers=request_headers,
                secret=signing_secret,
            )

            if delivery["test"]:
                # The create's test delivery: reply 2xx with a body that contains delivery["value"].
                reply_status, reply_body = 200, delivery["value"]
            elif "error" in delivery:
                seen.append((delivery["custom_id"] or f"line {delivery['line']}", delivery["error"]["code"]))
                reply_status, reply_body = 204, ""
            else:
                seen.append((delivery["custom_id"], delivery["response"]["object"], delivery["cost"]))
                reply_status, reply_body = 204, ""
            return reply_status, reply_body

        # The handler names no clock, so the deliveries are signed now, as the gateway signs them when it sends them.
        signed_now = int(time.time())

        def post(body, delivery_id):
            return handle(body.encode("utf-8"), sign_batch_delivery(body, delivery_id, signed_now))

        status, body = post(self.TEST_BODY, self.TEST_ID)
        self.assertEqual(status, 200)
        self.assertIn("unit-test-echo-value", body)
        self.assertEqual(post(self.ANSWER_BODY, self.ANSWER_ID), (204, ""))
        self.assertEqual(post(self.ERROR_BODY, self.ERROR_ID), (204, ""))
        self.assertEqual(seen, [("line-1", "chat.completion", {"microcents": 679}), ("line 3", "link_changed")])

    def test_refuses_a_delivery_older_than_300_seconds_by_default(self):
        headers = sign_batch_delivery(self.TEST_BODY, self.TEST_ID, self.TIMESTAMP)

        def verify(**options):
            return verify_batch_delivery(payload=self.TEST_BODY, headers=headers, secret=BATCH_TEST_SECRET, **options)

        # The suite's deliveries were signed long before today: with the real clock and no option they are too old,
        # so a captured delivery cannot be replayed later.
        with self.assertRaises(WebhookVerificationError) as caught:
            verify()
        self.assertEqual(str(caught.exception), self.OUTSIDE_TOLERANCE)

        # The same rule against a named clock: 300 seconds pass, 301 do not, in either direction.
        self.assertEqual(verify(now=self.TIMESTAMP + 300)["id"], self.TEST_ID)
        self.assertEqual(verify(now=self.TIMESTAMP - 300)["id"], self.TEST_ID)
        for now in (self.TIMESTAMP + 301, self.TIMESTAMP - 301):
            with self.subTest(now=now):
                with self.assertRaises(WebhookVerificationError) as caught:
                    verify(now=now)
                self.assertEqual(str(caught.exception), self.OUTSIDE_TOLERANCE)

        # And against the real clock: signed just now passes, signed 301 seconds ago does not.
        real_now = int(time.time())
        fresh = sign_batch_delivery(self.TEST_BODY, self.TEST_ID, real_now)
        self.assertEqual(
            verify_batch_delivery(payload=self.TEST_BODY, headers=fresh, secret=BATCH_TEST_SECRET)["id"],
            self.TEST_ID,
        )
        stale = sign_batch_delivery(self.TEST_BODY, self.TEST_ID, real_now - 301)
        with self.assertRaises(WebhookVerificationError) as caught:
            verify_batch_delivery(payload=self.TEST_BODY, headers=stale, secret=BATCH_TEST_SECRET)
        self.assertEqual(str(caught.exception), self.OUTSIDE_TOLERANCE)

    def test_the_same_old_delivery_passes_with_the_check_off_with_now_set_or_with_a_wider_tolerance(self):
        headers = sign_batch_delivery(self.TEST_BODY, self.TEST_ID, self.TIMESTAMP)

        def verify(body=self.TEST_BODY, **options):
            return verify_batch_delivery(payload=body, headers=headers, secret=BATCH_TEST_SECRET, **options)

        with self.assertRaises(WebhookVerificationError):
            verify()
        self.assertEqual(verify(tolerance_seconds=None)["id"], self.TEST_ID)
        self.assertEqual(verify(tolerance_seconds=None, now=self.TIMESTAMP + 86_400 * 365)["id"], self.TEST_ID)
        self.assertEqual(verify(now=self.TIMESTAMP)["id"], self.TEST_ID)
        self.assertEqual(verify(tolerance_seconds=3_600, now=self.TIMESTAMP + 3_600)["id"], self.TEST_ID)
        self.assertEqual(verify(tolerance_seconds=0, now=self.TIMESTAMP)["id"], self.TEST_ID)
        for tolerance, now in ((10, self.TIMESTAMP + 11), (0, self.TIMESTAMP + 1)):
            with self.subTest(tolerance=tolerance):
                with self.assertRaises(WebhookVerificationError) as caught:
                    verify(tolerance_seconds=tolerance, now=now)
                self.assertEqual(str(caught.exception), self.OUTSIDE_TOLERANCE)

        # Turning the clock check off turns nothing else off.
        with self.assertRaises(WebhookVerificationError) as caught:
            verify(body=self.TEST_BODY.replace("echo", "echO"), tolerance_seconds=None)
        self.assertEqual(str(caught.exception), self.FAILURE)

        for tolerance in (-1, math.nan, math.inf, "300", True):
            with self.subTest(tolerance=tolerance):
                with self.assertRaises(WebhookVerificationError) as caught:
                    verify(tolerance_seconds=tolerance, now=self.TIMESTAMP)
                self.assertEqual(
                    str(caught.exception),
                    "Batch delivery tolerance must be a non-negative number, or None to turn the check off.",
                )
        with self.assertRaises(WebhookVerificationError) as caught:
            verify(now=math.nan)
        self.assertEqual(str(caught.exception), "Batch delivery verification clock must be a non-negative finite number.")

    def test_rejects_a_changed_body_a_changed_timestamp_a_changed_id_and_a_wrong_secret(self):
        headers = sign_batch_delivery(self.ANSWER_BODY, self.ANSWER_ID, self.TIMESTAMP)
        other_secret = "whsec_" + base64.b64encode(b"another unit test secret, 32 b!!").decode("ascii")
        cases = {
            "body": (self.ANSWER_BODY.replace('"one"', '"two"'), headers, BATCH_TEST_SECRET),
            "timestamp": (self.ANSWER_BODY, {**headers, "webhook-timestamp": str(self.TIMESTAMP + 1)}, BATCH_TEST_SECRET),
            "id": (self.ANSWER_BODY, {**headers, "webhook-id": self.ANSWER_ID.replace("_1_1", "_1_2")}, BATCH_TEST_SECRET),
            "secret": (self.ANSWER_BODY, headers, other_secret),
        }

        for name, (body, sent, secret) in cases.items():
            with self.subTest(changed=name):
                with self.assertRaises(WebhookVerificationError) as caught:
                    self.verify(body, sent, secret)
                self.assertEqual(str(caught.exception), self.FAILURE)

    def test_takes_the_raw_body_only_and_the_same_json_serialized_again_does_not_verify(self):
        spaced = '{ "id": "bdt_0123456789abcdef0123456789abcdef", "test": true, "value": "unit-test-echo-value" }'
        headers = sign_batch_delivery(spaced, self.TEST_ID, self.TIMESTAMP)

        self.assertEqual(self.verify(spaced, headers)["id"], self.TEST_ID)
        self.assertIs(self.verify(spaced.encode("utf-8"), headers)["test"], True)
        self.assertIs(self.verify(bytearray(spaced.encode("utf-8")), headers)["test"], True)
        with self.assertRaises(WebhookVerificationError) as caught:
            self.verify(json.dumps(json.loads(spaced), separators=(",", ":")), headers)
        self.assertEqual(str(caught.exception), self.FAILURE)
        with self.assertRaises(WebhookVerificationError):
            self.verify(json.loads(spaced), headers)

    def test_reads_the_headers_in_any_case_from_any_mapping(self):
        signed = sign_batch_delivery(self.TEST_BODY, self.TEST_ID, self.TIMESTAMP)
        upper = {name.upper(): value for name, value in signed.items()}
        mixed = {
            "Webhook-Id": signed["webhook-id"],
            "Webhook-Timestamp": signed["webhook-timestamp"],
            "Webhook-Signature": [signed["webhook-signature"]],
            "Host": "example.org",
        }
        message = Message()
        for name, value in upper.items():
            message[name.title()] = value

        for headers in (signed, upper, mixed, UserDict(upper), message):
            with self.subTest(headers=type(headers).__name__):
                self.assertEqual(self.verify(self.TEST_BODY, headers)["id"], self.TEST_ID)

    def test_uses_the_decoded_bytes_of_the_secret_as_the_key_with_or_without_the_prefix(self):
        headers = sign_batch_delivery(self.TEST_BODY, self.TEST_ID, self.TIMESTAMP)

        without_prefix = base64.b64encode(BATCH_TEST_SECRET_BYTES).decode("ascii")
        self.assertEqual(self.verify(self.TEST_BODY, headers, without_prefix)["id"], self.TEST_ID)
        self.assertEqual(self.verify(self.TEST_BODY, headers, f"  {BATCH_TEST_SECRET}\n")["id"], self.TEST_ID)

        # Signed with the secret's TEXT as the key: that is not the rule, and it does not verify.
        text_keyed = sign_batch_delivery(self.TEST_BODY, self.TEST_ID, self.TIMESTAMP, BATCH_TEST_SECRET.encode("utf-8"))
        with self.assertRaises(WebhookVerificationError) as caught:
            self.verify(self.TEST_BODY, text_keyed)
        self.assertEqual(str(caught.exception), self.FAILURE)

        for secret in ("", "   ", "whsec_", "whsec_not base64!", "whsec_abc", None, 42):
            with self.subTest(secret=secret):
                with self.assertRaises(WebhookVerificationError):
                    self.verify(self.TEST_BODY, headers, secret)

    def test_rejects_missing_repeated_and_malformed_headers_and_bodies_that_are_no_delivery(self):
        headers = sign_batch_delivery(self.TEST_BODY, self.TEST_ID, self.TIMESTAMP)

        for name in ("webhook-id", "webhook-timestamp", "webhook-signature"):
            with self.subTest(missing=name):
                without = {key: value for key, value in headers.items() if key != name}
                with self.assertRaises(WebhookVerificationError) as caught:
                    self.verify(self.TEST_BODY, without)
                self.assertEqual(str(caught.exception), f"Batch delivery header {name} is missing.")
        cases = [
            ({**headers, "Webhook-Id": self.TEST_ID}, "Batch delivery header webhook-id is present more than once."),
            ({**headers, "webhook-timestamp": "soon"}, "Batch delivery timestamp must be a non-negative integer."),
            ("webhook-id", "Batch delivery headers must be a mapping of header names to values."),
            (
                {**headers, "webhook-signature": "v1," + "A" * 8_200},
                "Batch delivery header webhook-signature is too large.",
            ),
        ]
        for sent, message in cases:
            with self.subTest(message=message):
                with self.assertRaises(WebhookVerificationError) as caught:
                    self.verify(self.TEST_BODY, sent)
                self.assertEqual(str(caught.exception), message)

        for body in ("not json", "[1,2]", '"text"', '{"test":true}', '{"id":"bdt_x","test":"yes"}', b"\xff\xfe"):
            with self.subTest(body=body):
                with self.assertRaises(WebhookVerificationError):
                    self.verify(body, sign_batch_delivery(body, self.TEST_ID, self.TIMESTAMP))

    def test_a_timestamp_too_long_or_too_large_to_be_a_time_is_a_webhook_verification_error(self):
        not_a_time = "Batch delivery timestamp must be a non-negative integer."
        # 400 digits, digits beyond the range of a float, thousands of digits, and one past the largest exact integer.
        for stamp in ("9" * 400, "1" + "0" * 309, "9" * 5_000, "9007199254740992"):
            headers = sign_batch_delivery(self.TEST_BODY, self.TEST_ID, stamp)
            for options in ({}, {"now": self.TIMESTAMP}, {"now": float(self.TIMESTAMP)}, {"tolerance_seconds": None}):
                with self.subTest(digits=len(stamp), options=sorted(options)):
                    with self.assertRaises(WebhookVerificationError) as caught:
                        verify_batch_delivery(
                            payload=self.TEST_BODY,
                            headers=headers,
                            secret=BATCH_TEST_SECRET,
                            **options,
                        )
                    self.assertEqual(str(caught.exception), not_a_time)

        # The largest timestamp that is still a whole number every runtime holds is read as a time.
        largest = "9007199254740991"
        self.assertEqual(
            verify_batch_delivery(
                payload=self.TEST_BODY,
                headers=sign_batch_delivery(self.TEST_BODY, self.TEST_ID, largest),
                secret=BATCH_TEST_SECRET,
                tolerance_seconds=None,
            )["id"],
            self.TEST_ID,
        )

    def test_every_failure_of_the_verifier_is_a_webhook_verification_error(self):
        headers = sign_batch_delivery(self.TEST_BODY, self.TEST_ID, self.TIMESTAMP)

        class NotAHeaderStore:
            def items(self):
                return [1, 2]

        cases = {
            "a clock too large for a float": {"now": 10 ** 400},
            "a tolerance too large for a float": {"tolerance_seconds": 10 ** 400, "now": self.TIMESTAMP},
            "a header that is not text": {"headers": {**headers, "webhook-id": 7}, "now": self.TIMESTAMP},
            "a signature that cannot be encoded": {
                "headers": {**headers, "webhook-signature": "v1,\ud800"},
                "now": self.TIMESTAMP,
            },
            "an id that cannot be encoded": {"headers": {**headers, "webhook-id": "bdt_\ud800"}, "now": self.TIMESTAMP},
            "a body that cannot be encoded": {"payload": "{\"id\":\"\ud800\"}", "now": self.TIMESTAMP},
            "a header store that is no mapping": {"headers": NotAHeaderStore(), "now": self.TIMESTAMP},
        }
        for name, changed in cases.items():
            with self.subTest(case=name):
                options = {"payload": self.TEST_BODY, "headers": headers, "secret": BATCH_TEST_SECRET, **changed}
                with self.assertRaises(WebhookVerificationError):
                    verify_batch_delivery(**options)

    def test_accepts_one_matching_signature_among_several(self):
        headers = sign_batch_delivery(self.TEST_BODY, self.TEST_ID, self.TIMESTAMP)
        other = sign_batch_delivery(self.TEST_BODY, self.TEST_ID, self.TIMESTAMP, b"a rotated-away unit test secret!")

        several = {**headers, "webhook-signature": f"{other['webhook-signature']} {headers['webhook-signature']}"}
        self.assertEqual(self.verify(self.TEST_BODY, several)["id"], self.TEST_ID)
        with self.assertRaises(WebhookVerificationError) as caught:
            self.verify(self.TEST_BODY, {**headers, "webhook-signature": "v2," + headers["webhook-signature"][3:]})
        self.assertEqual(str(caught.exception), self.FAILURE)

    def test_verifies_the_stored_deliveries_with_their_stored_headers_and_raw_bodies_and_reads_their_shapes(self):
        fixture = batch_fixture("deliveries.json")
        records = fixture["records"]
        self.assertEqual(len(records), fixture["count"])
        self.assertEqual(len(records), 4)
        other_secret = "whsec_" + base64.b64encode(b"another unit test secret, 32 b!!").decode("ascii")

        for record in records:
            headers = record["headers"]
            parsed = json.loads(record["body"])
            signed_at = int(headers["webhook-timestamp"])
            self.assertEqual(headers["webhook-id"], parsed["id"])
            self.assertRegex(headers["webhook-timestamp"], r"^[0-9]{10}$")
            self.assertRegex(headers["webhook-signature"], r"^v1,[A-Za-z0-9+/]{43}=$")
            self.assertEqual(headers["x-rightnow-signature-version"], "1")
            self.assertEqual(headers["content-type"], "application/json")
            self.assertEqual(len(record["body"].encode("utf-8")), int(headers["content-length"]))

            def verify(body=record["body"], secret=BATCH_TEST_SECRET, **options):
                return verify_batch_delivery(payload=body, headers=headers, secret=secret, **options)

            # The stored signature is the made-up secret's over the stored raw body: it verifies as it is.
            self.assertEqual(verify(now=signed_at), parsed)
            self.assertEqual(verify(tolerance_seconds=None), parsed)
            # It was signed long ago, so with the real clock and no option it is refused as too old.
            with self.assertRaises(WebhookVerificationError) as caught:
                verify()
            self.assertEqual(str(caught.exception), self.OUTSIDE_TOLERANCE)
            # One changed byte of the body, or another secret, and it no longer verifies.
            for changed in (
                {"body": record["body"].replace('"test":', '"test" :')},
                {"secret": other_secret},
            ):
                with self.assertRaises(WebhookVerificationError) as caught:
                    verify(now=signed_at, **changed)
                self.assertEqual(str(caught.exception), self.FAILURE)

        test, *lines = [json.loads(record["body"]) for record in records]
        self.assertIs(test["test"], True)
        self.assertRegex(test["id"], r"^bdt_[0-9a-f]{32}$")
        self.assertEqual(set(test), set(get_type_hints(runinfra.BatchTestDelivery)))
        self.assertRegex(test["value"], r"^[A-Za-z0-9_-]{32}$")

        self.assertEqual([line["line"] for line in lines], [1, 3, 4])
        for line in lines:
            self.assertIs(line["test"], False)
            self.assertEqual(line["id"], f"bdl_{BATCH_ID.replace('-', '')}_{line['line']}_{line['attempt']}")
            self.assertEqual(line["batch_id"], BATCH_ID)
            self.assertEqual(line["custom_id"], f"line-{line['line']}")
            self.assertEqual(line["attempt"], 1)
            self.assertEqual(set(line), set(get_type_hints(runinfra.BatchAnswerDelivery)))
            self.assertEqual(line["response"]["object"], "chat.completion")
            self.assertEqual(set(line["usage"]), set(get_type_hints(runinfra.BatchDeliveryUsage)))
            self.assertEqual(
                line["usage"]["total_tokens"],
                line["usage"]["prompt_tokens"] + line["usage"]["completion_tokens"],
            )
            self.assertEqual(set(line["cost"]), {"microcents"})
            self.assertIsInstance(line["cost"]["microcents"], int)

        # What the three lines cost is what the stored job says it cost.
        job = batch_fixture("get-completed.json")["body"]["batch"]
        self.assertEqual(sum(line["cost"]["microcents"] for line in lines), job["cost_microcents"])


# --- Streams that fail or are cut, timeouts, the retry rule, request fields ---
#
# Every frame, id and value below is made up. Nothing here opens a socket: each call goes through an injected
# transport, or through the standard-library transport with its opener replaced.

MADE_UP_API_KEY = "-".join(["sk", "ri", "made", "up", "unit"])
MADE_UP_MODEL = "made-up-model"
MADE_UP_MESSAGES = [{"role": "user", "content": "Count from one to three."}]
LISTED = {"object": "list", "data": []}


def sse_frame(payload):
    return "data: " + json.dumps(payload) + "\n\n"


def chat_delta(content):
    return sse_frame(
        {"id": "chatcmpl_made_up", "object": "chat.completion.chunk", "choices": [{"index": 0, "delta": {"content": content}}]}
    )


CHAT_USAGE_FRAME = sse_frame({"choices": [], "usage": {"prompt_tokens": 12, "completion_tokens": 4, "total_tokens": 16}})
CHAT_DONE_FRAME = "data: [DONE]\n\n"
CHAT_ERROR_FRAME = sse_frame(
    {
        "error": {
            "message": "The stream ended before it was complete. Please retry.",
            "type": "api_error",
            "param": None,
            "code": "made_up_stream_error",
            "retryable": True,
        },
        "request_id": "req_made_up_frame",
    }
)


def stream_answer(*frames, request_id="req_made_up_stream"):
    """A streamed answer whose frames arrive one chunk at a time."""

    def chunks():
        for frame in frames:
            yield frame.encode("utf-8")

    return RunInfraResponse(200, {"content-type": "text/event-stream", "x-request-id": request_id}, chunks())


def made_up_client(transport, **options):
    return RunInfra(api_key=MADE_UP_API_KEY, transport=transport, **options)


def open_chat_stream(*frames, request_id="req_made_up_stream"):
    transport = RecordingTransport(stream_answer(*frames, request_id=request_id))
    return made_up_client(transport).chat.completions.create(
        model=MADE_UP_MODEL,
        messages=MADE_UP_MESSAGES,
        stream=True,
    )


def open_responses_stream(*frames, request_id="req_made_up_stream"):
    transport = RecordingTransport(stream_answer(*frames, request_id=request_id))
    return made_up_client(transport).responses.create(model=MADE_UP_MODEL, input="Count from one to three.", stream=True)


def drain(stream):
    """Read a stream to its end: the events it yielded, and what it raised, if anything."""
    events = []
    try:
        for event in stream:
            events.append(event)
    except RunInfraError as error:
        return events, error
    return events, None


def delta_texts(events):
    return [event["choices"][0]["delta"].get("content") if event["choices"] else None for event in events]


def busy_response(status, headers=None, **error):
    return json_response(
        {"error": {"message": "busy", "type": "api_error", **error}, "request_id": "req_made_up_busy"},
        status=status,
        headers={"x-request-id": "req_made_up_busy", **(headers or {})},
    )


class RunInfraPythonSdkStreamFailureTest(unittest.TestCase):
    def test_an_error_frame_raises_the_typed_error_after_yielding_the_deltas_that_came_first(self):
        stream = open_chat_stream(chat_delta("One"), chat_delta(" two"), CHAT_ERROR_FRAME, request_id="req_made_up_header")

        events, error = drain(stream)

        self.assertEqual(delta_texts(events), ["One", " two"])
        self.assertIs(type(error), RunInfraStreamError)
        self.assertIsInstance(error, RunInfraError)
        self.assertEqual(str(error), "The stream ended before it was complete. Please retry.")
        self.assertEqual(
            (error.status, error.type, error.code, error.retryable),
            (0, "api_error", "made_up_stream_error", True),
        )
        # The frame names its own request id; it wins over the response header's.
        self.assertEqual(error.request_id, "req_made_up_frame")

    def test_an_error_frame_that_names_no_request_id_and_no_retry_marker_falls_back_and_leaves_it_unset(self):
        frame = sse_frame({"error": {"message": "The model stream ended.", "type": "api_error", "code": "made_up_upstream"}})

        events, error = drain(open_chat_stream(chat_delta("One"), frame, request_id="req_made_up_header"))

        self.assertEqual(delta_texts(events), ["One"])
        self.assertIs(type(error), RunInfraStreamError)
        self.assertEqual((error.code, error.request_id), ("made_up_upstream", "req_made_up_header"))
        self.assertIsNone(error.retryable)
        self.assertIsNone(error.param)

    def test_a_null_error_member_is_an_ordinary_event_and_a_done_after_a_failure_changes_nothing(self):
        ordinary = sse_frame({"choices": [{"index": 0, "delta": {"content": "One"}}], "error": None})
        events, error = drain(open_chat_stream(ordinary, CHAT_DONE_FRAME))
        self.assertIsNone(error)
        self.assertEqual(len(events), 1)

        events, error = drain(open_chat_stream(chat_delta("One"), CHAT_ERROR_FRAME, CHAT_DONE_FRAME))
        self.assertIs(type(error), RunInfraStreamError)
        self.assertEqual(delta_texts(events), ["One"])

    def test_the_api_key_is_redacted_from_an_error_frame_message(self):
        frame = sse_frame({"error": {"message": f"echoed {MADE_UP_API_KEY} by mistake", "type": "api_error"}})

        _events, error = drain(open_chat_stream(frame))

        self.assertIs(type(error), RunInfraStreamError)
        self.assertEqual(str(error), "echoed [redacted] by mistake")

    def test_a_body_that_ends_with_no_done_raises_the_incomplete_stream_error_after_yielding_its_deltas(self):
        events, error = drain(open_chat_stream(chat_delta("One"), chat_delta(" two"), request_id="req_made_up_cut"))

        self.assertEqual(delta_texts(events), ["One", " two"])
        self.assertIs(type(error), RunInfraStreamIncompleteError)
        self.assertIsInstance(error, RunInfraError)
        self.assertEqual((error.status, error.type, error.request_id), (0, "stream_incomplete_error", "req_made_up_cut"))

    def test_a_last_event_with_no_trailing_newline_is_yielded_before_the_cut_is_reported(self):
        events, error = drain(open_chat_stream(chat_delta("One"), chat_delta(" two").rstrip()))

        self.assertEqual(delta_texts(events), ["One", " two"])
        self.assertIs(type(error), RunInfraStreamIncompleteError)

    def test_a_body_that_ends_in_the_middle_of_an_event_is_a_cut_stream_not_a_malformed_event(self):
        cut_inside_an_event = 'data: {"id":"chatcmpl_made_up","choices":[{"index":0,"delta":{"content":"tw'

        events, error = drain(open_chat_stream(chat_delta("One"), cut_inside_an_event, request_id="req_made_up_mid_event"))

        self.assertEqual(delta_texts(events), ["One"])
        self.assertIs(type(error), RunInfraStreamIncompleteError)
        self.assertEqual(error.request_id, "req_made_up_mid_event")

        # An event the body did finish, with a blank line after it, is still a malformed event when it cannot be read.
        events, error = drain(open_chat_stream(chat_delta("One"), "data: {not-json}\n\n", CHAT_DONE_FRAME))
        self.assertEqual(delta_texts(events), ["One"])
        self.assertIs(type(error), RunInfraStreamParseError)

    def test_an_empty_body_is_incomplete_too(self):
        for body in (b"", []):
            with self.subTest(body=body):
                events, error = drain(RunInfraStream(body, "req_made_up_empty"))
                self.assertEqual(events, [])
                self.assertIs(type(error), RunInfraStreamIncompleteError)
                self.assertEqual(error.request_id, "req_made_up_empty")

    def test_a_complete_chat_stream_ends_quietly(self):
        events, error = drain(
            open_chat_stream(": keep-alive\n\n", chat_delta("One"), chat_delta(" two"), CHAT_USAGE_FRAME, CHAT_DONE_FRAME)
        )

        self.assertIsNone(error)
        self.assertEqual(delta_texts(events), ["One", " two", None])
        self.assertEqual(events[2], {"choices": [], "usage": {"prompt_tokens": 12, "completion_tokens": 4, "total_tokens": 16}})

    def test_closing_the_iterator_early_raises_nothing_end_marker_or_not(self):
        iterator = iter(open_chat_stream(chat_delta("One"), chat_delta(" two")))

        self.assertEqual(delta_texts([next(iterator)]), ["One"])
        iterator.close()

    def test_response_failed_raises_the_typed_error_after_the_events_that_came_first(self):
        delta = "event: response.output_text.delta\n" + sse_frame({"type": "response.output_text.delta", "delta": "One"})
        failed = "event: response.failed\n" + sse_frame(
            {
                "type": "response.failed",
                "response": {
                    "id": "resp_made_up",
                    "status": "failed",
                    "error": {"code": "made_up_server_error", "message": "The response failed.", "retryable": True},
                },
            }
        )

        events, error = drain(open_responses_stream(delta, failed, request_id="req_made_up_responses"))

        self.assertEqual(events, [{"type": "response.output_text.delta", "delta": "One"}])
        self.assertIs(type(error), RunInfraStreamError)
        self.assertEqual(str(error), "The response failed.")
        self.assertEqual(
            (error.status, error.type, error.code, error.request_id, error.retryable),
            (0, "api_error", "made_up_server_error", "req_made_up_responses", True),
        )

    def test_response_failed_with_no_error_object_still_raises(self):
        failed = sse_frame({"type": "response.failed", "response": {"id": "resp_made_up", "status": "failed"}})

        _events, error = drain(open_responses_stream(failed))

        self.assertIs(type(error), RunInfraStreamError)
        self.assertEqual((str(error), error.type, error.code), ("RunInfra stream ended with an error", "api_error", None))

    def test_response_completed_ends_a_responses_stream_quietly_and_one_without_it_is_incomplete(self):
        delta = "event: response.output_text.delta\n" + sse_frame({"type": "response.output_text.delta", "delta": "One"})
        completed = "event: response.completed\n" + sse_frame(
            {"type": "response.completed", "response": {"id": "resp_made_up", "status": "completed"}}
        )

        events, error = drain(open_responses_stream(delta, completed))
        self.assertIsNone(error)
        self.assertEqual([event["type"] for event in events], ["response.output_text.delta", "response.completed"])

        events, error = drain(open_responses_stream(delta, request_id="req_made_up_responses_cut"))
        self.assertEqual([event["type"] for event in events], ["response.output_text.delta"])
        self.assertIs(type(error), RunInfraStreamIncompleteError)
        self.assertEqual(error.request_id, "req_made_up_responses_cut")

    def test_a_body_that_ends_in_the_middle_of_a_character_is_a_cut_stream(self):
        cut_inside_an_event = 'data: {"choices":[{"index":0,"delta":{"content":"\u3053\u3093\u306b'.encode("utf-8")
        # The last character takes three bytes; the body ends after the first of them.
        cut_inside_a_character = cut_inside_an_event[:-2]

        def chunks():
            yield chat_delta("One").encode("utf-8")
            yield cut_inside_a_character

        transport = RecordingTransport(
            RunInfraResponse(
                200,
                {"content-type": "text/event-stream", "x-request-id": "req_made_up_mid_character"},
                chunks(),
            )
        )
        stream = made_up_client(transport).chat.completions.create(
            model=MADE_UP_MODEL, messages=MADE_UP_MESSAGES, stream=True
        )

        events, error = drain(stream)

        self.assertEqual(delta_texts(events), ["One"])
        self.assertIs(type(error), RunInfraStreamIncompleteError)
        self.assertEqual(error.request_id, "req_made_up_mid_character")

    def test_readme_documents_the_two_stream_errors(self):
        readme = Path(__file__).resolve().parents[1].joinpath("README.md").read_text(encoding="utf-8")

        self.assertIn("`RunInfraStreamError`", readme)
        self.assertIn("`RunInfraStreamIncompleteError`", readme)
        self.assertIn("`[DONE]`", readme)
        self.assertIn("`response.completed`", readme)


# The one JSON object a repeated streamed call is answered with. Every field of this one is invented.
MADE_UP_RECEIPT = {
    "id": "chatcmpl_made_up",
    "object": "made_up.receipt",
    "status": "completed",
    "usage": {"prompt_tokens": 12, "completion_tokens": 4, "total_tokens": 16},
}
REPLAY_HEADER = {"X-RunInfra-Idempotent-Replay": "true"}


def json_answer_to_streamed_call(body, headers=None):
    """A successful answer whose body is JSON, not an event stream. The body arrives in two reads."""
    raw = body if isinstance(body, bytes) else body.encode("utf-8")
    middle = len(raw) // 2

    def chunks():
        yield raw[:middle]
        yield raw[middle:]

    return RunInfraResponse(
        200,
        {"content-type": "application/json", "x-request-id": "req_made_up_replay", **(headers or {})},
        chunks(),
    )


class RunInfraPythonSdkStreamAnsweredWithJsonTest(unittest.TestCase):
    def open_chat_stream(self, response, **request_options):
        transport = RecordingTransport(response)
        stream = made_up_client(transport).chat.completions.create(
            model=MADE_UP_MODEL,
            messages=MADE_UP_MESSAGES,
            stream=True,
            request_options=request_options or None,
        )
        return stream, transport

    def test_the_receipt_of_a_repeated_streamed_chat_call_is_yielded_once_marked_and_the_loop_ends_quietly(self):
        stream, transport = self.open_chat_stream(
            json_answer_to_streamed_call(json.dumps(MADE_UP_RECEIPT), REPLAY_HEADER),
            idempotency_key="idem-made-up-replay-01",
        )

        events, error = drain(stream)

        # Not a cut stream: the receipt is the answer, and the caller can read it.
        self.assertIsNone(error)
        self.assertEqual(
            events,
            [{**MADE_UP_RECEIPT, "_request_id": "req_made_up_replay", "_idempotent_replay": True}],
        )
        self.assertEqual(len(transport.calls), 1)

    def test_the_same_on_a_responses_stream_and_when_the_replay_names_no_content_type(self):
        receipt = {"id": "resp_made_up", "object": "made_up.receipt", "status": "completed"}
        transport = RecordingTransport(json_answer_to_streamed_call(json.dumps(receipt), REPLAY_HEADER))
        stream = made_up_client(transport).responses.create(
            model=MADE_UP_MODEL,
            input="Count from one to three.",
            stream=True,
            request_options={"idempotency_key": "idem-made-up-replay-02"},
        )

        events, error = drain(stream)

        self.assertIsNone(error)
        self.assertEqual(events, [{**receipt, "_request_id": "req_made_up_replay", "_idempotent_replay": True}])

        bare, _transport = self.open_chat_stream(
            RunInfraResponse(200, {"x-runinfra-idempotent-replay": "TRUE"}, json.dumps(receipt).encode("utf-8"))
        )
        events, error = drain(bare)
        self.assertIsNone(error)
        self.assertEqual(events, [{**receipt, "_idempotent_replay": True}])

    def test_a_json_answer_that_is_not_a_replay_is_yielded_once_without_the_mark(self):
        whole = {"id": "chatcmpl_made_up", "object": "chat.completion", "choices": []}
        stream, _transport = self.open_chat_stream(
            json_answer_to_streamed_call(json.dumps(whole), {"content-type": "application/json; charset=utf-8"})
        )

        events, error = drain(stream)

        self.assertIsNone(error)
        self.assertEqual(events, [{**whole, "_request_id": "req_made_up_replay"}])

    def test_an_event_stream_is_still_read_as_events_when_its_headers_mark_it_as_a_replay(self):
        stream, _transport = self.open_chat_stream(
            RunInfraResponse(
                200,
                {"Content-Type": "text/event-stream; charset=utf-8", **REPLAY_HEADER},
                (chat_delta("One") + CHAT_DONE_FRAME).encode("utf-8"),
            )
        )

        events, error = drain(stream)

        self.assertIsNone(error)
        self.assertEqual(delta_texts(events), ["One"])

    def test_a_json_answer_that_cannot_be_read_is_incomplete_and_one_that_is_not_an_object_is_a_shape_error(self):
        for body in ('{"id":"chatcmpl_made_up","sta', "", json.dumps(MADE_UP_RECEIPT).encode("utf-8")[:-40] + b"\xe3"):
            with self.subTest(body=body):
                stream, _transport = self.open_chat_stream(json_answer_to_streamed_call(body, REPLAY_HEADER))
                events, error = drain(stream)
                self.assertEqual(events, [])
                self.assertIs(type(error), RunInfraStreamIncompleteError)
                self.assertEqual((error.type, error.request_id), ("stream_incomplete_error", "req_made_up_replay"))

        stream, _transport = self.open_chat_stream(json_answer_to_streamed_call("[1,2]", REPLAY_HEADER))
        events, error = drain(stream)
        self.assertEqual(events, [])
        self.assertIs(type(error), RunInfraError)
        self.assertEqual(
            (error.status, error.type, error.request_id),
            (200, "response_shape_error", "req_made_up_replay"),
        )

    def test_readme_documents_the_json_answer_to_a_streamed_call(self):
        readme = Path(__file__).resolve().parents[1].joinpath("README.md").read_text(encoding="utf-8")

        self.assertIn("When a streamed call is answered with JSON", readme)
        self.assertIn("`_idempotent_replay`", readme)


class FakeHttpAnswer:
    """What the standard-library opener returns, as far as the SDK's transport reads it."""

    def __init__(self, body=b"{}", headers=None, lines=None):
        self.status = 200
        self.headers = {"content-type": "application/json", "x-request-id": "req_made_up_answer", **(headers or {})}
        self._body = body
        self._lines = list(lines or [])

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self):
        if isinstance(self._body, BaseException):
            raise self._body
        return self._body

    def readline(self):
        return self._lines.pop(0) if self._lines else b""

    def close(self):
        pass


class RunInfraPythonSdkTimeoutTest(unittest.TestCase):
    def opened_timeouts(self, call, **client_options):
        """The timeout the standard-library transport hands to its opener for one call."""
        seen = []

        def fake_urlopen(request, timeout=None):
            seen.append(timeout)
            if request.get_method() == "POST" and b'"stream":true' in (request.data or b""):
                return FakeHttpAnswer(
                    headers={"content-type": "text/event-stream"},
                    lines=[b"data: [DONE]\n", b"\n"],
                )
            return FakeHttpAnswer(body=json.dumps(LISTED).encode("utf-8"))

        with patch("runinfra._keepalive_urlopen", side_effect=fake_urlopen):
            result = call(RunInfra(api_key=MADE_UP_API_KEY, **client_options))
            if isinstance(result, RunInfraStream):
                list(result)
        self.assertEqual(len(seen), 1)
        return seen[0]

    def test_a_non_streamed_call_is_given_750_seconds_and_a_streamed_call_190_by_default(self):
        whole = lambda client: client.chat.completions.create(model=MADE_UP_MODEL, messages=MADE_UP_MESSAGES)  # noqa: E731
        streamed = lambda client: client.chat.completions.create(  # noqa: E731
            model=MADE_UP_MODEL, messages=MADE_UP_MESSAGES, stream=True
        )
        streamed_responses = lambda client: client.responses.create(model=MADE_UP_MODEL, input="Hi", stream=True)  # noqa: E731
        read = lambda client: client.models.list()  # noqa: E731

        self.assertEqual(self.opened_timeouts(whole), 750.0)
        self.assertEqual(self.opened_timeouts(read), 750.0)
        self.assertEqual(self.opened_timeouts(streamed), 190.0)
        self.assertEqual(self.opened_timeouts(streamed_responses), 190.0)

    def test_the_callers_own_timeout_wins_over_both_defaults_and_the_calls_over_the_clients(self):
        whole = lambda client: client.chat.completions.create(model=MADE_UP_MODEL, messages=MADE_UP_MESSAGES)  # noqa: E731
        streamed = lambda client: client.chat.completions.create(  # noqa: E731
            model=MADE_UP_MODEL, messages=MADE_UP_MESSAGES, stream=True
        )
        per_call = lambda client: client.chat.completions.create(  # noqa: E731
            model=MADE_UP_MODEL, messages=MADE_UP_MESSAGES, stream=True, request_options={"timeout_seconds": 0.5}
        )
        patient = lambda client: client.chat.completions.create(  # noqa: E731
            model=MADE_UP_MODEL, messages=MADE_UP_MESSAGES, request_options={"timeout_seconds": 900}
        )

        self.assertEqual(self.opened_timeouts(whole, timeout_seconds=2), 2.0)
        self.assertEqual(self.opened_timeouts(streamed, timeout_seconds=2), 2.0)
        self.assertEqual(self.opened_timeouts(per_call, timeout_seconds=2), 0.5)
        # A longer wait than the defaults is the caller's to ask for, too.
        self.assertEqual(self.opened_timeouts(patient), 900.0)

    def test_a_custom_transport_still_sees_no_timeout_unless_the_caller_named_one_for_the_call(self):
        transport = RecordingTransport(json_response(LISTED), json_response(LISTED), json_response(LISTED))

        made_up_client(transport).models.list()
        made_up_client(transport, timeout_seconds=2).models.list()
        made_up_client(transport).models.list(request_options={"timeout_seconds": 3})

        self.assertEqual([request.timeout_seconds for request in transport.calls], [None, None, 3.0])

    def test_a_call_is_sent_once_and_never_again_after_a_timeout_and_the_error_names_the_request_id_it_sent(self):
        class TimingOutTransport:
            def __init__(self):
                self.calls = []

            def __call__(self, request):
                self.calls.append(request)
                raise TimeoutError("timed out")

        # Retries are allowed and the calls are safe to send again: only the timeout stops the second request.
        transport = TimingOutTransport()
        client = made_up_client(transport, max_retries=3, retry_base_seconds=0)

        with patch("runinfra.time.sleep") as sleep:
            with self.assertRaises(RunInfraTimeoutError) as read:
                client.models.list(request_options={"client_request_id": "client-made-up-01"})
            self.assertEqual(len(transport.calls), 1)
            self.assertEqual((read.exception.status, read.exception.type), (0, "timeout_error"))
            self.assertEqual(read.exception.client_request_id, "client-made-up-01")
            self.assertIsNone(read.exception.request_id)

            with self.assertRaises(RunInfraTimeoutError) as keyed:
                client.responses.create(
                    model=MADE_UP_MODEL,
                    input="Hi",
                    request_options={"idempotency_key": "idem-made-up-01"},
                )
            self.assertEqual(len(transport.calls), 2)
            # With no id from the caller, the error names the one the SDK generated and sent.
            sent_id = sent_header(transport.calls[1], "X-Client-Request-Id")
            self.assertTrue(sent_id)
            self.assertEqual(keyed.exception.client_request_id, sent_id)
        sleep.assert_not_called()

    def test_a_keyed_call_is_still_sent_again_after_a_connection_failure(self):
        transport = ScriptedTransport(OSError("socket closed"), json_response({"id": "resp_made_up"}))
        client = made_up_client(transport, max_retries=1, retry_base_seconds=0)

        with patch("runinfra.time.sleep"):
            answer = client.responses.create(
                model=MADE_UP_MODEL,
                input="Hi",
                request_options={"idempotency_key": "idem-made-up-02"},
            )

        self.assertEqual(answer["id"], "resp_made_up")
        self.assertEqual(len(transport.calls), 2)

    def test_a_call_is_not_sent_again_when_the_timeout_fires_while_the_answers_body_is_read(self):
        opened = []

        def fake_urlopen(_request, timeout=None):
            opened.append(timeout)
            return FakeHttpAnswer(body=TimeoutError("body timed out"), headers={"x-request-id": "req_made_up_body"})

        with patch("runinfra._keepalive_urlopen", side_effect=fake_urlopen), patch("runinfra.time.sleep") as sleep:
            client = RunInfra(api_key=MADE_UP_API_KEY, max_retries=2, retry_base_seconds=0, timeout_seconds=1)
            with self.assertRaises(RunInfraTimeoutError) as raised:
                client.models.list(request_options={"client_request_id": "client-made-up-02"})

        self.assertEqual(opened, [1.0])
        sleep.assert_not_called()
        # A response had begun, so the server's request id is known as well.
        self.assertEqual(raised.exception.request_id, "req_made_up_body")
        self.assertEqual(raised.exception.client_request_id, "client-made-up-02")

    def test_a_timeout_while_a_failed_response_body_is_read_is_not_sent_again_either(self):
        def failing_body():
            yield b'{"error":'
            raise TimeoutError("timed out")

        transport = RecordingTransport(
            RunInfraResponse(503, {"x-request-id": "req_made_up_open_body"}, failing_body()),
            json_response(LISTED),
        )

        with patch("runinfra.time.sleep") as sleep, self.assertRaises(RunInfraTimeoutError) as raised:
            made_up_client(transport, max_retries=2, retry_base_seconds=0).models.list()

        self.assertEqual(len(transport.calls), 1)
        sleep.assert_not_called()
        self.assertEqual(raised.exception.request_id, "req_made_up_open_body")
        self.assertEqual(raised.exception.client_request_id, sent_header(transport.calls[0], "X-Client-Request-Id"))

    def test_a_timeout_while_an_open_stream_is_read_names_the_request_id_the_sdk_sent(self):
        def stalled_stream():
            # The headers arrive, the stream opens and one event comes; then the read runs out of time.
            def chunks():
                yield chat_delta("One").encode("utf-8")
                raise TimeoutError("timed out")

            return RunInfraResponse(
                200,
                {"content-type": "text/event-stream", "x-request-id": "req_made_up_stalled_stream"},
                chunks(),
            )

        transport = RecordingTransport(stalled_stream(), stalled_stream())
        client = made_up_client(transport)

        events, error = drain(
            client.chat.completions.create(
                model=MADE_UP_MODEL,
                messages=MADE_UP_MESSAGES,
                stream=True,
                request_options={"client_request_id": "client-made-up-05"},
            )
        )
        self.assertEqual(delta_texts(events), ["One"])
        self.assertIsInstance(error, RunInfraTimeoutError)
        # The response had begun, so the server's request id is known as well.
        self.assertEqual(error.request_id, "req_made_up_stalled_stream")
        self.assertEqual(error.client_request_id, "client-made-up-05")

        # With no id from the caller, the error names the one the SDK generated and sent.
        events, error = drain(client.responses.create(model=MADE_UP_MODEL, input="Hi", stream=True))
        sent_id = sent_header(transport.calls[1], "X-Client-Request-Id")
        self.assertTrue(sent_id)
        self.assertEqual(len(events), 1)
        self.assertIsInstance(error, RunInfraTimeoutError)
        self.assertEqual(error.client_request_id, sent_id)

    def test_readme_documents_the_default_timeouts_and_the_no_resend_rule(self):
        readme = Path(__file__).resolve().parents[1].joinpath("README.md").read_text(encoding="utf-8")

        self.assertIn("750 seconds", readme)
        self.assertIn("190 seconds", readme)
        self.assertIn("never sent again after a timeout", readme)
        self.assertIn("`client_request_id`", readme)


class RunInfraPythonSdkRetryRuleTest(unittest.TestCase):
    def test_retry_after_ms_is_read_before_retry_after(self):
        headers = {"Retry-After-Ms": "1500", "Retry-After": "30"}
        transport = RecordingTransport(busy_response(503, headers), json_response(LISTED))

        with patch("runinfra.time.sleep") as sleep:
            answer = made_up_client(transport, max_retries=1, retry_base_seconds=0.001).models.list()

        self.assertEqual(answer["data"], [])
        self.assertEqual(len(transport.calls), 2)
        sleep.assert_called_once_with(1.5)

        # The same order decides the wait the error carries, whatever case the transport kept the names in.
        for names in (("Retry-After-Ms", "Retry-After"), ("retry-after-ms", "retry-after"), ("RETRY-AFTER-MS", "RETRY-AFTER")):
            with self.subTest(names=names):
                raised_transport = RecordingTransport(busy_response(503, {names[0]: "1500", names[1]: "30"}))
                with self.assertRaises(RunInfraError) as raised:
                    made_up_client(raised_transport, max_retries=0).models.list()
                self.assertEqual(raised.exception.retry_after_seconds, 1.5)

    def test_a_malformed_retry_after_ms_falls_back_to_retry_after(self):
        for retry_after_ms in ("soon", "-5", "1e3", ""):
            with self.subTest(retry_after_ms=retry_after_ms):
                transport = RecordingTransport(busy_response(503, {"Retry-After-Ms": retry_after_ms, "Retry-After": "2"}))
                with self.assertRaises(RunInfraError) as raised:
                    made_up_client(transport, max_retries=0).models.list()
                self.assertEqual(raised.exception.retry_after_seconds, 2.0)

    def test_a_retry_after_with_more_digits_than_a_number_can_hold_names_no_wait_and_the_sdks_own_backoff_applies(self):
        # Made up: 400 digits, more than a float can hold, so it reads as infinity.
        too_many_digits = "9" * 400
        for headers in (
            {"Retry-After": too_many_digits},
            {"Retry-After-Ms": too_many_digits},
            {"Retry-After-Ms": too_many_digits, "Retry-After": too_many_digits},
        ):
            with self.subTest(headers=sorted(headers)):
                # The error carries no wait.
                raised_transport = RecordingTransport(busy_response(503, headers))
                with self.assertRaises(RunInfraError) as raised:
                    made_up_client(raised_transport, max_retries=0).models.list()
                self.assertEqual(raised.exception.status, 503)
                self.assertIsNone(raised.exception.retry_after_seconds)

                # A call that is safe to send again sleeps the SDK's own backoff, then asks again.
                transport = RecordingTransport(busy_response(503, headers), json_response(LISTED))
                with patch("runinfra.time.sleep") as sleep, patch("runinfra.random.random", return_value=0.0):
                    answer = made_up_client(transport, max_retries=1, retry_base_seconds=0.04).models.list()
                self.assertEqual(answer["data"], [])
                self.assertEqual(len(transport.calls), 2)
                sleep.assert_called_once_with(0.04)

        # A Retry-After-Ms that names no wait still falls back to a Retry-After that does.
        fallback = RecordingTransport(busy_response(503, {"Retry-After-Ms": too_many_digits, "Retry-After": "2"}))
        with self.assertRaises(RunInfraError) as raised:
            made_up_client(fallback, max_retries=0).models.list()
        self.assertEqual(raised.exception.retry_after_seconds, 2.0)

    def test_a_retry_after_in_seconds_above_the_largest_safe_integer_names_no_wait(self):
        # Made up: 20 digits. A float holds a value that large, but no longer every whole number.
        headers = {"Retry-After": "12345678901234567890"}

        # The error carries no wait.
        raised_transport = RecordingTransport(busy_response(503, headers))
        with self.assertRaises(RunInfraError) as raised:
            made_up_client(raised_transport, max_retries=0).models.list()
        self.assertEqual(raised.exception.status, 503)
        self.assertIsNone(raised.exception.retry_after_seconds)

        # A call that is safe to send again sleeps the SDK's own backoff, then asks again.
        transport = RecordingTransport(busy_response(503, headers), json_response(LISTED))
        with patch("runinfra.time.sleep") as sleep, patch("runinfra.random.random", return_value=0.0):
            answer = made_up_client(transport, max_retries=1, retry_base_seconds=0.04).models.list()
        self.assertEqual(answer["data"], [])
        self.assertEqual(len(transport.calls), 2)
        sleep.assert_called_once_with(0.04)

        # The line is the largest safe integer, 2^53 - 1. One above it names no wait.
        above = RecordingTransport(busy_response(503, {"Retry-After": "9007199254740992"}))
        with self.assertRaises(RunInfraError) as raised:
            made_up_client(above, max_retries=0).models.list()
        self.assertIsNone(raised.exception.retry_after_seconds)

        # The largest one itself still names its wait: longer than the SDK sleeps for, so it is raised at once.
        largest = RecordingTransport(busy_response(503, {"Retry-After": "9007199254740991"}), json_response(LISTED))
        with patch("runinfra.time.sleep") as sleep, self.assertRaises(RunInfraError) as raised:
            made_up_client(largest, max_retries=1, retry_base_seconds=0.04).models.list()
        self.assertEqual(raised.exception.retry_after_seconds, 9007199254740991.0)
        self.assertEqual(len(largest.calls), 1)
        sleep.assert_not_called()

    def test_x_should_retry_false_stops_a_retry(self):
        transport = RecordingTransport(
            busy_response(503, {"x-should-retry": "false"}),
            busy_response(503, {"X-Should-Retry": "FALSE"}),
        )
        client = made_up_client(transport, max_retries=3, retry_base_seconds=0)

        # A 503 on a GET is otherwise asked again.
        with patch("runinfra.time.sleep") as sleep, self.assertRaises(RunInfraError) as read:
            client.models.list()
        self.assertEqual((read.exception.status, read.exception.retryable), (503, False))
        self.assertEqual(len(transport.calls), 1)

        with patch("runinfra.time.sleep"), self.assertRaises(RunInfraError) as keyed:
            client.responses.create(model=MADE_UP_MODEL, input="Hi", request_options={"idempotency_key": "idem-made-up-03"})
        self.assertEqual((keyed.exception.status, keyed.exception.retryable), (503, False))
        self.assertEqual(len(transport.calls), 2)
        sleep.assert_not_called()

    def test_retryable_false_in_the_error_object_stops_a_retry_and_false_wins_over_a_true_header(self):
        in_body = RecordingTransport(busy_response(503, retryable=False), json_response(LISTED))
        with patch("runinfra.time.sleep"), self.assertRaises(RunInfraError) as raised:
            made_up_client(in_body, max_retries=3, retry_base_seconds=0).models.list()
        self.assertEqual((raised.exception.status, raised.exception.retryable), (503, False))
        self.assertEqual(len(in_body.calls), 1)

        disagreeing = RecordingTransport(busy_response(503, {"x-should-retry": "true"}, retryable=False), json_response(LISTED))
        with patch("runinfra.time.sleep"), self.assertRaises(RunInfraError) as raised:
            made_up_client(disagreeing, max_retries=3, retry_base_seconds=0).models.list()
        self.assertIs(raised.exception.retryable, False)
        self.assertEqual(len(disagreeing.calls), 1)

    def test_a_failure_the_api_marks_retryable_is_asked_again_for_a_call_that_is_safe_to_send_again_only(self):
        # 529 is not among the statuses the SDK retries by itself.
        marked = lambda: busy_response(529, {"x-should-retry": "true"})  # noqa: E731

        with patch("runinfra.time.sleep"):
            unmarked = RecordingTransport(busy_response(529), json_response(LISTED))
            with self.assertRaises(RunInfraError) as raised:
                made_up_client(unmarked, max_retries=2, retry_base_seconds=0).models.list()
            self.assertEqual(raised.exception.status, 529)
            self.assertEqual(len(unmarked.calls), 1)

            read = RecordingTransport(marked(), json_response(LISTED))
            self.assertEqual(made_up_client(read, max_retries=2, retry_base_seconds=0).models.list()["data"], [])
            self.assertEqual(len(read.calls), 2)

            in_body = RecordingTransport(busy_response(529, retryable=True), json_response(LISTED))
            self.assertEqual(made_up_client(in_body, max_retries=2, retry_base_seconds=0).models.list()["data"], [])
            self.assertEqual(len(in_body.calls), 2)

            keyed = RecordingTransport(marked(), json_response({"id": "resp_made_up"}))
            answer = made_up_client(keyed, max_retries=2, retry_base_seconds=0).responses.create(
                model=MADE_UP_MODEL,
                input="Hi",
                request_options={"idempotency_key": "idem-made-up-04"},
            )
            self.assertEqual(answer["id"], "resp_made_up")
            self.assertEqual(len(keyed.calls), 2)

            # No idempotency key: the call is not safe to send again, whatever the API says.
            unkeyed = RecordingTransport(marked(), json_response({"id": "resp_made_up"}))
            with self.assertRaises(RunInfraError) as raised:
                made_up_client(unkeyed, max_retries=2, retry_base_seconds=0).responses.create(model=MADE_UP_MODEL, input="Hi")
            self.assertEqual((raised.exception.status, raised.exception.retryable), (529, True))
            self.assertEqual(len(unkeyed.calls), 1)

            # A streamed call is never sent again, keyed or not.
            streamed = RecordingTransport(marked(), json_response({"id": "resp_made_up"}))
            with self.assertRaises(RunInfraError) as raised:
                made_up_client(streamed, max_retries=2, retry_base_seconds=0).responses.create(
                    model=MADE_UP_MODEL,
                    input="Hi",
                    stream=True,
                    request_options={"idempotency_key": "idem-made-up-05"},
                )
            self.assertEqual((raised.exception.status, raised.exception.retryable), (529, True))
            self.assertEqual(len(streamed.calls), 1)

    def test_a_wait_above_the_longest_the_sdk_sleeps_for_is_raised_at_once_with_the_wait_on_the_error(self):
        cases = (
            ({"Retry-After": "3600"}, 3600.0),
            ({"Retry-After": "61"}, 61.0),
            ({"Retry-After-Ms": "60001", "Retry-After": "1"}, 60.001),
        )
        for headers, expected in cases:
            with self.subTest(headers=headers):
                transport = RecordingTransport(
                    busy_response(503, headers, code="made_up_paused"),
                    busy_response(503, headers, code="made_up_paused"),
                )
                client = made_up_client(transport, max_retries=3, retry_base_seconds=0)

                with patch("runinfra.time.sleep") as sleep:
                    with self.assertRaises(RunInfraError) as read:
                        client.models.list()
                    self.assertEqual(len(transport.calls), 1)
                    self.assertEqual(
                        (read.exception.status, read.exception.code, read.exception.retry_after_seconds),
                        (503, "made_up_paused", expected),
                    )

                    with self.assertRaises(RunInfraError) as keyed:
                        client.responses.create(
                            model=MADE_UP_MODEL,
                            input="Hi",
                            request_options={"idempotency_key": "idem-made-up-06"},
                        )
                    self.assertEqual(len(transport.calls), 2)
                    self.assertEqual(keyed.exception.retry_after_seconds, expected)
                # Nothing was slept, and no request was sent sooner than the API asked.
                sleep.assert_not_called()

    def test_a_wait_of_exactly_the_longest_the_sdk_sleeps_for_is_slept_then_asked_again(self):
        transport = RecordingTransport(busy_response(503, {"Retry-After-Ms": "60000"}), json_response(LISTED))

        with patch("runinfra.time.sleep") as sleep:
            answer = made_up_client(transport, max_retries=1, retry_base_seconds=0).models.list()

        self.assertEqual(answer["data"], [])
        self.assertEqual(len(transport.calls), 2)
        sleep.assert_called_once_with(60.0)

    def test_every_typed_error_that_came_with_a_wait_carries_it(self):
        cases = (
            (400, RunInfraError),
            (401, AuthenticationError),
            (402, InsufficientCreditsError),
            (403, PermissionDeniedError),
            (404, ModelNotFoundError),
            (409, RunInfraError),
            (429, RateLimitError),
            (500, RunInfraError),
            (503, RunInfraError),
            (504, RunInfraError),
        )
        for status, error_class in cases:
            with self.subTest(status=status):
                transport = RecordingTransport(busy_response(status, {"Retry-After": "7"}))
                with self.assertRaises(RunInfraError) as raised:
                    made_up_client(transport, max_retries=0).models.list()
                self.assertIs(type(raised.exception), error_class)
                self.assertEqual(
                    (raised.exception.status, raised.exception.retry_after_seconds, raised.exception.request_id),
                    (status, 7.0, "req_made_up_busy"),
                )

        deployment = RecordingTransport(busy_response(503, {"Retry-After-Ms": "250"}, type="deployment_error"))
        with self.assertRaises(DeploymentError) as raised:
            made_up_client(deployment, max_retries=0).models.list()
        self.assertEqual(raised.exception.retry_after_seconds, 0.25)

    def test_an_error_that_came_with_no_wait_and_no_marker_leaves_both_unset(self):
        transport = RecordingTransport(busy_response(503))

        with self.assertRaises(RunInfraError) as raised:
            made_up_client(transport, max_retries=0).models.list()

        self.assertEqual(raised.exception.status, 503)
        self.assertIsNone(raised.exception.retry_after_seconds)
        self.assertIsNone(raised.exception.retryable)
        self.assertIsNone(raised.exception.client_request_id)

    def test_the_wait_and_the_retry_marker_survive_the_redaction_of_the_api_key(self):
        transport = RecordingTransport(
            busy_response(
                503,
                {"Retry-After": "9", "x-should-retry": "true"},
                message=f"echoed {MADE_UP_API_KEY} by mistake",
            )
        )

        with self.assertRaises(RunInfraError) as raised:
            made_up_client(transport, max_retries=0).models.list()

        self.assertEqual(str(raised.exception), "echoed [redacted] by mistake")
        self.assertEqual(
            (raised.exception.status, raised.exception.retry_after_seconds, raised.exception.retryable),
            (503, 9.0, True),
        )

    def test_the_backoff_has_jitter_and_stays_at_most_30_seconds(self):
        # Without a wait from the API the SDK backs off by itself: base * 2^(attempt - 1), plus up to one base of jitter.
        transport = ScriptedTransport(busy_response(503), OSError("socket closed"), busy_response(503), json_response(LISTED))

        with patch("runinfra.time.sleep") as sleep, patch("runinfra.random.random", return_value=0.5):
            answer = made_up_client(transport, max_retries=3, retry_base_seconds=0.2).models.list()

        self.assertEqual(answer["data"], [])
        waits = [call.args[0] for call in sleep.call_args_list]
        self.assertEqual(len(waits), 3)
        for wait, expected in zip(waits, (0.2 + 0.1, 0.4 + 0.1, 0.8 + 0.1)):
            self.assertAlmostEqual(wait, expected)

        # The jitter is drawn anew for every wait, and never negative.
        with patch("runinfra.random.random", side_effect=[0.0, 0.999]):
            self.assertAlmostEqual(runinfra._backoff_delay_seconds(1, 0.2), 0.2)
            self.assertAlmostEqual(runinfra._backoff_delay_seconds(1, 0.2), 0.2 + 0.999 * 0.2)
        with patch("runinfra.random.random", return_value=0.5):
            self.assertEqual(runinfra._backoff_delay_seconds(20, 10), 30.0)
            self.assertEqual(runinfra._backoff_delay_seconds(3, 0), 0)

    def test_readme_documents_the_retry_rule(self):
        readme = Path(__file__).resolve().parents[1].joinpath("README.md").read_text(encoding="utf-8")

        self.assertIn("`Retry-After-Ms`", readme)
        self.assertIn("`x-should-retry`", readme)
        self.assertIn("`error.retryable`", readme)
        self.assertIn("raised at once", readme)


# The request fields the API's chat reference documents that the SDK did not type before 0.3.1.
CHAT_FIELDS_TYPED_SINCE_0_3_1 = {
    "top_k": 40,
    "min_p": 0.05,
    "repetition_penalty": 1.1,
    "n": 2,
    "best_of": 2,
    "logit_bias": {"1234": -5},
    "parallel_tool_calls": False,
    "reasoning_effort": "low",
    "reasoning": {"effort": "low", "exclude": True},
    "include_reasoning": False,
    "prompt_cache_key": "made-up-session",
    "service_tier": "default",
    "store": False,
    "safety_identifier": "made-up-user",
    "modalities": ["text"],
    "audio": {"voice": "made-up-voice"},
    "prediction": {"type": "content", "content": "made up"},
    "verbosity": "low",
    "web_search_options": {},
    "moderation": {"made_up": True},
    "functions": [{"name": "made_up_function", "parameters": {"type": "object"}}],
    "function_call": "auto",
}
WEATHER_TOOL = {
    "type": "function",
    "function": {
        "name": "get_weather",
        "description": "Get the current weather for a city",
        "parameters": {"type": "object", "properties": {"city": {"type": "string"}}, "required": ["city"]},
    },
}


def sent_json(transport, call=0):
    return json.loads(transport.calls[call].body.decode("utf-8"))


class RunInfraPythonSdkChatFieldsAndToolCallsTest(unittest.TestCase):
    def test_every_chat_request_field_typed_since_0_3_1_is_a_keyword_and_is_sent(self):
        self.assertEqual(len(CHAT_FIELDS_TYPED_SINCE_0_3_1), 22)
        transport = RecordingTransport()
        client = made_up_client(transport)
        signature = inspect.signature(client.chat.completions.create)
        for overload in get_overloads(client.chat.completions.create):
            for field in CHAT_FIELDS_TYPED_SINCE_0_3_1:
                self.assertIn(field, inspect.signature(overload).parameters, field)
        for field in CHAT_FIELDS_TYPED_SINCE_0_3_1:
            self.assertIs(signature.parameters[field].default, None, field)
            self.assertIs(signature.parameters[field].kind, inspect.Parameter.KEYWORD_ONLY, field)

        client.chat.completions.create(model=MADE_UP_MODEL, messages=MADE_UP_MESSAGES, **CHAT_FIELDS_TYPED_SINCE_0_3_1)
        self.assertEqual(
            sent_json(transport),
            {"model": MADE_UP_MODEL, "messages": MADE_UP_MESSAGES, **CHAT_FIELDS_TYPED_SINCE_0_3_1},
        )

        # Each one passes by itself as well, and one left out is not sent.
        for index, (field, value) in enumerate(CHAT_FIELDS_TYPED_SINCE_0_3_1.items(), start=1):
            with self.subTest(field=field):
                client.chat.completions.create(model=MADE_UP_MODEL, messages=MADE_UP_MESSAGES, **{field: value})
                self.assertEqual(
                    sent_json(transport, index),
                    {"model": MADE_UP_MODEL, "messages": MADE_UP_MESSAGES, field: value},
                )

    def test_a_field_the_sdk_does_not_know_is_still_refused(self):
        transport = RecordingTransport()

        with self.assertRaises(TypeError):
            made_up_client(transport).chat.completions.create(  # type: ignore[call-overload]
                model=MADE_UP_MODEL,
                messages=MADE_UP_MESSAGES,
                made_up_field=True,
            )

        self.assertEqual(len(transport.calls), 0)

    def test_those_fields_still_ride_extra_body_where_callers_had_to_put_them_and_one_named_twice_is_refused(self):
        transport = RecordingTransport()
        client = made_up_client(transport)

        client.chat.completions.create(
            model=MADE_UP_MODEL,
            messages=MADE_UP_MESSAGES,
            extra_body=dict(CHAT_FIELDS_TYPED_SINCE_0_3_1),
        )
        self.assertEqual(
            sent_json(transport),
            {"model": MADE_UP_MODEL, "messages": MADE_UP_MESSAGES, **CHAT_FIELDS_TYPED_SINCE_0_3_1},
        )

        with self.assertRaisesRegex(RunInfraError, "extra_body must not override typed request field: reasoning_effort"):
            client.chat.completions.create(
                model=MADE_UP_MODEL,
                messages=MADE_UP_MESSAGES,
                reasoning_effort="low",
                extra_body={"reasoning_effort": "none"},
            )
        # The older keywords stay closed to extra_body, given or not.
        with self.assertRaisesRegex(RunInfraError, "extra_body must not override typed request field: temperature"):
            client.chat.completions.create(
                model=MADE_UP_MODEL,
                messages=MADE_UP_MESSAGES,
                extra_body={"temperature": 0.2},
            )
        self.assertEqual(len(transport.calls), 1)

    def test_a_tool_call_round_trip_sends_the_assistants_calls_back_with_the_tools_answer(self):
        first_answer = {
            "id": "chatcmpl_made_up_1",
            "choices": [
                {
                    "index": 0,
                    "message": {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "call_made_up",
                                "type": "function",
                                "function": {"name": "get_weather", "arguments": "{\"city\":\"Paris\"}"},
                            }
                        ],
                    },
                    "finish_reason": "tool_calls",
                }
            ],
        }
        second_answer = {
            "id": "chatcmpl_made_up_2",
            "choices": [
                {
                    "index": 0,
                    "message": {"role": "assistant", "reasoning": "The tool answered.", "content": "It is 21 degrees in Paris."},
                    "finish_reason": "stop",
                }
            ],
        }
        transport = RecordingTransport(json_response(first_answer), json_response(second_answer))
        client = made_up_client(transport)
        # The list holds the tool's answer too, so its annotation names both shapes, as the README's example does.
        messages: List[Union[ChatMessage, ChatToolMessage]] = [{"role": "user", "content": "What is the weather in Paris?"}]

        first: ChatCompletionResponse = client.chat.completions.create(model=MADE_UP_MODEL, messages=messages, tools=[WEATHER_TOOL])
        choice: ChatCompletionChoice = first["choices"][0]
        asked: ChatMessage = choice["message"]
        self.assertIsNone(asked["content"])
        self.assertEqual(choice["finish_reason"], "tool_calls")
        messages.append(asked)
        for call in asked["tool_calls"]:
            typed_call: ChatCompletionMessageToolCall = call
            arguments = json.loads(typed_call["function"]["arguments"])
            answer: ChatToolMessage = {
                "role": "tool",
                "tool_call_id": typed_call["id"],
                "content": json.dumps({"city": arguments["city"], "temp_c": 21}, separators=(",", ":")),
            }
            messages.append(answer)
        second = client.chat.completions.create(
            model=MADE_UP_MODEL,
            messages=messages,
            tools=[WEATHER_TOOL],
            parallel_tool_calls=False,
        )

        self.assertEqual(second["choices"][0]["message"]["content"], "It is 21 degrees in Paris.")
        self.assertEqual(second["choices"][0]["message"]["reasoning"], "The tool answered.")
        self.assertEqual(
            sent_json(transport, 1),
            {
                "model": MADE_UP_MODEL,
                "tools": [WEATHER_TOOL],
                "parallel_tool_calls": False,
                "messages": [
                    {"role": "user", "content": "What is the weather in Paris?"},
                    {
                        "role": "assistant",
                        "content": None,
                        "tool_calls": [
                            {
                                "id": "call_made_up",
                                "type": "function",
                                "function": {"name": "get_weather", "arguments": "{\"city\":\"Paris\"}"},
                            }
                        ],
                    },
                    {"role": "tool", "tool_call_id": "call_made_up", "content": "{\"city\":\"Paris\",\"temp_c\":21}"},
                ],
            },
        )

    def test_an_assistant_message_with_tool_calls_and_no_content_at_all_is_sent_as_given(self):
        transport = RecordingTransport()
        messages: List[ChatMessage] = [
            {"role": "user", "content": "What is the weather in Paris?"},
            {
                "role": "assistant",
                "tool_calls": [
                    {"id": "call_made_up", "type": "function", "function": {"name": "get_weather", "arguments": "{}"}}
                ],
            },
            {"role": "tool", "tool_call_id": "call_made_up", "content": "{\"temp_c\":21}"},
        ]

        made_up_client(transport).chat.completions.create(model=MADE_UP_MODEL, messages=messages, tools=[WEATHER_TOOL])

        self.assertEqual(sent_json(transport)["messages"], messages)

    def test_the_tool_call_round_trip_is_typed(self):
        json_dict = Dict[str, Any]
        message = get_type_hints(ChatMessage)
        self.assertEqual(set(message), {"role", "content", "name", "tool_call_id", "tool_calls", "reasoning"})
        self.assertIs(message["role"], str)
        self.assertEqual(message["content"], Union[str, List[json_dict], None])
        self.assertEqual(message["tool_calls"], List[ChatCompletionMessageToolCall])
        self.assertEqual(message["reasoning"], Optional[str])
        # Only the role is always there: an assistant message may carry tool calls and no content.
        self.assertEqual(ChatMessage.__required_keys__, frozenset({"role"}))

        call = get_type_hints(ChatCompletionMessageToolCall)
        self.assertEqual(call, {"id": str, "type": Literal["function"], "function": ChatCompletionToolCallFunction})
        self.assertEqual(ChatCompletionMessageToolCall.__required_keys__, frozenset({"id", "type", "function"}))
        self.assertEqual(get_type_hints(ChatCompletionToolCallFunction), {"name": str, "arguments": str})

        tool_message = get_type_hints(ChatToolMessage)
        self.assertEqual(
            tool_message,
            {"role": Literal["tool"], "content": Union[str, List[json_dict]], "tool_call_id": str},
        )
        # A tool message must name the call it answers.
        self.assertEqual(ChatToolMessage.__required_keys__, frozenset({"role", "content", "tool_call_id"}))

        self.assertEqual(get_type_hints(ChatCompletionResponse)["choices"], List[ChatCompletionChoice])
        self.assertIs(get_type_hints(ChatCompletionChoice)["message"], ChatMessage)
        self.assertEqual(get_type_hints(ChatCompletionChoice)["finish_reason"], Optional[str])

        create = made_up_client(RecordingTransport()).chat.completions.create
        self.assertEqual(
            get_type_hints(create)["messages"],
            Sequence[Union[ChatMessage, Mapping[str, object]]],
        )
        self.assertEqual(get_type_hints(create)["parallel_tool_calls"], Optional[bool])
        self.assertEqual(get_type_hints(create)["reasoning_effort"], Optional[str])
        self.assertEqual(get_type_hints(create)["prompt_cache_key"], Optional[str])

    def test_the_stream_delta_types_tool_calls_and_reasoning(self):
        delta = get_type_hints(ChatCompletionStreamDelta)
        self.assertEqual(
            delta,
            {
                "role": str,
                "content": Optional[str],
                "reasoning": Optional[str],
                "tool_calls": List[ChatCompletionStreamToolCallDelta],
            },
        )
        self.assertEqual(ChatCompletionStreamDelta.__required_keys__, frozenset())
        piece = get_type_hints(ChatCompletionStreamToolCallDelta)
        self.assertEqual(
            piece,
            {"index": int, "id": str, "type": Literal["function"], "function": ChatCompletionStreamToolCallFunction},
        )
        # Every piece of a call says which call it belongs to.
        self.assertEqual(ChatCompletionStreamToolCallDelta.__required_keys__, frozenset({"index"}))
        self.assertEqual(get_type_hints(ChatCompletionStreamToolCallFunction), {"name": str, "arguments": str})
        self.assertIs(get_type_hints(ChatCompletionStreamChoice)["delta"], ChatCompletionStreamDelta)
        self.assertEqual(get_type_hints(ChatCompletionStreamEvent)["choices"], List[ChatCompletionStreamChoice])

    def test_a_streamed_tool_call_and_the_models_reasoning_are_read_from_the_delta(self):
        def frame(delta, finish_reason=None):
            return sse_frame({"id": "chatcmpl_made_up", "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}]})

        stream = open_chat_stream(
            frame({"role": "assistant", "content": None, "reasoning": "The user asks "}),
            frame({"reasoning": "for the weather."}),
            frame({"tool_calls": [{"index": 0, "id": "call_made_up", "type": "function", "function": {"name": "get_weather", "arguments": ""}}]}),
            frame({"tool_calls": [{"index": 0, "function": {"arguments": "{\"city\":"}}]}),
            frame({"tool_calls": [{"index": 0, "function": {"arguments": "\"Paris\"}"}}]}),
            frame({}, "tool_calls"),
            CHAT_DONE_FRAME,
        )

        reasoning = ""
        call_id = ""
        name = ""
        arguments_text = ""
        finish_reason = None
        for raw_event in stream:
            event: ChatCompletionStreamEvent = raw_event  # type: ignore[assignment]
            choice: ChatCompletionStreamChoice = event["choices"][0]
            delta: ChatCompletionStreamDelta = choice["delta"]
            reasoning += delta.get("reasoning") or ""
            for piece in delta.get("tool_calls", []):
                if piece["index"] != 0:
                    continue
                call_id = call_id or piece.get("id", "")
                name += piece.get("function", {}).get("name", "")
                arguments_text += piece.get("function", {}).get("arguments", "")
            finish_reason = choice.get("finish_reason") or finish_reason

        self.assertEqual(reasoning, "The user asks for the weather.")
        self.assertEqual((call_id, name, finish_reason), ("call_made_up", "get_weather", "tool_calls"))
        self.assertEqual(json.loads(arguments_text), {"city": "Paris"})

    def test_the_new_names_are_exported(self):
        for name in (
            "ChatCompletionChoice",
            "ChatCompletionMessageToolCall",
            "ChatCompletionStreamChoice",
            "ChatCompletionStreamDelta",
            "ChatCompletionStreamEvent",
            "ChatCompletionStreamToolCallDelta",
            "ChatCompletionStreamToolCallFunction",
            "ChatCompletionToolCallFunction",
            "ChatMessage",
            "ChatToolMessage",
            "RunInfraStreamError",
            "RunInfraStreamIncompleteError",
        ):
            with self.subTest(name=name):
                self.assertIn(name, runinfra.__all__)
                self.assertTrue(hasattr(runinfra, name))


class RunInfraPythonSdkPackageLinksTest(unittest.TestCase):
    def test_the_documentation_link_points_at_the_public_python_guide(self):
        root = Path(__file__).resolve().parents[2]
        pyproject = root.joinpath("python", "pyproject.toml").read_text(encoding="utf-8")
        package_json = json.loads(root.joinpath("typescript", "package.json").read_text(encoding="utf-8"))

        self.assertIn('Documentation = "https://www.rightnowai.co/docs/sdks/open-models/native-python"', pyproject)
        self.assertEqual(package_json["homepage"], "https://www.rightnowai.co/docs/sdks/open-models/native-typescript")

    def test_the_root_readme_says_once_that_the_same_key_works_at_the_other_public_host_and_the_default_host_stays(self):
        root = Path(__file__).resolve().parents[2]
        readme = root.joinpath("README.md").read_text(encoding="utf-8")

        self.assertEqual(readme.count("https://api.rightnowai.co/v1"), 1)
        self.assertEqual(inspect.signature(RunInfra.__init__).parameters["base_url"].default, "https://api.runinfra.ai/v1")


class _KeepAliveServer:
    """A local HTTP/1.1 server that records which client connection carried each request."""

    def __init__(self):
        import http.server
        import threading

        owner = self
        self.requests = []
        self.closed = threading.Event()
        self.drop_second_request = False
        self.close_after_answer = False

        class Handler(http.server.BaseHTTPRequestHandler):
            protocol_version = "HTTP/1.1"

            def log_message(self, *_args):
                pass

            def setup(self):
                super().setup()
                self.served = 0

            def answer(self):
                length = int(self.headers.get("Content-Length") or 0)
                body = self.rfile.read(length) if length else b""
                self.served += 1
                owner.requests.append((self.client_address[1], self.command, self.path, body, dict(self.headers)))
                if owner.drop_second_request and self.served == 2:
                    # The server ends the connection after reading the request and answers nothing.
                    self.close_connection = True
                    return
                if self.path.endswith("/stream"):
                    self.send_response(200)
                    self.send_header("Content-Type", "text/event-stream")
                    self.send_header("Transfer-Encoding", "chunked")
                    self.end_headers()
                    for line in (b"data: one\n\n", b"data: two\n\n"):
                        self.wfile.write(b"%x\r\n%s\r\n" % (len(line), line))
                    self.wfile.write(b"0\r\n\r\n")
                    return
                status = 404 if self.path.endswith("/missing") else 200
                payload = json.dumps({"path": self.path}).encode("utf-8")
                self.send_response(status)
                self.send_header("Content-Type", "application/json")
                self.send_header("Content-Length", str(len(payload)))
                self.end_headers()
                self.wfile.write(payload)
                if owner.close_after_answer:
                    # Closed with no Connection: close header, as a server that ends an idle connection does.
                    self.close_connection = True

            do_GET = answer
            do_POST = answer

        class Server(http.server.ThreadingHTTPServer):
            daemon_threads = True

            def shutdown_request(self, request):
                super().shutdown_request(request)
                owner.closed.set()

        self.server = Server(("127.0.0.1", 0), Handler)
        self.url = f"http://127.0.0.1:{self.server.server_address[1]}"
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()

    def connections(self):
        return len({port for port, *_rest in self.requests})

    def stop(self):
        self.server.shutdown()
        self.server.server_close()


class RunInfraPythonSdkKeepAliveTest(unittest.TestCase):
    def setUp(self):
        self.server = _KeepAliveServer()
        self.addCleanup(self.server.stop)
        self.addCleanup(runinfra._KEEPALIVE_POOL.close_idle)
        self.transport = runinfra._default_transport(5)

    def send(self, method, path, body=None, headers=None, stream=False):
        return self.transport(runinfra.RunInfraRequest(
            method=method,
            url=f"{self.server.url}{path}",
            headers={"Authorization": "Bearer made-up", **(headers or {})},
            body=body,
            stream=stream,
        ))

    def test_calls_in_a_row_share_one_connection(self):
        for _ in range(3):
            self.assertEqual(self.send("GET", "/v1/models").status, 200)
        self.assertEqual(self.send("POST", "/v1/chat/completions", body=b"{}", headers={"Content-Type": "application/json"}).status, 200)
        self.assertEqual(self.server.connections(), 1)
        _port, method, _path, body, headers = self.server.requests[-1]
        self.assertEqual((method, body, headers["Content-Type"]), ("POST", b"{}", "application/json"))
        self.assertEqual(headers["User-Agent"], f"Python-urllib/{runinfra.urllib.request.__version__}")

    def test_an_error_status_is_answered_and_keeps_the_connection(self):
        missing = self.send("GET", "/v1/missing")
        self.assertEqual((missing.status, json.loads(missing.body)), (404, {"path": "/v1/missing"}))
        self.assertEqual(self.send("GET", "/v1/models").status, 200)
        self.assertEqual(self.server.connections(), 1)

    def test_a_stream_read_to_its_end_gives_its_connection_back(self):
        streamed = self.send("POST", "/v1/stream", body=b"{}", stream=True)
        self.assertEqual(b"".join(streamed.body), b"data: one\n\ndata: two\n\n")
        self.send("GET", "/v1/models")
        self.assertEqual(self.server.connections(), 1)

    def test_a_stream_left_unread_never_lends_its_connection(self):
        streamed = self.send("POST", "/v1/stream", body=b"{}", stream=True)
        lines = iter(streamed.body)
        self.assertEqual(next(lines), b"data: one\n")
        lines.close()
        self.assertEqual(self.send("GET", "/v1/models").status, 200)
        self.assertEqual(self.server.connections(), 2)

    def test_a_connection_the_server_closed_while_idle_is_not_used(self):
        self.server.close_after_answer = True
        self.send("GET", "/v1/models")
        self.assertTrue(self.server.closed.wait(5))
        host = self.server.url[len("http://"):]
        [idle] = [connections for key, connections in runinfra._KEEPALIVE_POOL._idle.items() if key[1] == host]
        self.assertEqual(len(idle), 1)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline and runinfra._connection_is_open(idle[0][0]):
            time.sleep(0.01)
        self.server.close_after_answer = False
        # A POST with no Idempotency-Key is never sent twice, so it answers only if the closed connection was not used.
        self.assertEqual(self.send("POST", "/v1/chat/completions", body=b"{}").status, 200)
        self.assertEqual([method for _port, method, *_rest in self.server.requests], ["GET", "POST"])
        self.assertEqual(self.server.connections(), 2)

    def test_a_post_the_server_dropped_on_a_reused_connection_is_not_sent_again(self):
        self.server.drop_second_request = True
        self.send("GET", "/v1/models")
        with self.assertRaises(Exception):
            self.send("POST", "/v1/chat/completions", body=b"{}")
        # The server read the request: without an Idempotency-Key it may have run it, so it is sent once.
        self.assertEqual([method for _port, method, *_rest in self.server.requests], ["GET", "POST"])

    def test_a_replayable_call_the_server_dropped_on_a_reused_connection_is_sent_once_more(self):
        self.server.drop_second_request = True
        self.send("GET", "/v1/models")
        answered = self.send("POST", "/v1/chat/completions", body=b"{}", headers={"Idempotency-Key": "made-up-key"})
        self.assertEqual(answered.status, 200)
        self.assertEqual([method for _port, method, *_rest in self.server.requests], ["GET", "POST", "POST"])
        self.assertEqual(self.server.connections(), 2)

    def test_urllibs_own_opener_from_an_earlier_urlopen_keeps_the_pool(self):
        with patch.object(runinfra.urllib.request, "_opener", runinfra.urllib.request.build_opener()):
            for _ in range(2):
                self.assertEqual(self.send("GET", "/v1/models").status, 200)
        self.assertEqual(self.server.connections(), 1)

    def test_an_opener_the_application_installed_carries_the_call(self):
        opened = []
        cookies = runinfra.urllib.request.HTTPCookieProcessor()
        with patch.object(runinfra.urllib.request, "_opener", runinfra.urllib.request.build_opener(cookies)), \
                patch("urllib.request.urlopen", side_effect=lambda request, timeout=None: opened.append(request.full_url) or FakeHttpAnswer()):
            self.assertEqual(self.send("GET", "/v1/models").status, 200)
        self.assertEqual(opened, [f"{self.server.url}/v1/models"])
        self.assertEqual(self.server.requests, [])

    def test_a_proxy_from_the_environment_goes_through_urllib(self):
        opened = []
        with patch.object(runinfra, "_URLLIB_PROXIES", {"http": "http://proxy.invalid:3128"}), \
                patch("urllib.request.proxy_bypass", return_value=False), \
                patch("urllib.request.urlopen", side_effect=lambda request, timeout=None: opened.append(request.full_url) or FakeHttpAnswer()):
            self.assertEqual(self.send("GET", "/v1/models").status, 200)
        self.assertEqual(opened, [f"{self.server.url}/v1/models"])
        self.assertEqual(self.server.requests, [])


if __name__ == "__main__":
    unittest.main()

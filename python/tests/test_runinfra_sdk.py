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
import traceback
import unittest
import warnings
import zipfile
from collections import UserDict
from email.utils import formatdate
from pathlib import Path
from typing import Literal, Union, get_type_hints
from unittest.mock import patch

try:
    from typing import get_overloads
except ImportError:  # Python 3.9 and 3.10
    from typing_extensions import get_overloads

import runinfra
from runinfra import (
    __version__,
    AuthenticationError,
    ChatCompletionResponse,
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
    RunInfraStreamParseError,
    RunInfraTimeoutError,
    TranscriptionResponse,
    WebhookVerificationError,
    construct_webhook_event,
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

    def test_readme_documents_voice_pipeline_as_experimental_instead_of_unsupported(self):
        readme = Path(__file__).resolve().parents[1].joinpath("README.md").read_text()
        changelog = Path(__file__).resolve().parents[1].joinpath("CHANGELOG.md").read_text()
        source = Path(__file__).resolve().parents[1].joinpath("runinfra", "__init__.py").read_text()

        self.assertIn(
            "| Voice pipeline | `client.voice.pipeline.create` | **Experimental**, pipeline-scoped route, not live-canary verified |",
            readme,
        )
        self.assertNotIn("Voice pipeline | `client.voice.pipeline.create` | Not shipped", readme)
        self.assertNotIn("client.voice.pipeline.create` is not shipped", changelog)
        self.assertIn("client.voice.pipeline.create` posts audio to the pipeline-scoped `/pipeline` route", changelog)
        voice_start = source.index("class _Voice:")
        runinfra_start = source.index("class RunInfra:", voice_start)
        voice_block = source[voice_start:runinfra_start]
        self.assertIn("[EXPERIMENTAL] As of v0.1.4, this method has NOT been verified end-to-end", voice_block)
        self.assertIn("Live-canary verification is tracked for v1.0.0 GA", voice_block)

    def test_pyproject_uses_non_deprecated_license_metadata(self):
        pyproject = Path(__file__).resolve().parents[1].joinpath("pyproject.toml").read_text()

        self.assertIn('license = "LicenseRef-Proprietary"', pyproject)
        self.assertIn('license-files = ["LICENSE"]', pyproject)
        self.assertIn("LLM and embeddings contract-tested", pyproject)
        self.assertNotIn("LLM + embeddings tested", pyproject)
        self.assertNotIn('license = { file = "LICENSE" }', pyproject)

    def test_docs_do_not_overclaim_embeddings_live_verification(self):
        package_readme = Path(__file__).resolve().parents[1].joinpath("README.md").read_text()
        root_readme = Path(__file__).resolve().parents[2].joinpath("README.md").read_text()
        agent_notes = Path(__file__).resolve().parents[2].joinpath("AGENT-NOTES.md").read_text()
        changelog = Path(__file__).resolve().parents[1].joinpath("CHANGELOG.md").read_text()

        self.assertIn(
            "| Embeddings | `client.embeddings.create` | Beta, contract-tested. Not strict live-canary verified in the current promotion artifacts |",
            package_readme,
        )
        self.assertIn(
            "| Embeddings | Beta, contract-tested. Not strict live-canary verified in the current promotion artifacts |",
            root_readme,
        )
        self.assertIn(
            "| Chat completions, Responses | Beta, contract-tested. Current 0.1.4 promotion artifacts are not strict-live green; publish requires fresh production artifact canaries with zero skipped or failed rows |",
            root_readme,
        )
        self.assertNotIn("Strict live source canaries currently pass chat/responses rows", root_readme)
        self.assertIn(
            "| `client.embeddings.create` | Beta, contract-tested. Not strict live-canary verified in the current promotion artifacts |",
            agent_notes,
        )
        self.assertIn(
            "Current 0.1.4 promotion artifacts are not strict-live green; publish requires fresh production artifact canaries with zero skipped or failed rows",
            package_readme,
        )
        self.assertIn(
            "Current 0.1.4 promotion artifacts are not strict-live green; publish requires fresh production artifact canaries with zero skipped or failed rows",
            agent_notes,
        )
        self.assertNotIn("Strict live source canaries currently pass chat/responses rows", package_readme)
        self.assertNotIn("Strict live source canaries currently pass chat/responses rows", agent_notes)
        normalized_changelog = " ".join(changelog.split())
        self.assertIn(
            "blocked for embeddings until the strict promotion artifacts include a deployed embedding target",
            normalized_changelog,
        )
        for text in (package_readme, root_readme, agent_notes, changelog):
            self.assertNotIn("LLM + embeddings tested", text)
            self.assertNotIn("Live-canary coverage is currently restricted to LLM + embeddings", text)
            self.assertNotIn("streaming final/slow-consumer rows pass against production", text)

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
        self.assertIn("webhook delivery create/list methods are not part of the GA public SDK surface", readme)
        self.assertNotIn("client.webhooks.create", readme)
        self.assertNotIn("client.webhooks.list", readme)
        self.assertIn("`UnsupportedOperationError` remains exported for compatibility", readme)
        self.assertIn("## [0.1.4]", changelog)
        self.assertIn("Removed unshipped webhook delivery `create` / `list` methods", changelog)
        self.assertIn("`webhooks.delivery_surface.absent`", changelog)

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
        self.assertIn("Live-gated native SDK subset", readme)
        self.assertIn("will be treated as verified only after the strict live canaries pass", readme)
        self.assertIn("`openai.params.chat.completions`", readme)
        self.assertIn("`openai.params.chat.stream_options`", readme)
        self.assertIn("`openai.params.responses`", readme)
        self.assertIn("`openai.params.embeddings`", readme)
        self.assertIn("`openai.params.images`", readme)
        self.assertIn("`openai.params.audio.speech`", readme)
        self.assertIn("`openai.params.audio.transcriptions`", readme)
        self.assertIn("openai.params.images", live_canaries)
        self.assertIn("openai.params.audio.speech", live_canaries)
        self.assertIn("openai.params.audio.transcriptions", live_canaries)
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
        self.assertIn('`encoding_format` values other than `"float"`', readme)
        self.assertIn('`response_format` values other than `"json"` or `"verbose_json"`', readme)
        self.assertIn("Unsupported OpenAI-style body parameters must fail with a clear traced 4xx", readme)
        self.assertIn("error.model.not_found", live_canaries)
        self.assertIn("error.body.unsupported_parameter", live_canaries)
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
        self.assertIn("`RunInfra` is intentionally sync-only in v0.1.4", readme)
        self.assertIn("does not block the event loop", readme)
        self.assertIn("`AsyncRunInfra` client yet", readme)

    def test_readme_documents_public_repo_promotion_without_stale_monorepo_commands(self):
        root = Path(__file__).resolve().parents[2]
        readme = Path(__file__).resolve().parents[1].joinpath("README.md").read_text()
        agent_notes = root.joinpath("AGENT-NOTES.md").read_text()
        live_canaries = root.joinpath("LIVE-CANARIES.md").read_text()

        self.assertIn("For production promotion", readme)
        self.assertIn("This public repo now includes live-canary runners for both SDKs.", readme)
        self.assertIn("The publish workflow builds the npm tarball, Python wheel, and Python sdist once", readme)
        self.assertIn("real publish runs the strict promotion gate", readme)
        self.assertIn("publishes the same downloaded artifacts", readme)
        self.assertIn("The artifact clean-install gate imports the npm tarball, the Python wheel, and", readme)
        self.assertIn("an sdist-built Python wheel", readme)
        self.assertIn("RUNINFRA_ASR_FIXTURE_BASE64", readme)
        self.assertIn("RUNINFRA_VOICE_PIPELINE_AUDIO_BASE64", readme)
        self.assertIn("node scripts/verify-workflow-policy.mjs", readme)
        self.assertIn("node scripts/verify-github-security-status.mjs --repo RightNow-AI/runinfra-sdk", readme)
        self.assertIn("node scripts/verify-version-sync.mjs", readme)
        self.assertIn("node scripts/verify-npm-package.mjs typescript/runinfra-sdk-*.tgz", readme)
        self.assertIn("python scripts/verify-python-package.py python/dist", readme)
        self.assertIn("node scripts/verify-clean-installs.mjs --package both --mode artifact", readme)
        self.assertIn("node scripts/run-sdk-live-canaries.mjs --verify-surface-coverage", readme)
        self.assertIn(
            "node scripts/run-sdk-live-canaries.mjs --preflight --strict --report artifacts/sdk/live-canary-readiness.json",
            readme,
        )
        self.assertIn(
            "node scripts/run-sdk-live-canaries.mjs --package-source artifact --strict --report artifacts/sdk/live-canary.json",
            readme,
        )
        self.assertIn(
            "node scripts/verify-promotion-reports.mjs --readiness artifacts/sdk/live-canary-readiness.json --live artifacts/sdk/live-canary.json --artifacts-root .",
            readme,
        )
        surface_coverage_index = readme.index("node scripts/run-sdk-live-canaries.mjs --verify-surface-coverage")
        preflight_index = readme.index(
            "node scripts/run-sdk-live-canaries.mjs --preflight --strict --report artifacts/sdk/live-canary-readiness.json"
        )
        live_canary_index = readme.index(
            "node scripts/run-sdk-live-canaries.mjs --package-source artifact --strict --report artifacts/sdk/live-canary.json"
        )
        promotion_report_index = readme.index(
            "node scripts/verify-promotion-reports.mjs --readiness artifacts/sdk/live-canary-readiness.json --live artifacts/sdk/live-canary.json --artifacts-root ."
        )
        self.assertLess(surface_coverage_index, preflight_index)
        self.assertLess(preflight_index, live_canary_index)
        self.assertLess(live_canary_index, promotion_report_index)
        self.assertIn(
            "gh workflow run publish.yml --repo RightNow-AI/runinfra-sdk --ref main -f package=both -f dry_run=true -f confirm_version=<version>",
            readme,
        )
        self.assertIn("A real publish must also prove registry install/import", readme)
        self.assertIn(
            "node scripts/verify-clean-installs.mjs --package both --mode registry --version <version>",
            readme,
        )
        self.assertIn("Run the surface-coverage check before preflight", readme)
        self.assertIn("Then run the strict preflight", readme)
        self.assertIn("Then run the strict live canary matrix against the exact production gateway", readme)
        self.assertIn("candidate.sourceDigestSha256", live_canaries)
        self.assertIn("candidate.artifacts", live_canaries)
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
        self.assertNotIn("The simplified workflow doesn't run the strict gate scripts", agent_notes)
        self.assertIn("Do not use npm or PyPI tokens", readme)
        self.assertNotIn("pnpm verify:sdk-release", readme)
        self.assertNotIn("pnpm test:sdk-canary:live", readme)
        self.assertNotIn("RUNINFRA_SDK_CI_TOKEN", readme)

    def test_docs_document_safe_live_canary_env_file_flag(self):
        root = Path(__file__).resolve().parents[2]
        docs = [
            root.joinpath("README.md").read_text(),
            root.joinpath("LIVE-CANARIES.md").read_text(),
            root.joinpath("AGENT-NOTES.md").read_text(),
            root.joinpath("typescript", "README.md").read_text(),
            root.joinpath("python", "README.md").read_text(),
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

    def test_retries_ignore_unreasonable_retry_after_headers(self):
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

        with patch("runinfra.time.sleep") as sleep:
            self.assertEqual(client.models.list()["data"], [])

        sleep.assert_called_once_with(0.25)
        self.assertEqual(len(transport.calls), 2)

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

                with patch("runinfra.time.sleep") as sleep:
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

        with patch("urllib.request.urlopen", return_value=FailingBodyResponse()):
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

        with patch("urllib.request.urlopen", return_value=FailingBodyResponse()):
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

        with patch("urllib.request.urlopen", side_effect=fake_urlopen), patch("runinfra.time.sleep") as sleep:
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

        with patch("urllib.request.urlopen", side_effect=fake_urlopen), patch("runinfra.time.sleep") as sleep:
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

        with patch("urllib.request.urlopen", side_effect=fake_urlopen), patch("runinfra.time.sleep") as sleep:
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

        with patch("urllib.request.urlopen", return_value=TimeoutBodyResponse()):
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
                    b'data: {"choices":[{"delta":{"content":"lo"}}]}'
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
            yield b'data: {"choices":[{"delta":{"content":"lo"}}]}'

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


if __name__ == "__main__":
    unittest.main()

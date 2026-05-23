import hashlib
import hmac
import importlib.util
import json
import math
import os
import unittest
from collections import UserDict
from email.utils import formatdate
from pathlib import Path
from typing import Union, get_type_hints
from unittest.mock import patch

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

    def test_readme_documents_voice_pipeline_as_experimental_instead_of_unsupported(self):
        readme = Path(__file__).resolve().parents[1].joinpath("README.md").read_text()
        changelog = Path(__file__).resolve().parents[1].joinpath("CHANGELOG.md").read_text()

        self.assertIn(
            "| Voice pipeline | `client.voice.pipeline.create` | **Experimental**, pipeline-scoped route, not live-canary verified |",
            readme,
        )
        self.assertNotIn("Voice pipeline | `client.voice.pipeline.create` | Not shipped", readme)
        self.assertNotIn("client.voice.pipeline.create` is not shipped", changelog)
        self.assertIn("client.voice.pipeline.create` posts audio to the pipeline-scoped `/pipeline` route", changelog)

    def test_pyproject_uses_non_deprecated_license_metadata(self):
        pyproject = Path(__file__).resolve().parents[1].joinpath("pyproject.toml").read_text()

        self.assertIn('license = "LicenseRef-Proprietary"', pyproject)
        self.assertIn('license-files = ["LICENSE"]', pyproject)
        self.assertNotIn('license = { file = "LICENSE" }', pyproject)

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

    def test_readme_documents_exact_replay_safe_non_streaming_json_operations(self):
        readme = Path(__file__).resolve().parents[1].joinpath("README.md").read_text()

        self.assertIn("responses.create()", readme)
        self.assertIn("non-streaming `chat.completions.create()`", readme)
        self.assertIn("embeddings.create()", readme)
        self.assertIn("images.generate()", readme)
        self.assertIn("Streaming calls, binary TTS responses, and multipart ASR uploads are sent once", readme)
        self.assertIn("even when you provide an idempotency key", readme)
        self.assertIn("The gateway still binds idempotency keys for TTS and ASR", readme)

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
        self.assertIn("ASR file must be bytes or bytearray", readme)
        self.assertIn("ASR multipart filenames, content types, and extra form field names and values", readme)

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

    def test_readme_documents_sync_only_async_runtime_guidance(self):
        readme = Path(__file__).resolve().parents[1].joinpath("README.md").read_text()

        self.assertIn("## Async Python runtimes", readme)
        self.assertIn("`RunInfra` is intentionally sync-only in v0.1.4", readme)
        self.assertIn("does not block the event loop", readme)
        self.assertIn("`AsyncRunInfra` client yet", readme)

    def test_readme_documents_public_repo_promotion_without_stale_monorepo_commands(self):
        readme = Path(__file__).resolve().parents[1].joinpath("README.md").read_text()

        self.assertIn("For production promotion", readme)
        self.assertIn("This public repo now includes live-canary runners for both SDKs.", readme)
        self.assertIn("node scripts/verify-workflow-policy.mjs", readme)
        self.assertIn("node scripts/verify-version-sync.mjs", readme)
        self.assertIn("node scripts/verify-npm-package.mjs typescript/runinfra-sdk-*.tgz", readme)
        self.assertIn("python scripts/verify-python-package.py python/dist", readme)
        self.assertIn("node scripts/verify-clean-installs.mjs --package both --mode artifact", readme)
        self.assertIn(
            "node scripts/run-sdk-live-canaries.mjs --preflight --strict --report artifacts/sdk/live-canary-readiness.json",
            readme,
        )
        self.assertIn(
            "node scripts/run-sdk-live-canaries.mjs --package-source artifact --strict --report artifacts/sdk/live-canary.json",
            readme,
        )
        self.assertIn(
            "gh workflow run publish.yml --repo RightNow-AI/runinfra-sdk --ref main -f package=both -f dry_run=true -f confirm_version=<version>",
            readme,
        )
        self.assertIn("A real publish must also prove registry install/import", readme)
        self.assertIn(
            "node scripts/verify-clean-installs.mjs --package both --mode registry --version <version>",
            readme,
        )
        self.assertIn("Run the strict preflight first", readme)
        self.assertIn("Then run the strict live canary matrix against the exact production gateway", readme)
        self.assertIn("Do not use npm or PyPI tokens", readme)
        self.assertNotIn("pnpm verify:sdk-release", readme)
        self.assertNotIn("pnpm test:sdk-canary:live", readme)
        self.assertNotIn("RUNINFRA_SDK_CI_TOKEN", readme)

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
            ".npmrc",
            "package/.npmrc",
            ".env",
            ".env.local",
            "package/.env.local",
            "/tmp/project/.env.local",
        ]

        for sample in samples:
            with self.subTest(sample=sample[:12]):
                self.assertTrue(verifier.has_forbidden_content(sample.encode("utf-8")))

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
                    metadata={"value": math.nan},
                ),
                "JSON request body must be serializable and contain only finite numbers",
            ),
            (
                lambda client: client.responses.create(
                    model="llama",
                    input="Hi",
                    metadata=object(),
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
                {"content-type": "application/json", "x-request-id": "req-server-123"},
                json.dumps({"object": "list", "data": []}).encode("utf-8"),
            )
        )
        client = RunInfra(api_key="sk-ri-test", transport=transport)

        response = client.models.list()

        self.assertEqual(response["_request_id"], "req-server-123")

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
            {"bad\r\nfield": "value"},
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

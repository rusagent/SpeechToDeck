"""Composition root and main.py facade tests (spec §30, §31, §82, §90).

The fail-closed facade test runs against the repository's real committed
manifests (unpinned runtime → RUNTIME_START_FAILED). The full-pipeline test
runs the real fixture daemon through composition: real supervision, control
CLI, event-driven transcription delivery — no STT hardware.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from pathlib import Path

import main
import pytest
from backend.composition import Application, compose
from backend.domain.errors import RuntimeUnavailableError, SpeechError
from conftest import (
    REAL_MODELS_MANIFEST,
    REAL_RUNTIME_MANIFEST,
    FakeEventPublisher,
    build_fixture_binary,
    wait_until,
    write_pinned_runtime_manifest,
)

SPEC_CALLABLES = {
    "get_capabilities",
    "get_status",
    "start_recording",
    "stop_recording",
    "cancel_recording",
    "get_settings",
    "update_settings",
    "list_models",
    "download_model",
    "cancel_model_download",
    "restart_runtime",
}


def test_plugin_imports_without_decky_and_exposes_spec_callables() -> None:
    plugin = main.Plugin()
    for name in SPEC_CALLABLES:
        assert callable(getattr(plugin, name)), name
    for hook in ("_main", "_unload", "_uninstall", "_migration"):
        assert callable(getattr(plugin, hook)), hook


def build_plugin_roots(tmp_path: Path, *, with_fake_model: bool = False) -> tuple[Path, Path]:
    """Real plugin root layout: committed defaults, empty bin/."""
    root = tmp_path / "plugin-root"
    defaults = root / "defaults"
    defaults.mkdir(parents=True)
    manifest_payload = json.loads(REAL_MODELS_MANIFEST.read_text(encoding="utf-8"))
    data_dir = tmp_path / "data"
    if with_fake_model:
        # Install the default model (digest patched in) so startup passes the
        # §51 integrity gate and failures below isolate the RUNTIME path.
        payload = write_fake_model(data_dir, "base", "ggml-base.bin")
        digest = hashlib.sha256(payload).hexdigest()
        for entry in manifest_payload["models"]:
            if entry["id"] == "base":
                entry["sha256"] = digest
    (defaults / "models.json").write_text(json.dumps(manifest_payload))
    # The committed runtime manifest is intentionally unpinned → fail closed.
    (defaults / "runtime-manifest.json").write_bytes(REAL_RUNTIME_MANIFEST.read_bytes())
    return root, data_dir


def test_facade_fails_closed_against_unpinned_runtime(tmp_path: Path) -> None:
    async def scenario() -> None:
        root, data_dir = build_plugin_roots(tmp_path, with_fake_model=True)
        publisher = FakeEventPublisher()
        app = compose(plugin_root=root, data_dir=data_dir, event_publisher=publisher)
        plugin = main.Plugin()
        plugin._app = app
        try:
            await app.start()  # must not raise (§82/§69: surfaced, not fatal)
            unavailable = [
                p for p in publisher.payloads("runtime_status") if p.get("state") == "unavailable"
            ]
            assert unavailable  # startup surfaced the failure
            assert any("pinned" in str(p.get("detail", "")) for p in unavailable)

            status = await plugin.get_status()
            assert status["ok"] is True
            assert status["runtime"]["running"] is False

            capabilities = await plugin.get_capabilities()
            assert capabilities["protocolVersion"] == 1
            assert capabilities["speechRuntimeAvailable"] is False

            models = await plugin.list_models()
            assert [m["id"] for m in models["models"]] == ["tiny", "base", "small"]
            installed_flags = {m["id"]: m["installed"] for m in models["models"]}
            assert installed_flags == {"tiny": False, "base": True, "small": False}

            settings = await plugin.get_settings()
            assert settings["modelId"] == "base"  # §54 default
            updated = await plugin.update_settings(
                {"maxRecordingSeconds": 90, "outputMode": "clipboard-only"}
            )
            assert updated["maxRecordingSeconds"] == 90
            assert updated["outputMode"] == "clipboard-only"
            persisted = json.loads((data_dir / "settings.json").read_text(encoding="utf-8"))
            assert persisted["maxRecordingSeconds"] == 90
            assert persisted["outputMode"] == "clipboard-only"

            # Runtime down (unpinned) → the runtime guard fires first.
            missing = await plugin.start_recording("session-1")
            assert missing["ok"] is False
            assert missing["code"] == "RUNTIME_UNAVAILABLE"

            # Invalid ids never reach the network (§109).
            bad_download = await plugin.download_model("../../etc/passwd")
            assert bad_download["code"] == "MODEL_NOT_INSTALLED"

            cancelled = await plugin.cancel_model_download()
            assert cancelled == {"ok": True, "cancelled": False}

            # §69: explicit restart against the unpinned manifest fails closed.
            restarted = await plugin.restart_runtime()
            assert restarted["ok"] is False
            assert restarted["code"] == "RUNTIME_START_FAILED"

            await app.dispose()
            await app.dispose()  # idempotent (§83)
            assert not (data_dir / "runtime" / "transcript.out").exists()
        finally:
            await app.dispose()

    asyncio.run(scenario())


def write_fake_model(data_dir: Path, model_id: str, filename: str) -> bytes:
    payload = f"fake-{model_id}-model".encode() * 64
    models_dir = data_dir / "models"
    models_dir.mkdir(parents=True, exist_ok=True)
    (models_dir / filename).write_bytes(payload)
    return payload


def test_full_pipeline_with_real_fixture_daemon(tmp_path: Path) -> None:
    async def scenario() -> None:
        root, data_dir = build_plugin_roots(tmp_path)
        binary = build_fixture_binary(root)
        write_pinned_runtime_manifest(root, binary)

        # Install a fake "base" model whose digest matches the manifest entry
        # we patch in, so startup passes the §51/§53 integrity gate.
        fake_model = write_fake_model(data_dir, "base", "ggml-base.bin")
        manifest_payload = json.loads(REAL_MODELS_MANIFEST.read_text(encoding="utf-8"))
        for entry in manifest_payload["models"]:
            if entry["id"] == "base":
                entry["sha256"] = hashlib.sha256(fake_model).hexdigest()
        (root / "defaults" / "models.json").write_text(json.dumps(manifest_payload))

        publisher = FakeEventPublisher()
        app: Application = compose(plugin_root=root, data_dir=data_dir, event_publisher=publisher)
        try:
            await app.start()
            assert await wait_until(app.supervisor.is_running, timeout=5.0)

            started = await app.start_recording("sess-1")
            assert started == {"sessionId": "sess-1"}
            assert await wait_until(
                lambda: (
                    app.supervisor.is_running()
                    and json.loads(app.paths.status_file.read_text(encoding="utf-8"))["state"]
                    == "recording"
                ),
                timeout=3.0,
            )

            await app.stop_recording("sess-1")
            assert await wait_until(
                lambda: any(
                    p.get("sessionId") == "sess-1" for p in publisher.payloads("transcript_ready")
                ),
                timeout=3.0,
            )
            payload = next(
                p for p in publisher.payloads("transcript_ready") if p.get("sessionId") == "sess-1"
            )
            assert payload["protocolVersion"] == 1
            assert payload["text"] == "hello world"
            metrics = payload["metrics"]
            assert metrics["modelId"] == "base"
            assert metrics["computeBackend"] in ("cpu", "vulkan", "auto")
            assert "audioDurationMs" in metrics and "transcriptionDurationMs" in metrics

            # §72 through the full stack: cancel emits no transcript.
            await app.start_recording("sess-2")
            await app.cancel_recording("sess-2")
            assert not [
                p for p in publisher.payloads("transcript_ready") if p.get("sessionId") == "sess-2"
            ]

            # Duplicate session through the facade: stable conflict code.
            await app.start_recording("sess-3")
            conflict = await _facade_call(app.start_recording("sess-4"))
            assert conflict["code"] == "SESSION_CONFLICT"
            await app.cancel_recording("sess-3")

            # Runtime status events flowed from the real daemon status file.
            assert any(p.get("state") == "recording" for p in publisher.payloads("runtime_status"))

            await app.dispose()
            assert app.supervisor.last_exit_code == 0  # clean §38 shutdown
            assert not (data_dir / "runtime" / "transcript.out").exists()
        finally:
            await app.dispose()

    asyncio.run(scenario())


async def _facade_call(operation: object) -> dict[str, object]:
    try:
        result = await operation  # type: ignore[arg-type]
    except SpeechError as error:
        return {"ok": False, **error.payload()}
    assert isinstance(result, dict)
    return {"ok": True, **result}


def test_start_recording_requires_running_runtime(tmp_path: Path) -> None:
    async def scenario() -> None:
        root, data_dir = build_plugin_roots(tmp_path)
        app = compose(plugin_root=root, data_dir=data_dir, event_publisher=FakeEventPublisher())
        try:
            with pytest.raises(RuntimeUnavailableError):
                await app.start_recording("session-1")  # never started
        finally:
            await app.dispose()

    asyncio.run(scenario())

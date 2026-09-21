from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
from collections.abc import AsyncIterator
from pathlib import Path

import backend.composition
import main
import pytest
from backend.composition import MODEL_DOWNLOAD_RETRY_DELAYS_S, Application, compose
from backend.domain.errors import (
    RuntimeStartError,
    RuntimeUnavailableError,
    SpeechError,
    TransientModelDownloadError,
)
from conftest import (
    REAL_MODELS_MANIFEST,
    FakeEventPublisher,
    build_fixture_binary,
    wait_until,
    write_pinned_runtime_manifest,
)

UNPINNED_MANIFEST_JSON = (
    '{"schemaVersion": 1, "artifacts": ['
    '{"id": "voxtype-avx2", "engine": "whisper", "arch": "x86_64", "variant": "cpu",'
    ' "version": "", "source": "", "sha256": "", "license": ""},'
    '{"id": "voxtype-vulkan", "engine": "whisper", "arch": "x86_64", "variant": "vulkan",'
    ' "version": "", "source": "", "sha256": "", "license": ""}]}'
)

RETRY_PAYLOAD = b"transient-retry-model-payload-" * 6144
CORRUPT_PAYLOAD = b"corrupt-download-not-matching-the-manifest-digest"

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
    "delete_model",
    "restart_runtime",
}


def test_plugin_imports_without_decky_and_exposes_spec_callables() -> None:
    plugin = main.Plugin()
    for name in SPEC_CALLABLES:
        assert callable(getattr(plugin, name)), name
    for hook in ("_main", "_unload", "_uninstall", "_migration"):
        assert callable(getattr(plugin, hook)), hook


def build_plugin_roots(tmp_path: Path, *, with_fake_model: bool = False) -> tuple[Path, Path]:
    root = tmp_path / "plugin-root"
    defaults = root / "defaults"
    defaults.mkdir(parents=True)
    manifest_payload = json.loads(REAL_MODELS_MANIFEST.read_text(encoding="utf-8"))
    data_dir = tmp_path / "data"
    if with_fake_model:
        payload = write_fake_model(data_dir, "base", "ggml-base.bin")
        digest = hashlib.sha256(payload).hexdigest()
        for entry in manifest_payload["models"]:
            if entry["id"] == "base":
                entry["sha256"] = digest
    (defaults / "models.json").write_text(json.dumps(manifest_payload))
    (defaults / "runtime-manifest.json").write_text(UNPINNED_MANIFEST_JSON, encoding="utf-8")
    return root, data_dir


def test_get_capabilities_reports_backend_version_fail_soft(tmp_path: Path) -> None:

    async def scenario() -> None:
        root, data_dir = build_plugin_roots(tmp_path / "reported")
        (root / "package.json").write_text(
            json.dumps({"name": "SpeechToDeck", "version": "9.9.9-test"}), encoding="utf-8"
        )
        app = compose(plugin_root=root, data_dir=data_dir, event_publisher=FakeEventPublisher())
        capabilities = await app.get_capabilities()
        assert capabilities["backendVersion"] == "9.9.9-test"

        missing_root, missing_data = build_plugin_roots(tmp_path / "missing")
        app_missing = compose(
            plugin_root=missing_root,
            data_dir=missing_data,
            event_publisher=FakeEventPublisher(),
        )
        assert "backendVersion" not in await app_missing.get_capabilities()

        broken_root, broken_data = build_plugin_roots(tmp_path / "broken")
        (broken_root / "package.json").write_text("{not json", encoding="utf-8")
        app_broken = compose(
            plugin_root=broken_root,
            data_dir=broken_data,
            event_publisher=FakeEventPublisher(),
        )
        assert "backendVersion" not in await app_broken.get_capabilities()

    asyncio.run(scenario())


def test_facade_fails_closed_against_unpinned_runtime(tmp_path: Path) -> None:
    async def scenario() -> None:
        root, data_dir = build_plugin_roots(tmp_path, with_fake_model=True)
        publisher = FakeEventPublisher()
        app = compose(plugin_root=root, data_dir=data_dir, event_publisher=publisher)
        plugin = main.Plugin()
        plugin._app = app
        try:
            await app.start()
            unavailable = [
                p for p in publisher.payloads("runtime_status") if p.get("state") == "unavailable"
            ]
            assert unavailable
            assert any("pinned" in str(p.get("detail", "")) for p in unavailable)

            status = await plugin.get_status()
            assert status["ok"] is True
            assert status["runtime"]["running"] is False

            capabilities = await plugin.get_capabilities()
            assert capabilities["protocolVersion"] == 1
            assert capabilities["speechRuntimeAvailable"] is False
            assert capabilities["microphoneAvailable"] is False
            assert capabilities["cpuAvailable"] is True
            assert capabilities["vulkanAvailable"] is False
            assert capabilities["modelInstalled"] is True

            models = await plugin.list_models()
            assert [m["id"] for m in models["models"]] == [
                "tiny",
                "base",
                "small",
                "whisper-large-v3-turbo-q5_0",
                "whisper-large-v3-turbo",
                "distil-small-en",
                "distil-medium-en",
                "whisper-large-v3-turbo-german-q5_0",
                "whisper-large-v3-turbo-german-f16",
                "whisper-large-v3-french-q5_0",
                "kotoba-whisper-v2.0-q5_0",
                "kotoba-whisper-v2.0-f16",
            ]
            installed_flags = {m["id"]: m["installed"] for m in models["models"]}
            assert installed_flags == {
                "tiny": False,
                "base": True,
                "small": False,
                "whisper-large-v3-turbo-q5_0": False,
                "whisper-large-v3-turbo": False,
                "distil-small-en": False,
                "distil-medium-en": False,
                "whisper-large-v3-turbo-german-q5_0": False,
                "whisper-large-v3-turbo-german-f16": False,
                "whisper-large-v3-french-q5_0": False,
                "kotoba-whisper-v2.0-q5_0": False,
                "kotoba-whisper-v2.0-f16": False,
            }
            distil = next(m for m in models["models"] if m["id"] == "distil-small-en")
            assert distil["languages"] == ["en"]
            assert distil["multilingual"] is False
            assert isinstance(distil["description"], str) and distil["description"]
            assert "languages" not in models["models"][0]
            assert "description" not in models["models"][0]

            settings = await plugin.get_settings()
            assert settings["modelId"] == "base"
            updated = await plugin.update_settings({"language": "de"})
            assert updated["language"] == "de"
            assert "maxRecordingSeconds" not in updated
            persisted = json.loads((data_dir / "settings.json").read_text(encoding="utf-8"))
            assert persisted["language"] == "de"
            assert "maxRecordingSeconds" not in persisted
            assert "vadEnabled" not in persisted
            assert "outputMode" not in persisted

            missing = await plugin.start_recording("session-1")
            assert missing["ok"] is False
            assert missing["code"] == "RUNTIME_UNAVAILABLE"

            bad_download = await plugin.download_model("../../etc/passwd")
            assert bad_download["code"] == "MODEL_NOT_INSTALLED"

            cancelled = await plugin.cancel_model_download()
            assert cancelled == {"ok": True, "cancelled": False}

            restarted = await plugin.restart_runtime()
            assert restarted == {"ok": True, "restarted": True}
            failed = [p for p in publisher.payloads("setup_progress") if p.get("step") == "failed"]
            assert failed
            assert failed[-1]["error"] == {"code": "RUNTIME_START_FAILED"}
            status_after_restart = await plugin.get_status()
            assert status_after_restart["runtime"]["lastFailure"] == {
                "code": "RUNTIME_START_FAILED",
                "stepIndex": 0,
            }

            await app.dispose()
            await app.dispose()
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


def compose_with_fixture_daemon(
    tmp_path: Path,
) -> tuple[Application, FakeEventPublisher, Path]:
    root, data_dir = build_plugin_roots(tmp_path)
    binary = build_fixture_binary(root)
    write_pinned_runtime_manifest(root, binary)

    manifest_payload = json.loads(REAL_MODELS_MANIFEST.read_text(encoding="utf-8"))
    for entry in manifest_payload["models"]:
        if entry["id"] in ("base", "tiny"):
            payload = write_fake_model(data_dir, entry["id"], entry["filename"])
            entry["sha256"] = hashlib.sha256(payload).hexdigest()
    (root / "defaults" / "models.json").write_text(json.dumps(manifest_payload))

    publisher = FakeEventPublisher()
    app: Application = compose(plugin_root=root, data_dir=data_dir, event_publisher=publisher)
    return app, publisher, data_dir


def test_full_pipeline_with_real_fixture_daemon(tmp_path: Path) -> None:
    async def scenario() -> None:
        app, publisher, data_dir = compose_with_fixture_daemon(tmp_path)
        try:
            await app.start()
            assert await wait_until(app.supervisor.is_running, timeout=5.0)

            started = await app.start_recording("sess-1")
            assert started == {"sessionId": "sess-1"}
            assert app.level_client.is_running
            assert await wait_until(
                lambda: (
                    app.supervisor.is_running()
                    and app.paths.status_file.read_text(encoding="utf-8").strip() == "recording"
                ),
                timeout=3.0,
            )

            await app.stop_recording("sess-1")
            assert not app.level_client.is_running
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
            assert payload["clipboard"] == "skipped"
            metrics = payload["metrics"]
            assert metrics["modelId"] == "base"
            assert metrics["computeBackend"] in ("cpu", "vulkan", "auto")
            assert "audioDurationMs" in metrics and "transcriptionDurationMs" in metrics

            await app.start_recording("sess-2")
            assert app.level_client.is_running
            await app.cancel_recording("sess-2")
            assert not app.level_client.is_running
            assert not [
                p for p in publisher.payloads("transcript_ready") if p.get("sessionId") == "sess-2"
            ]

            await app.start_recording("sess-3")
            conflict = await _facade_call(app.start_recording("sess-4"))
            assert conflict["code"] == "SESSION_CONFLICT"
            await app.cancel_recording("sess-3")

            assert any(p.get("state") == "recording" for p in publisher.payloads("runtime_status"))

            await app.dispose()
            assert app.supervisor.last_exit_code == 0
            assert not (data_dir / "runtime" / "transcript.out").exists()
        finally:
            await app.dispose()

    asyncio.run(scenario())


async def _facade_call(operation: object) -> dict[str, object]:
    try:
        result = await operation
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
                await app.start_recording("session-1")
        finally:
            await app.dispose()

    asyncio.run(scenario())


def test_update_settings_drives_runtime_lifecycle(tmp_path: Path) -> None:

    def starting_events(publisher: FakeEventPublisher) -> list[dict[str, object]]:
        return [p for p in publisher.payloads("runtime_status") if p.get("state") == "starting"]

    async def scenario() -> None:
        app, publisher, data_dir = compose_with_fixture_daemon(tmp_path)
        try:
            await app.start()
            assert await wait_until(app.supervisor.is_running, timeout=5.0)

            disabled = await app.update_settings({"enabled": False})
            assert disabled["enabled"] is False
            assert await wait_until(lambda: not app.supervisor.is_running(), timeout=5.0)
            assert app.supervisor.last_exit_code == 0
            persisted = json.loads((data_dir / "settings.json").read_text(encoding="utf-8"))
            assert persisted["enabled"] is False
            with pytest.raises(RuntimeUnavailableError):
                await app.start_recording("sess-disabled")

            enabled = await app.update_settings({"enabled": True})
            assert enabled["enabled"] is True
            assert await wait_until(app.supervisor.is_running, timeout=5.0)
            started = await app.start_recording("sess-after-enable")
            assert started == {"sessionId": "sess-after-enable"}
            await app.cancel_recording("sess-after-enable")

            starting_before = len(starting_events(publisher))
            updated = await app.update_settings({"modelId": "tiny"})
            assert updated["modelId"] == "tiny"
            assert await wait_until(app.supervisor.is_running, timeout=5.0)
            assert len(starting_events(publisher)) == starting_before + 1
            log_line = "models/ggml-tiny.bin"

            async def new_model_in_daemon_log() -> bool:
                try:
                    return log_line in app.paths.daemon_log.read_text(encoding="utf-8")
                except FileNotFoundError:
                    return False

            assert await wait_until(new_model_in_daemon_log, timeout=5.0)

            starting_before = len(starting_events(publisher))
            current = await app.get_settings()
            current.pop("schemaVersion")
            await app.update_settings(current)
            assert len(starting_events(publisher)) == starting_before
            assert app.supervisor.is_running()
        finally:
            await app.dispose()

    asyncio.run(scenario())


def _gate_daemon_spawn(app: Application) -> tuple[asyncio.Event, asyncio.Event]:

    entered = asyncio.Event()
    gate = asyncio.Event()
    original_start = app.supervisor.start

    async def gated_start(settings: object) -> None:
        entered.set()
        await gate.wait()
        await original_start(settings)

    app.supervisor.start = gated_start

    async def instant_cancel() -> None:
        return None

    app.client.cancel_recording = instant_cancel
    return entered, gate


def test_disable_during_startup_leaves_no_running_daemon(tmp_path: Path) -> None:

    def starting_events(publisher: FakeEventPublisher) -> list[dict[str, object]]:
        return [p for p in publisher.payloads("runtime_status") if p.get("state") == "starting"]

    async def scenario() -> None:
        app, publisher, data_dir = compose_with_fixture_daemon(tmp_path)
        entered, gate = _gate_daemon_spawn(app)
        try:
            startup = asyncio.create_task(app.start())
            assert await wait_until(entered.is_set, timeout=5.0)
            disable = asyncio.create_task(app.update_settings({"enabled": False}))

            async def open_gate_after_disable() -> None:
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(asyncio.shield(disable), timeout=0.5)
                gate.set()

            await asyncio.wait_for(open_gate_after_disable(), timeout=10.0)
            await asyncio.wait_for(startup, timeout=10.0)
            await asyncio.wait_for(disable, timeout=10.0)
            assert len(starting_events(publisher)) == 1
            assert await wait_until(lambda: not app.supervisor.is_running(), timeout=5.0)
            persisted = json.loads((data_dir / "settings.json").read_text(encoding="utf-8"))
            assert persisted["enabled"] is False
        finally:
            await app.dispose()

    asyncio.run(scenario())


def test_dispose_during_update_leaves_no_daemon_after_unload(tmp_path: Path) -> None:

    async def scenario() -> None:
        app, _publisher, data_dir = compose_with_fixture_daemon(tmp_path)
        try:
            await app.start()
            assert await wait_until(app.supervisor.is_running, timeout=5.0)
            await app.update_settings({"enabled": False})
            assert await wait_until(lambda: not app.supervisor.is_running(), timeout=5.0)

            entered, gate = _gate_daemon_spawn(app)
            update = asyncio.create_task(app.update_settings({"enabled": True}))
            assert await wait_until(entered.is_set, timeout=5.0)
            unload = asyncio.create_task(app.dispose())

            async def open_gate_after_unload() -> None:
                with contextlib.suppress(TimeoutError):
                    await asyncio.wait_for(asyncio.shield(unload), timeout=0.5)
                gate.set()

            await asyncio.wait_for(open_gate_after_unload(), timeout=10.0)
            await asyncio.wait_for(update, timeout=10.0)
            await asyncio.wait_for(unload, timeout=10.0)
            assert not app.supervisor.is_running()
            assert app.supervisor.last_exit_code is not None

            await app.update_settings({"enabled": True})
            assert not app.supervisor.is_running()
            persisted = json.loads((data_dir / "settings.json").read_text(encoding="utf-8"))
            assert persisted["enabled"] is True
        finally:
            await app.dispose()

    asyncio.run(scenario())




def test_setup_progress_fresh_path_with_model_present(tmp_path: Path) -> None:

    async def scenario() -> None:
        app, publisher, _data_dir = compose_with_fixture_daemon(tmp_path)
        try:
            await app.start()
            assert await wait_until(app.supervisor.is_running, timeout=5.0)

            events = publisher.payloads("setup_progress")
            assert [str(p["step"]) for p in events] == [
                "runtime.verify",
                "runtime.verify",
                "model.ensure",
                "model.ensure",
                "daemon.start",
                "model.warmup",
                "ready",
            ]
            first = events[0]
            assert first["protocolVersion"] == 1
            assert first["labelKey"] == "setup.step.runtimeVerify"
            assert first["stepIndex"] == 0
            assert first["totalSteps"] == 4
            assert first["percent"] == 0
            assert first["indeterminate"] is False
            assert first["detailKey"] == "setup.detail.checksum"
            assert events[1]["percent"] == 100
            ensure = events[2]
            assert ensure["labelKey"] == "setup.step.modelEnsure"
            assert ensure["detailKey"] == "setup.detail.verifying"
            daemon = events[4]
            assert daemon["stepIndex"] == 2
            assert daemon["percent"] == 0
            assert daemon["indeterminate"] is True
            assert daemon["detailKey"] == "setup.detail.spawning"
            warmup = events[5]
            assert warmup["stepIndex"] == 3
            assert warmup["indeterminate"] is True
            assert warmup["detailKey"] == "setup.detail.warmup"
            ready = events[-1]
            assert ready["step"] == "ready"
            assert ready["labelKey"] == "setup.state.ready"
            assert ready["stepIndex"] == 4
            assert ready["totalSteps"] == 4
            assert ready["percent"] == 100
            assert ready["indeterminate"] is False
            assert "error" not in ready
        finally:
            await app.dispose()

    asyncio.run(scenario())


def test_setup_progress_download_path_percent_monotonic(tmp_path: Path) -> None:

    async def scenario() -> None:
        root, data_dir = build_plugin_roots(tmp_path)
        binary = build_fixture_binary(root)
        write_pinned_runtime_manifest(root, binary)

        payload = b"download-path-model-payload-" * 6144
        digest = hashlib.sha256(payload).hexdigest()
        manifest_payload = json.loads(REAL_MODELS_MANIFEST.read_text(encoding="utf-8"))
        download_url = ""
        for entry in manifest_payload["models"]:
            if entry["id"] == "base":
                entry["sha256"] = digest
                download_url = str(entry["downloadUrl"])
        (root / "defaults" / "models.json").write_text(json.dumps(manifest_payload))

        class LocalStream:
            total_bytes = len(payload)

            async def chunks(self) -> AsyncIterator[bytes]:
                for index in range(0, len(payload), 64 * 1024):
                    yield payload[index : index + 64 * 1024]

            async def close(self) -> None:
                return None

        opened_urls: list[str] = []

        class LocalFetcher:
            async def open(self, url: str) -> LocalStream:
                opened_urls.append(url)
                return LocalStream()

        publisher = FakeEventPublisher()
        app = compose(
            plugin_root=root,
            data_dir=data_dir,
            event_publisher=publisher,
            model_fetcher=LocalFetcher(),
        )
        try:
            assert not await app.models.store.is_installed("base")
            await app.start()
            assert await wait_until(app.supervisor.is_running, timeout=5.0)

            assert opened_urls == [download_url]
            assert await app.models.store.is_installed("base")
            ensure = [
                p for p in publisher.payloads("setup_progress") if p["step"] == "model.ensure"
            ]
            assert ensure[0]["detailKey"] == "setup.detail.downloading"
            percents = [int(p["percent"]) for p in ensure]
            assert percents[0] == 0
            assert percents[-1] == 100
            assert percents == sorted(percents)
            assert len(percents) >= 3
        finally:
            await app.dispose()

    asyncio.run(scenario())


def test_setup_progress_failure_at_daemon_start(tmp_path: Path) -> None:

    async def scenario() -> None:
        app, publisher, _data_dir = compose_with_fixture_daemon(tmp_path)
        try:

            async def failing_start(settings: object) -> None:
                raise RuntimeStartError("spawn refused", detail="test seam")

            app.supervisor.start = failing_start

            await app.start()

            events = publisher.payloads("setup_progress")
            failed = events[-1]
            assert failed["step"] == "failed"
            assert failed["labelKey"] == "setup.state.failed"
            assert failed["stepIndex"] == 2
            assert failed["percent"] == 0
            assert failed["indeterminate"] is False
            assert failed["error"] == {"code": "RUNTIME_START_FAILED"}
            assert not any(p["step"] == "ready" for p in events)
            assert not app.supervisor.is_running()
            unavailable = [
                p for p in publisher.payloads("runtime_status") if p.get("state") == "unavailable"
            ]
            assert unavailable
        finally:
            await app.dispose()

    asyncio.run(scenario())




def build_download_roots(tmp_path: Path, payload: bytes) -> tuple[Path, Path, str]:
    root, data_dir = build_plugin_roots(tmp_path)
    binary = build_fixture_binary(root)
    write_pinned_runtime_manifest(root, binary)

    digest = hashlib.sha256(payload).hexdigest()
    manifest_payload = json.loads(REAL_MODELS_MANIFEST.read_text(encoding="utf-8"))
    download_url = ""
    for entry in manifest_payload["models"]:
        if entry["id"] == "base":
            entry["sha256"] = digest
            download_url = str(entry["downloadUrl"])
    (root / "defaults" / "models.json").write_text(json.dumps(manifest_payload))
    return root, data_dir, download_url


def test_startup_retries_transient_download_then_ready(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:

    class RetryStream:
        total_bytes = len(RETRY_PAYLOAD)

        async def chunks(self) -> AsyncIterator[bytes]:
            for index in range(0, len(RETRY_PAYLOAD), 64 * 1024):
                yield RETRY_PAYLOAD[index : index + 64 * 1024]

        async def close(self) -> None:
            return None

    opens: list[str] = []

    class FlakyFetcher:
        async def open(self, url: str) -> RetryStream:
            opens.append(url)
            if len(opens) <= 2:
                raise TransientModelDownloadError(
                    "model download request failed",
                    detail="URLError errno=-3 host=example.org",
                )
            return RetryStream()

    async def scenario() -> None:
        assert MODEL_DOWNLOAD_RETRY_DELAYS_S == (2.0, 5.0)
        monkeypatch.setattr(backend.composition, "MODEL_DOWNLOAD_RETRY_DELAYS_S", (0.01, 0.02))
        root, data_dir, download_url = build_download_roots(tmp_path, RETRY_PAYLOAD)
        publisher = FakeEventPublisher()
        app: Application = compose(
            plugin_root=root,
            data_dir=data_dir,
            event_publisher=publisher,
            model_fetcher=FlakyFetcher(),
        )
        try:
            assert not await app.models.store.is_installed("base")
            await app.start()
            assert await wait_until(app.supervisor.is_running, timeout=5.0)

            assert opens == [download_url, download_url, download_url]
            assert await app.models.store.is_installed("base")
            ensure = [
                p for p in publisher.payloads("setup_progress") if p["step"] == "model.ensure"
            ]
            fresh = [
                p
                for p in ensure
                if p["percent"] == 0 and p["detailKey"] == "setup.detail.downloading"
            ]
            assert len(fresh) == 3
            assert any(p["step"] == "ready" for p in publisher.payloads("setup_progress"))
            assert (await app.get_status())["runtime"]["lastFailure"] is None
        finally:
            await app.dispose()

    asyncio.run(scenario())


def test_startup_checksum_failure_does_not_retry(tmp_path: Path) -> None:

    class CorruptStream:
        total_bytes = len(CORRUPT_PAYLOAD)

        async def chunks(self) -> AsyncIterator[bytes]:
            yield CORRUPT_PAYLOAD

        async def close(self) -> None:
            return None

    opens: list[str] = []

    class CorruptFetcher:
        async def open(self, url: str) -> CorruptStream:
            opens.append(url)
            return CorruptStream()

    async def scenario() -> None:
        root, data_dir, _download_url = build_download_roots(tmp_path, RETRY_PAYLOAD)
        publisher = FakeEventPublisher()
        app: Application = compose(
            plugin_root=root,
            data_dir=data_dir,
            event_publisher=publisher,
            model_fetcher=CorruptFetcher(),
        )
        try:
            await app.start()

            assert len(opens) == 1
            assert not await app.models.store.is_installed("base")
            events = publisher.payloads("setup_progress")
            failed = events[-1]
            assert failed["step"] == "failed"
            assert failed["stepIndex"] == 1
            assert failed["error"] == {"code": "MODEL_CHECKSUM_FAILED"}
            assert not any(p["step"] == "ready" for p in events)
            assert not app.supervisor.is_running()
            assert (await app.get_status())["runtime"]["lastFailure"] == {
                "code": "MODEL_CHECKSUM_FAILED",
                "stepIndex": 1,
            }
        finally:
            await app.dispose()

    asyncio.run(scenario())


def test_restart_runtime_reruns_full_startup_after_failure(tmp_path: Path) -> None:

    async def scenario() -> None:
        app, publisher, _data_dir = compose_with_fixture_daemon(tmp_path)
        try:

            async def failing_start(settings: object) -> None:
                raise RuntimeStartError("spawn refused", detail="test seam")

            original_start = app.supervisor.start
            app.supervisor.start = failing_start
            await app.start()
            assert any(p["step"] == "failed" for p in publisher.payloads("setup_progress"))
            assert not app.supervisor.is_running()

            app.supervisor.start = original_start
            await app.restart_runtime()

            assert await wait_until(app.supervisor.is_running, timeout=5.0)
            events = publisher.payloads("setup_progress")
            assert [str(p["step"]) for p in events][-7:] == [
                "runtime.verify",
                "runtime.verify",
                "model.ensure",
                "model.ensure",
                "daemon.start",
                "model.warmup",
                "ready",
            ]
            assert [str(p["step"]) for p in events].count("ready") == 1
            started = await app.start_recording("sess-after-restart")
            assert started == {"sessionId": "sess-after-restart"}
            await app.cancel_recording("sess-after-restart")
            assert (await app.get_status())["runtime"]["lastFailure"] is None
        finally:
            await app.dispose()

    asyncio.run(scenario())

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

import main
import pytest
from backend.domain.contracts import (
    EVENT_MODEL_DOWNLOAD_PROGRESS,
    EVENT_SETUP_PROGRESS,
)
from backend.domain.errors import (
    InternalError,
    ModelDownloadCancelledError,
    RecordingStartError,
)


class _FakeApplication:

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.publisher: object | None = None

    async def start(self) -> None:
        self.calls.append("start")

    async def dispose(self) -> None:
        self.calls.append("dispose")

    async def migrate_settings(self) -> dict[str, object]:
        self.calls.append("migrate_settings")
        return {}

    async def get_status(self) -> dict[str, object]:
        self.calls.append("get_status")
        return {"state": "fake"}


class _FakeDeckyModule:


    def __init__(self, runtime_dir: Path) -> None:
        self.emitted: list[tuple[str, dict[str, object]]] = []
        self.DECKY_PLUGIN_RUNTIME_DIR = str(runtime_dir)

    async def emit(self, event_name: str, payload: dict[str, object]) -> None:
        self.emitted.append((event_name, payload))


def _patch_compose(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> list[_FakeApplication]:

    apps: list[_FakeApplication] = []

    def fake_compose(
        *,
        plugin_root: Path,
        data_dir: Path,
        event_publisher: object | None = None,
    ) -> _FakeApplication:
        assert plugin_root == Path(main.__file__).resolve().parent
        assert data_dir == tmp_path
        app = _FakeApplication()
        app.publisher = event_publisher
        apps.append(app)
        return app

    monkeypatch.setattr(main, "compose", fake_compose)
    monkeypatch.setenv("SPEECHTODECK_DATA_DIR", str(tmp_path))
    return apps


def test_migration_before_main_composes_and_migrates_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:

    async def scenario() -> None:
        apps = _patch_compose(monkeypatch, tmp_path)
        plugin = main.Plugin()

        await plugin._migration()

        assert len(apps) == 1
        assert apps[0].calls == ["migrate_settings"]
        assert plugin._app is apps[0]

    asyncio.run(scenario())


def test_main_after_migration_reuses_same_application(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def scenario() -> None:
        apps = _patch_compose(monkeypatch, tmp_path)
        plugin = main.Plugin()

        await plugin._migration()
        await plugin._main()

        assert len(apps) == 1
        assert apps[0].calls == ["migrate_settings", "start"]

    asyncio.run(scenario())


def test_callable_before_main_composes_and_delegates(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    async def scenario() -> None:
        apps = _patch_compose(monkeypatch, tmp_path)
        plugin = main.Plugin()

        with caplog.at_level(logging.INFO, logger="plugin.lifecycle"):
            result = await plugin.get_status()

        assert result == {"ok": True, "state": "fake"}
        assert apps[0].calls == ["get_status"]
        assert caplog.records == []

    asyncio.run(scenario())


def test_callable_failure_logs_code_and_returns_coded_envelope(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:

    async def scenario() -> None:
        apps = _patch_compose(monkeypatch, tmp_path)
        plugin = main.Plugin()
        await plugin._ensure_app()

        async def failing_start(session_id: str) -> dict[str, object]:
            raise RecordingStartError(
                "start acknowledgement timed out",
                detail="ExitCode=1",
                session_id=session_id,
            )

        monkeypatch.setattr(apps[0], "start_recording", failing_start, raising=False)

        with caplog.at_level(logging.WARNING, logger="plugin.lifecycle"):
            result = await plugin.start_recording("session-1")

        assert result == {
            "ok": False,
            "protocolVersion": 1,
            "code": "RECORDING_START_FAILED",
            "sessionId": "session-1",
            "detail": "ExitCode=1",
        }
        failures = [record for record in caplog.records if record.levelno == logging.WARNING]
        assert [record.getMessage() for record in failures] == [
            "start_recording failed: RECORDING_START_FAILED (session=session-1) (ExitCode=1)"
        ]

    asyncio.run(scenario())


def test_download_cancel_logs_info_without_failure_wording(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:

    async def scenario() -> None:
        apps = _patch_compose(monkeypatch, tmp_path)
        plugin = main.Plugin()
        await plugin._ensure_app()

        async def cancelling_download(model_id: str) -> dict[str, object]:
            raise ModelDownloadCancelledError("model download cancelled", detail=f"id={model_id}")

        monkeypatch.setattr(apps[0], "download_model", cancelling_download, raising=False)

        with caplog.at_level(logging.INFO, logger="plugin.lifecycle"):
            result = await plugin.download_model("small")

        assert result["ok"] is False
        assert result["code"] == "MODEL_DOWNLOAD_CANCELLED"
        infos = [record.getMessage() for record in caplog.records]
        assert infos == ["download_model cancelled: MODEL_DOWNLOAD_CANCELLED"]
        assert not any("failed" in message for message in infos)

    asyncio.run(scenario())


def test_unload_without_composition_is_noop(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def scenario() -> None:
        apps = _patch_compose(monkeypatch, tmp_path)
        plugin = main.Plugin()

        await plugin._unload()
        await plugin._uninstall()

        assert apps == []
        assert plugin._app is None

        await plugin._main()
        assert len(apps) == 1
        assert apps[0].calls == ["start"]

    asyncio.run(scenario())


def test_callable_after_unload_fails_closed(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def scenario() -> None:
        apps = _patch_compose(monkeypatch, tmp_path)
        plugin = main.Plugin()
        await plugin._migration()
        await plugin._main()

        await plugin._unload()
        assert apps[0].calls == ["migrate_settings", "start", "dispose"]

        with pytest.raises(InternalError):
            await plugin._ensure_app()
        status = await plugin.get_status()
        assert status == {"ok": False, "protocolVersion": 1, "code": "INTERNAL_ERROR"}

        await plugin._unload()
        assert apps[0].calls.count("dispose") == 1

    asyncio.run(scenario())


def test_composition_under_decky_wires_emit_transport(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:

    async def scenario() -> None:
        decky = _FakeDeckyModule(tmp_path / "decky-data")
        monkeypatch.setattr(main, "_DECKY", decky)
        apps = _patch_compose(monkeypatch, tmp_path)
        plugin = main.Plugin()

        await plugin._migration()

        publisher = apps[0].publisher
        assert isinstance(publisher, main.DeckyEventPublisher)

        await publisher.publish(EVENT_SETUP_PROGRESS, {"step": 0, "percent": 0})
        await publisher.publish(EVENT_MODEL_DOWNLOAD_PROGRESS, {"percent": 10})
        assert [name for name, _ in decky.emitted] == [
            EVENT_SETUP_PROGRESS,
            EVENT_MODEL_DOWNLOAD_PROGRESS,
        ]

    asyncio.run(scenario())


def test_composition_without_decky_keeps_logging_publisher_default(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:

    async def scenario() -> None:
        monkeypatch.setattr(main, "_DECKY", None)
        apps = _patch_compose(monkeypatch, tmp_path)
        plugin = main.Plugin()

        await plugin._migration()

        assert apps[0].publisher is None

    asyncio.run(scenario())


def test_data_dir_resolution_uses_loader_persistent_data_global(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:

    decky = _FakeDeckyModule(tmp_path / "decky-data")
    monkeypatch.delenv("SPEECHTODECK_DATA_DIR", raising=False)
    monkeypatch.setattr(main, "_DECKY", decky)
    assert main._resolve_data_dir() == tmp_path / "decky-data"

    decky.DECKY_PLUGIN_RUNTIME_DIR = ""
    assert main._resolve_data_dir() == Path.home() / ".local" / "share" / "SpeechToDeck"


def test_hanging_callable_returns_coded_failure_within_budget(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:

    async def scenario() -> None:
        monkeypatch.setattr(main, "CALLABLE_BUDGET_S", {"get_status": 0.05})
        apps = _patch_compose(monkeypatch, tmp_path)
        plugin = main.Plugin()
        await plugin._ensure_app()

        async def hanging_get_status() -> dict[str, object]:
            await asyncio.Event().wait()

        monkeypatch.setattr(apps[0], "get_status", hanging_get_status, raising=False)

        with caplog.at_level(logging.WARNING, logger="plugin.lifecycle"):
            result = await plugin.get_status()

        assert result == {
            "ok": False,
            "protocolVersion": 1,
            "code": "INTERNAL_ERROR",
            "detail": "budget=0.05s",
        }
        warnings = [
            record.getMessage() for record in caplog.records if record.levelno == logging.WARNING
        ]
        assert warnings == ["get_status failed: INTERNAL_ERROR (budget=0.05s)"]

    asyncio.run(scenario())


def test_dispose_hang_is_bounded_and_logged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:

    async def scenario() -> None:
        monkeypatch.setattr(main, "DISPOSE_TIMEOUT_S", 0.05)
        apps = _patch_compose(monkeypatch, tmp_path)
        plugin = main.Plugin()
        await plugin._migration()

        async def hanging_dispose() -> None:
            apps[0].calls.append("dispose")
            await asyncio.Event().wait()

        monkeypatch.setattr(apps[0], "dispose", hanging_dispose)

        with caplog.at_level(logging.ERROR, logger="plugin.lifecycle"):
            await plugin._unload()

        assert plugin._app is None
        assert plugin._disposed is True
        assert apps[0].calls == ["migrate_settings", "dispose"]
        errors = [
            record.getMessage() for record in caplog.records if record.levelno == logging.ERROR
        ]
        assert len(errors) == 1
        assert "dispose" in errors[0]
        assert "incomplete" in errors[0]

        status = await plugin.get_status()
        assert status == {"ok": False, "protocolVersion": 1, "code": "INTERNAL_ERROR"}

    asyncio.run(scenario())

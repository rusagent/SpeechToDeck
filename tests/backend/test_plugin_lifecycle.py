"""Decky loader lifecycle-order tests for the main.py facade.

On device the Decky loader invokes `_migration` BEFORE `_main` (observed in
the journal); with composition only in `_main` that order raised
InternalError("plugin backend is not composed yet") and the panel stayed on
"Loading settings…". These tests pin the loader-order contract with a
monkeypatched `compose` returning a fake Application (start / dispose /
migrate_settings spies); no Decky loader and no real backend is involved.
"""

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
    """Application double recording lifecycle calls (spy, no backend)."""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.publisher: object | None = None  # recorded compose kwarg

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
    """Loader-shaped `decky_plugin` stand-in (sandboxed_plugin.py:99-110).

    Exposes exactly what main.py reads: the module-level async `emit` and the
    `DECKY_PLUGIN_RUNTIME_DIR` persistent-data global.
    """

    def __init__(self, runtime_dir: Path) -> None:
        self.emitted: list[tuple[str, dict[str, object]]] = []
        self.DECKY_PLUGIN_RUNTIME_DIR = str(runtime_dir)

    async def emit(self, event_name: str, payload: dict[str, object]) -> None:
        self.emitted.append((event_name, payload))


def _patch_compose(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> list[_FakeApplication]:
    """Route main.compose to a spy; pin the composition arguments."""

    apps: list[_FakeApplication] = []

    def fake_compose(
        *,
        plugin_root: Path,
        data_dir: Path,
        event_publisher: object | None = None,
    ) -> _FakeApplication:
        assert plugin_root == Path(main.__file__).resolve().parent
        assert data_dir == tmp_path  # SPEECHTODECK_DATA_DIR override
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
    """Loader order on device: `_migration` runs first and must compose the
    backend itself (the pre-fix crash) and migrate exactly once."""

    async def scenario() -> None:
        apps = _patch_compose(monkeypatch, tmp_path)
        plugin = main.Plugin()

        await plugin._migration()

        assert len(apps) == 1  # composed exactly once, by the migration hook
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

        assert len(apps) == 1  # lazy composition is once per plugin lifetime
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
        # Successes stay quiet: no failure line for a successful callable.
        assert caplog.records == []

    asyncio.run(scenario())


def test_callable_failure_logs_code_and_returns_coded_envelope(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """On-device diagnosability defect: a failed dictation press returned the
    coded envelope but the journal showed NOTHING. `_call`
    is the single choke point: the failure logs WARNING with the callable
    name, the stable error code, the session id and the error's diagnosable
    detail — no transcript, no payload text — and no inner layer logs
    the same failure again."""

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

        # The coded envelope is unchanged…
        assert result == {
            "ok": False,
            "protocolVersion": 1,
            "code": "RECORDING_START_FAILED",
            "sessionId": "session-1",
            "detail": "ExitCode=1",
        }
        # …and exactly one journal line names the callable, code, session and
        # the diagnosable detail the store attaches (v0.2.5: today's warn
        # discarded it, which made cancellations undiagnosable).
        failures = [record for record in caplog.records if record.levelno == logging.WARNING]
        assert [record.getMessage() for record in failures] == [
            "start_recording failed: RECORDING_START_FAILED (session=session-1) (ExitCode=1)"
        ]

    asyncio.run(scenario())


def test_download_cancel_logs_info_without_failure_wording(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """v0.2.5 decision point (on-device v0.2.4 finding): the journal showed
    `download_model failed: MODEL_DOWNLOAD_FAILED` for every user cancel
    because the conflated Download/Cancel button cancelled in-flight
    downloads and the cancel mapped to the failure code. A cancel now logs at
    INFO, without 'failed' wording, and still returns the coded envelope."""

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

        assert apps == []  # nothing was composed, so nothing is torn down
        assert plugin._app is None

        # The facade stays usable: a later _main still composes and starts.
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

        # The composition seam raises the stable facade error…
        with pytest.raises(InternalError):
            await plugin._ensure_app()
        # …and the callable surface maps it to the coded payload.
        status = await plugin.get_status()
        assert status == {"ok": False, "protocolVersion": 1, "code": "INTERNAL_ERROR"}

        # `_unload` is idempotent: the disposed backend is torn down once.
        await plugin._unload()
        assert apps[0].calls.count("dispose") == 1

    asyncio.run(scenario())


def test_composition_under_decky_wires_emit_transport(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Audit must-fix 1: under the loader, composition wires the real event
    transport (DeckyEventPublisher over the module-level `decky_plugin.emit`),
    so setup_progress/model events reach the frontend instead of only logs."""

    async def scenario() -> None:
        decky = _FakeDeckyModule(tmp_path / "decky-data")
        monkeypatch.setattr(main, "_DECKY", decky)
        apps = _patch_compose(monkeypatch, tmp_path)
        plugin = main.Plugin()

        await plugin._migration()

        publisher = apps[0].publisher
        assert isinstance(publisher, main.DeckyEventPublisher)

        # Frozen event names flow through the wired transport and reach
        # the loader emit spy with (name, payload) intact.
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
    """No loader (tests, tooling): compose keeps its LoggingEventPublisher
    default via the explicit `event_publisher=None` argument."""

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
    """Audit must-fix 2: the data dir is `DECKY_PLUGIN_RUNTIME_DIR` (loader
    mapping `$DECKY_HOME/data/<plugin>`); `DECKY_PLUGIN_HOME` never existed."""

    decky = _FakeDeckyModule(tmp_path / "decky-data")
    monkeypatch.delenv("SPEECHTODECK_DATA_DIR", raising=False)
    monkeypatch.setattr(main, "_DECKY", decky)
    assert main._resolve_data_dir() == tmp_path / "decky-data"

    # The loader module defaults its globals to "" when the env var is absent
    # (decky.py os.getenv default): an empty value falls back to the local dev
    # path, never Path("").
    decky.DECKY_PLUGIN_RUNTIME_DIR = ""
    assert main._resolve_data_dir() == Path.home() / ".local" / "share" / "SpeechToDeck"


def test_hanging_callable_returns_coded_failure_within_budget(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Loader-behavior decision point: the loader waits for a callable reply
    WITHOUT a timeout (messages.py:39-44), so one hung
    operation froze the panel forever ("Loading settings…" with a healthy
    backend). Every callable now runs under its per-route budget; on
    expiry the frontend receives the normal coded envelope and `_call`'s
    single choke point logs exactly one WARNING with the callable name and
    INTERNAL_ERROR. The budget is injected (patched table), so the test is
    deterministic with no real-time race."""

    async def scenario() -> None:
        monkeypatch.setattr(main, "CALLABLE_BUDGET_S", {"get_status": 0.05})
        apps = _patch_compose(monkeypatch, tmp_path)
        plugin = main.Plugin()
        await plugin._ensure_app()

        async def hanging_get_status() -> dict[str, object]:
            await asyncio.Event().wait()  # hangs forever

        monkeypatch.setattr(apps[0], "get_status", hanging_get_status, raising=False)

        with caplog.at_level(logging.WARNING, logger="plugin.lifecycle"):
            result = await plugin.get_status()

        # The coded envelope, not silence: the frontend maps the code.
        assert result == {
            "ok": False,
            "protocolVersion": 1,
            "code": "INTERNAL_ERROR",
            "detail": "budget=0.05s",
        }
        # Exactly one journal line names the callable, the stable code and
        # the exceeded budget (no transcript, no payload text).
        warnings = [
            record.getMessage() for record in caplog.records if record.levelno == logging.WARNING
        ]
        assert warnings == ["get_status failed: INTERNAL_ERROR (budget=0.05s)"]

    asyncio.run(scenario())


def test_dispose_hang_is_bounded_and_logged(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """Loader-behavior decision point: a hung `Application.dispose()` used to
    pend forever while the loader counted down its SIGTERM → SIGKILL-at-5 s
    unload budget (plugin.py:161-183). The facade now bounds
    dispose at 4 s (inside that budget), keeps the detach-before-dispose
    fail-closed ordering, logs loudly about what was skipped, and never
    propagates the hang. The budget is injected (patched constant), so the
    test is deterministic with no real-time race."""

    async def scenario() -> None:
        monkeypatch.setattr(main, "DISPOSE_TIMEOUT_S", 0.05)
        apps = _patch_compose(monkeypatch, tmp_path)
        plugin = main.Plugin()
        await plugin._migration()

        async def hanging_dispose() -> None:
            apps[0].calls.append("dispose")
            await asyncio.Event().wait()  # hangs forever

        monkeypatch.setattr(apps[0], "dispose", hanging_dispose)

        with caplog.at_level(logging.ERROR, logger="plugin.lifecycle"):
            await plugin._unload()  # returns within the budget, no exception

        # Fail-closed semantics preserved: the facade detached BEFORE the
        # dispose attempt, and stays detached after its timeout.
        assert plugin._app is None
        assert plugin._disposed is True
        assert apps[0].calls == ["migrate_settings", "dispose"]
        errors = [
            record.getMessage() for record in caplog.records if record.levelno == logging.ERROR
        ]
        assert len(errors) == 1
        assert "dispose" in errors[0]
        assert "incomplete" in errors[0]

        # A callable after the timed-out dispose still fails closed.
        status = await plugin.get_status()
        assert status == {"ok": False, "protocolVersion": 1, "code": "INTERNAL_ERROR"}

    asyncio.run(scenario())

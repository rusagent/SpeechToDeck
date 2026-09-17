"""Decky loader lifecycle-order tests for the main.py facade (spec §31).

On device the Decky loader invokes `_migration` BEFORE `_main` (journal
2026-09-17 19:31); with composition only in `_main` that order raised
InternalError("plugin backend is not composed yet") and the panel stayed on
"Loading settings…". These tests pin the loader-order contract with a
monkeypatched `compose` returning a fake Application (start / dispose /
migrate_settings spies); no Decky loader and no real backend is involved.
"""

from __future__ import annotations

import asyncio
from pathlib import Path

import main
import pytest
from backend.domain.errors import InternalError


class _FakeApplication:
    """Application double recording lifecycle calls (§91 spy, no backend)."""

    def __init__(self) -> None:
        self.calls: list[str] = []

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


def _patch_compose(monkeypatch: pytest.MonkeyPatch, tmp_path: Path) -> list[_FakeApplication]:
    """Route main.compose to a spy; pin the composition arguments."""
    apps: list[_FakeApplication] = []

    def fake_compose(*, plugin_root: Path, data_dir: Path) -> _FakeApplication:
        assert plugin_root == Path(main.__file__).resolve().parent
        assert data_dir == tmp_path  # SPEECHTODECK_DATA_DIR override
        app = _FakeApplication()
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
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def scenario() -> None:
        apps = _patch_compose(monkeypatch, tmp_path)
        plugin = main.Plugin()

        result = await plugin.get_status()

        assert result == {"ok": True, "state": "fake"}
        assert apps[0].calls == ["get_status"]

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
        # …and the §68 callable surface maps it to the coded payload.
        status = await plugin.get_status()
        assert status == {"ok": False, "protocolVersion": 1, "code": "INTERNAL_ERROR"}

        # `_unload` is idempotent: the disposed backend is torn down once.
        await plugin._unload()
        assert apps[0].calls.count("dispose") == 1

    asyncio.run(scenario())

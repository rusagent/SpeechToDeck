from __future__ import annotations

import asyncio
import json
import os
import stat
from pathlib import Path

import pytest
from backend.domain.errors import SettingsInvalidError
from backend.infrastructure.settings import json_settings_repository as jsr
from backend.infrastructure.settings.json_settings_repository import (
    JsonSettingsRepository,
    settings_from_payload,
)

DEFAULTS_PAYLOAD = {
    "schemaVersion": 1,
    "enabled": True,
    "computeBackend": "auto",
    "modelId": "base",
    "language": "system",
}

LEGACY_V024_PAYLOAD = DEFAULTS_PAYLOAD | {
    "maxRecordingSeconds": 110,
    "vadEnabled": True,
    "outputMode": "direct-insert",
}


def make_repo(tmp_path: Path) -> tuple[JsonSettingsRepository, Path]:
    path = tmp_path / "settings.json"
    return JsonSettingsRepository(path), path


def test_missing_file_yields_spec_defaults(tmp_path: Path) -> None:
    async def scenario() -> None:
        repo, path = make_repo(tmp_path)
        settings = await repo.load()
        assert settings.to_payload() == DEFAULTS_PAYLOAD
        assert not path.exists()

    asyncio.run(scenario())


def test_roundtrip_preserves_settings(tmp_path: Path) -> None:
    async def scenario() -> None:
        repo, path = make_repo(tmp_path)
        loaded = await repo.load()
        loaded = jsr.settings_from_payload(
            loaded.to_payload() | {"computeBackend": "vulkan", "modelId": "small"}
        )
        await repo.save(loaded)
        reread = await repo.load()
        assert reread.to_payload() == loaded.to_payload()
        assert json.loads(path.read_text(encoding="utf-8"))["computeBackend"] == "vulkan"

    asyncio.run(scenario())


def test_save_is_atomic_and_private(tmp_path: Path) -> None:
    async def scenario() -> None:
        repo, path = make_repo(tmp_path)
        loaded = await repo.load()
        await repo.save(loaded)
        assert not (tmp_path / "settings.json.tmp").exists()
        assert stat.S_IMODE(path.stat().st_mode) == 0o600

    asyncio.run(scenario())


@pytest.mark.parametrize(
    "mutation",
    [
        {"surpriseField": 1},
        {"computeBackend": "quantum"},
        {"enabled": "yes"},
        {"modelId": "Base"},
        {"language": "not a language!!"},
    ],
)
def test_invalid_fields_rejected_deliberately(tmp_path: Path, mutation: dict[str, object]) -> None:
    async def scenario() -> None:
        repo, path = make_repo(tmp_path)
        path.write_text(json.dumps(DEFAULTS_PAYLOAD | mutation), encoding="utf-8")
        with pytest.raises(SettingsInvalidError):
            await repo.load()

    asyncio.run(scenario())


def test_legacy_v024_keys_tolerated_on_load_and_never_written_back(tmp_path: Path) -> None:

    async def scenario() -> None:
        repo, path = make_repo(tmp_path)
        path.write_text(json.dumps(LEGACY_V024_PAYLOAD), encoding="utf-8")

        settings = await repo.load()
        assert "maxRecordingSeconds" not in settings.to_payload()
        assert "vadEnabled" not in settings.to_payload()
        assert "outputMode" not in settings.to_payload()
        assert settings.model_id == "base"

        await repo.save(settings)
        persisted = json.loads(path.read_text(encoding="utf-8"))
        assert "maxRecordingSeconds" not in persisted
        assert "vadEnabled" not in persisted
        assert "outputMode" not in persisted
        assert persisted["modelId"] == "base"
        assert persisted["language"] == "system"

    asyncio.run(scenario())


def test_unknown_field_rejected(tmp_path: Path) -> None:
    payload = DEFAULTS_PAYLOAD | {"futureThing": True}
    with pytest.raises(SettingsInvalidError) as excinfo:
        settings_from_payload(payload)
    assert "futureThing" in str(excinfo.value.detail)


def test_missing_field_rejected(tmp_path: Path) -> None:
    payload = {k: v for k, v in DEFAULTS_PAYLOAD.items() if k != "language"}
    with pytest.raises(SettingsInvalidError) as excinfo:
        settings_from_payload(payload)
    assert "language" in str(excinfo.value.detail)


def test_future_schema_version_fails_closed(tmp_path: Path) -> None:
    async def scenario() -> None:
        repo, path = make_repo(tmp_path)
        path.write_text(json.dumps(DEFAULTS_PAYLOAD | {"schemaVersion": 99}), encoding="utf-8")
        with pytest.raises(SettingsInvalidError) as excinfo:
            await repo.load()
        assert "newer" in excinfo.value.message

    asyncio.run(scenario())


def test_migration_chain_walks_registered_migrators(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def scenario() -> None:
        monkeypatch.setattr(jsr, "CURRENT_SCHEMA_VERSION", 2)
        monkeypatch.setattr(
            jsr,
            "MIGRATIONS",
            {1: lambda data: {**data, "schemaVersion": 2}},
        )
        repo, path = make_repo(tmp_path)
        path.write_text(json.dumps(DEFAULTS_PAYLOAD), encoding="utf-8")
        settings = await repo.load()
        assert settings.schema_version == 2
        assert settings.model_id == "base"

    asyncio.run(scenario())


def test_migration_chain_fails_closed_on_gap(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    async def scenario() -> None:
        monkeypatch.setattr(jsr, "CURRENT_SCHEMA_VERSION", 3)
        monkeypatch.setattr(
            jsr,
            "MIGRATIONS",
            {1: lambda data: {**data, "schemaVersion": 2}},
        )
        repo, path = make_repo(tmp_path)
        path.write_text(json.dumps(DEFAULTS_PAYLOAD), encoding="utf-8")
        with pytest.raises(SettingsInvalidError) as excinfo:
            await repo.load()
        assert "no migration registered" in excinfo.value.message

    asyncio.run(scenario())


def test_corrupt_json_fails_closed(tmp_path: Path) -> None:
    async def scenario() -> None:
        repo, path = make_repo(tmp_path)
        path.write_text("{definitely not json", encoding="utf-8")
        with pytest.raises(SettingsInvalidError):
            await repo.load()

    asyncio.run(scenario())


def test_schema_version_is_backend_owned(tmp_path: Path) -> None:
    with pytest.raises(SettingsInvalidError):
        settings_from_payload(DEFAULTS_PAYLOAD | {"schemaVersion": 2})


def test_tmp_file_removed_on_write_failure(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    async def scenario() -> None:
        repo, path = make_repo(tmp_path)
        loaded = await repo.load()

        def broken_replace(src: object, dst: object) -> None:
            raise OSError("injected failure")

        monkeypatch.setattr(jsr.os, "replace", broken_replace)
        with pytest.raises(SettingsInvalidError):
            await repo.save(loaded)
        assert not (tmp_path / "settings.json.tmp").exists()
        assert os.path.exists(path) is False

    asyncio.run(scenario())

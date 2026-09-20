"""In-app model deletion: the `delete_model` callable chain.

Covers the whole backend path of the feature: the Application active-model
guard (the settings seam), the ModelService manifest resolve + in-flight
download rejection, and the ModelStore idempotent remove with freed bytes.
Deterministic: fake fetcher, tmp data dir, no daemon — the delete path never
starts the runtime.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
from collections.abc import AsyncIterator
from pathlib import Path

import main
import pytest
from backend.composition import Application, compose
from backend.domain.errors import (
    ErrorCode,
    ModelDownloadCancelledError,
    ModelDownloadFailedError,
    ModelNotInstalledError,
    SettingsInvalidError,
)
from conftest import wait_until

FAKE_BYTES = b"fake-model-bytes" * 1024
FAKE_DIGEST = hashlib.sha256(FAKE_BYTES).hexdigest()
TINY_BYTES = b"tiny-model-bytes" * 512
TINY_DIGEST = hashlib.sha256(TINY_BYTES).hexdigest()
SMALL_BYTES = b"small-model-bytes" * 256
SMALL_DIGEST = hashlib.sha256(SMALL_BYTES).hexdigest()

# Deliberately unpinned runtime manifest (test_composition.py shape): the
# delete path never verifies or starts the runtime, and composition must not
# depend on a pinned binary here.
UNPINNED_MANIFEST_JSON = (
    '{"schemaVersion": 1, "artifacts": ['
    '{"id": "voxtype-avx2", "engine": "whisper", "arch": "x86_64", "variant": "cpu",'
    ' "version": "", "source": "", "sha256": "", "license": ""},'
    '{"id": "voxtype-vulkan", "engine": "whisper", "arch": "x86_64", "variant": "vulkan",'
    ' "version": "", "source": "", "sha256": "", "license": ""}]}'
)


def _model_entry(model_id: str, filename: str, digest: str, size: int) -> dict[str, object]:
    return {
        "id": model_id,
        "engine": "whisper",
        "multilingual": True,
        "filename": filename,
        "downloadUrl": f"https://example.test/{filename}",
        "sha256": digest,
        "sizeBytes": size,
    }


def manifest_payload() -> dict[str, object]:
    """base + tiny + small: a selected model and two deletable ones."""
    return {
        "schemaVersion": 1,
        "models": [
            _model_entry("base", "ggml-base.bin", FAKE_DIGEST, len(FAKE_BYTES)),
            _model_entry("tiny", "ggml-tiny.bin", TINY_DIGEST, len(TINY_BYTES)),
            _model_entry("small", "ggml-small.bin", SMALL_DIGEST, len(SMALL_BYTES)),
        ],
    }


class SlowStream:
    """DownloadStream double over local bytes with a per-chunk delay."""

    def __init__(self, payload: bytes, delay: float) -> None:
        self.payload = payload
        self.total_bytes = len(payload)
        self.delay = delay

    async def chunks(self) -> AsyncIterator[bytes]:
        for index in range(0, len(self.payload), 4096):
            await asyncio.sleep(self.delay)
            yield self.payload[index : index + 4096]

    async def close(self) -> None:
        return None


class SlowFetcher:
    """ModelHttpFetcher double: one slow stream, no network."""

    def __init__(self, payload: bytes, delay: float = 0.05) -> None:
        self.stream = SlowStream(payload, delay)

    async def open(self, url: str) -> SlowStream:
        return self.stream


def build_app(tmp_path: Path, model_fetcher: SlowFetcher | None = None) -> tuple[Application, Path]:
    """Composed application over a controlled catalog + empty data dir."""
    root = tmp_path / "plugin-root"
    defaults = root / "defaults"
    defaults.mkdir(parents=True)
    (defaults / "models.json").write_text(json.dumps(manifest_payload()), encoding="utf-8")
    (defaults / "runtime-manifest.json").write_text(UNPINNED_MANIFEST_JSON, encoding="utf-8")
    data_dir = tmp_path / "data"
    app = compose(
        plugin_root=root,
        data_dir=data_dir,
        **({} if model_fetcher is None else {"model_fetcher": model_fetcher}),
    )
    return app, data_dir / "models"


def install(models_dir: Path, filename: str, payload: bytes) -> None:
    models_dir.mkdir(parents=True, exist_ok=True)
    (models_dir / filename).write_bytes(payload)


def test_delete_removes_file_reports_freed_bytes_and_clears_stale_part(tmp_path: Path) -> None:
    async def scenario() -> None:
        app, models_dir = build_app(tmp_path)
        install(models_dir, "ggml-small.bin", SMALL_BYTES)
        install(models_dir, "ggml-tiny.bin", TINY_BYTES)
        # A stale .part from an interrupted download must not survive a delete.
        (models_dir / "ggml-tiny.bin.part").write_bytes(b"stale-part")

        result = await app.delete_model("small")
        assert result == {"modelId": "small", "freedBytes": len(SMALL_BYTES)}
        assert not (models_dir / "ggml-small.bin").exists()
        # The other installed artifact is untouched.
        assert (models_dir / "ggml-tiny.bin").is_file()

        result = await app.delete_model("tiny")
        assert result == {"modelId": "tiny", "freedBytes": len(TINY_BYTES)}
        assert not (models_dir / "ggml-tiny.bin").exists()
        assert not (models_dir / "ggml-tiny.bin.part").exists()

    asyncio.run(scenario())


def test_delete_absent_file_is_an_idempotent_noop_without_freed_bytes(tmp_path: Path) -> None:
    async def scenario() -> None:
        app, _models_dir = build_app(tmp_path)

        result = await app.delete_model("tiny")
        assert result == {"modelId": "tiny"}
        assert "freedBytes" not in result

    asyncio.run(scenario())


def test_delete_unknown_or_traversal_ids_fail_with_stable_code(tmp_path: Path) -> None:
    async def scenario() -> None:
        app, _models_dir = build_app(tmp_path)
        for bad in ("nonexistent", "../../etc/passwd", "", "Base", "base;rm"):
            with pytest.raises(ModelNotInstalledError) as excinfo:
                await app.delete_model(bad)
            assert excinfo.value.code is ErrorCode.MODEL_NOT_INSTALLED

    asyncio.run(scenario())


def test_selected_model_cannot_be_deleted_and_settings_stay_untouched(tmp_path: Path) -> None:
    async def scenario() -> None:
        app, models_dir = build_app(tmp_path)
        install(models_dir, "ggml-base.bin", FAKE_BYTES)
        install(models_dir, "ggml-tiny.bin", TINY_BYTES)
        before = await app.get_settings()
        assert before["modelId"] == "base"  # the shipped default selection

        with pytest.raises(SettingsInvalidError) as excinfo:
            await app.delete_model("base")
        assert excinfo.value.code is ErrorCode.SETTINGS_INVALID

        # The guarded artifact is untouched and no settings write happened:
        # the defaults were never persisted (load never saves implicitly) and
        # the delete path must keep it that way.
        assert (models_dir / "ggml-base.bin").is_file()
        assert not app.paths.settings_file.exists()
        assert await app.get_settings() == before

        # A non-selected delete succeeds and still writes no settings.
        result = await app.delete_model("tiny")
        assert result["freedBytes"] == len(TINY_BYTES)
        assert await app.get_settings() == before
        assert not app.paths.settings_file.exists()

    asyncio.run(scenario())


def test_delete_of_a_model_with_download_in_flight_is_rejected(tmp_path: Path) -> None:
    async def scenario() -> None:
        fetcher = SlowFetcher(TINY_BYTES)
        app, models_dir = build_app(tmp_path, model_fetcher=fetcher)
        install(models_dir, "ggml-base.bin", FAKE_BYTES)
        install(models_dir, "ggml-small.bin", SMALL_BYTES)

        task = asyncio.get_running_loop().create_task(app.models.download_model("tiny"))
        try:
            # Deterministic in-flight signal: the store id is set under the
            # download lock, exactly what the delete guard reads.
            assert await wait_until(
                lambda: app.models.store.downloading_model_id() == "tiny",
                timeout=2.0,
            )

            with pytest.raises(ModelDownloadFailedError) as excinfo:
                await app.delete_model("tiny")
            assert excinfo.value.code is ErrorCode.MODEL_DOWNLOAD_FAILED

            # The guard is per model: another installed model deletes fine
            # while the single in-flight download runs.
            result = await app.delete_model("small")
            assert result == {"modelId": "small", "freedBytes": len(SMALL_BYTES)}
        finally:
            app.models.cancel_download()
            with pytest.raises(ModelDownloadCancelledError):
                await asyncio.wait_for(task, 2.0)

    asyncio.run(scenario())


def test_facade_maps_delete_failures_to_the_coded_envelope(tmp_path: Path) -> None:
    """A failed delete surfaces as the coded result, never an exception."""

    async def scenario() -> None:
        app, _models_dir = build_app(tmp_path)
        plugin = main.Plugin()
        plugin._app = app  # type: ignore[attr-defined]  # test seam: skip compose

        # The selected model: the active-model protection code.
        rejected = await plugin.delete_model("base")
        assert rejected["ok"] is False
        assert rejected["code"] == str(ErrorCode.SETTINGS_INVALID)

        # An unknown id: the stable MODEL_NOT_INSTALLED code.
        unknown = await plugin.delete_model("nonexistent")
        assert unknown["ok"] is False
        assert unknown["code"] == str(ErrorCode.MODEL_NOT_INSTALLED)

    asyncio.run(scenario())

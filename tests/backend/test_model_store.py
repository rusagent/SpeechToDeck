"""Model manifest loader + ModelStore tests (spec §50-§53, §109)."""

from __future__ import annotations

import asyncio
import hashlib
import json
import stat
from collections.abc import AsyncIterator
from pathlib import Path

import pytest
from backend.domain.contracts import ModelInfo
from backend.domain.errors import (
    ModelChecksumFailedError,
    ModelNotInstalledError,
)
from backend.infrastructure.model.model_manifest import (
    ModelManifest,
    load_model_manifest,
)
from backend.infrastructure.model.model_store import (
    ModelDownloadCancelled,
    ModelStore,
)
from conftest import REAL_MODELS_MANIFEST, FakeEventPublisher, wait_until

FAKE_BYTES = b"fake-model-bytes" * 1024  # 16 KiB deterministic payload
FAKE_DIGEST = hashlib.sha256(FAKE_BYTES).hexdigest()


def make_info(**overrides: object) -> ModelInfo:
    values: dict[str, object] = {
        "id": "base",
        "engine": "whisper",
        "multilingual": True,
        "filename": "ggml-base.bin",
        "download_url": "https://example.test/ggml-base.bin",
        "sha256": FAKE_DIGEST,
        "size_bytes": len(FAKE_BYTES),
    }
    values.update(overrides)
    return ModelInfo(
        id=str(values["id"]),
        engine=str(values["engine"]),
        multilingual=bool(values["multilingual"]),  # type: ignore[arg-type]
        filename=str(values["filename"]),
        download_url=str(values["download_url"]),
        sha256=str(values["sha256"]),
        size_bytes=(
            None if values["size_bytes"] is None else int(values["size_bytes"])  # type: ignore[arg-type]
        ),
    )


def make_manifest(*models: ModelInfo) -> ModelManifest:
    return ModelManifest(models=tuple(models))


class FakeStream:
    def __init__(self, payload: bytes, total: int | None, delay: float = 0.0) -> None:
        self.payload = payload
        self.total_bytes = total
        self.delay = delay

    async def chunks(self) -> AsyncIterator[bytes]:
        for index in range(0, len(self.payload), 4096):
            if self.delay:
                await asyncio.sleep(self.delay)
            yield self.payload[index : index + 4096]

    async def close(self) -> None:
        return None


class FakeFetcher:
    """ModelHttpFetcher double: streams local bytes; no network (§90)."""

    def __init__(
        self, payload: bytes = FAKE_BYTES, *, total: int | None = None, delay: float = 0.0
    ) -> None:
        self.payload = payload
        self.total = total
        self.delay = delay
        self.opened_urls: list[str] = []
        self.concurrent = 0
        self.max_concurrent = 0

    async def open(self, url: str) -> FakeStream:
        self.opened_urls.append(url)
        self.concurrent += 1
        self.max_concurrent = max(self.max_concurrent, self.concurrent)
        try:
            return FakeStream(self.payload, self.total, self.delay)
        finally:
            self.concurrent -= 1


# ── manifest loader (§50; rules mirror scripts/validate-manifests.mjs) ──────


def test_real_committed_manifest_loads() -> None:
    manifest = load_model_manifest(REAL_MODELS_MANIFEST)
    ids = [model.id for model in manifest.models]
    assert ids == ["tiny", "base", "small"]  # curated v1 set (§48)
    for model in manifest.models:
        assert model.engine == "whisper"
        assert model.multilingual is True
        assert len(model.sha256) == 64
        assert model.sha256 == model.sha256.lower()
        assert model.download_url.startswith("https://")
        assert "/" not in model.filename
    assert manifest.by_id("base") is not None
    assert manifest.by_id("nonexistent") is None


def write_manifest(tmp_path: Path, payload: object) -> Path:
    path = tmp_path / "models.json"
    if isinstance(payload, (dict, list)):
        path.write_text(json.dumps(payload), encoding="utf-8")
    else:
        path.write_text(str(payload), encoding="utf-8")
    return path


def base_model_payload(**overrides: object) -> dict[str, object]:
    entry: dict[str, object] = {
        "id": "base",
        "engine": "whisper",
        "multilingual": True,
        "filename": "ggml-base.bin",
        "downloadUrl": "https://example.test/ggml-base.bin",
        "sha256": FAKE_DIGEST,
        "sizeBytes": len(FAKE_BYTES),
    }
    entry.update(overrides)
    models = [
        entry,
        entry | {"id": "tiny", "filename": "t.bin"},
        entry | {"id": "small", "filename": "s.bin"},
    ]
    return {"schemaVersion": 1, "models": models}


@pytest.mark.parametrize(
    ("payload", "expected_fragment"),
    [
        ({"schemaVersion": 2, "models": []}, "schemaVersion"),
        ({"schemaVersion": 1, "models": []}, "non-empty"),
        (base_model_payload(id="UPPER"), "invalid model id"),
        (base_model_payload(id="dup id"), "invalid model id"),
        (base_model_payload(engine="gpt"), "whisper"),
        (base_model_payload(multilingual="yes"), "boolean"),
        (base_model_payload(filename="../evil.bin"), "plain file name"),
        (base_model_payload(filename="a\\b.bin"), "plain file name"),
        (base_model_payload(downloadUrl="http://insecure/bin"), "https"),
        (base_model_payload(downloadUrl="https://a b/bin"), "whitespace"),
        (base_model_payload(sha256=""), "empty"),
        (base_model_payload(sha256="AB" * 32), "hex"),
        (base_model_payload(sha256="ab" * 10), "hex"),
        (base_model_payload(sizeBytes=0), "positive integer"),
        (base_model_payload(sizeBytes="big"), "positive integer"),
        (base_model_payload(surprise="x"), "unknown"),
        (
            {
                "schemaVersion": 1,
                "models": [
                    {
                        "id": "base",
                        "engine": "whisper",
                        "multilingual": True,
                        "filename": "g.bin",
                        "downloadUrl": "https://x/y",
                        "sha256": FAKE_DIGEST,
                    }
                ],
            },
            "curated v1 model set",
        ),
        ("{not json", "JSON"),
    ],
)
def test_manifest_rules_fail_closed(
    tmp_path: Path, payload: object, expected_fragment: str
) -> None:
    path = write_manifest(tmp_path, payload)
    with pytest.raises(Exception) as excinfo:
        load_model_manifest(path)
    from backend.domain.errors import ManifestInvalidError

    assert isinstance(excinfo.value, ManifestInvalidError)
    assert expected_fragment.lower() in str(excinfo.value.detail).lower() or (
        expected_fragment.lower() in str(excinfo.value).lower()
    )


def test_duplicate_model_ids_fail_closed(tmp_path: Path) -> None:
    entry = {
        "id": "base",
        "engine": "whisper",
        "multilingual": True,
        "filename": "g.bin",
        "downloadUrl": "https://x/y",
        "sha256": FAKE_DIGEST,
    }
    payload = {"schemaVersion": 1, "models": [entry, dict(entry)]}
    # Note: this payload also lacks tiny/small; assert both failures appear.
    with pytest.raises(Exception) as excinfo:
        load_model_manifest(write_manifest(tmp_path, payload))
    assert "duplicate" in str(excinfo.value.detail)


# ── ModelStore (§51-§52, §109) ──────────────────────────────────────────────


def make_store(
    tmp_path: Path, fetcher: FakeFetcher, manifest: ModelManifest | None = None
) -> ModelStore:
    publisher = FakeEventPublisher()
    progress: list[tuple[str, int, int | None]] = []

    async def on_progress(model_id: str, received: int, total: int | None) -> None:
        progress.append((model_id, received, total))

    store = ModelStore(
        manifest or make_manifest(make_info()),
        tmp_path / "models",
        fetcher,
        on_progress=on_progress,
    )
    store.test_progress = progress  # type: ignore[attr-defined]
    store.test_publisher = publisher  # type: ignore[attr-defined]
    return store


def test_download_happy_path_is_atomic_and_private(tmp_path: Path) -> None:
    async def scenario() -> None:
        fetcher = FakeFetcher()
        store = make_store(tmp_path, fetcher)
        models_dir = tmp_path / "models"
        models_dir.mkdir(parents=True)

        assert not await store.is_installed("base")
        await store.download("base")

        final = models_dir / "ggml-base.bin"
        assert final.is_file()
        assert final.read_bytes() == FAKE_BYTES
        assert not (models_dir / "ggml-base.bin.part").exists()  # §51
        mode = stat.S_IMODE(final.stat().st_mode)
        assert mode == 0o600  # §110
        assert await store.is_installed("base")

        progress = store.test_progress  # type: ignore[attr-defined]
        assert progress[-1] == ("base", len(FAKE_BYTES), len(FAKE_BYTES))

        # Idempotent: a second download does not re-fetch.
        await store.download("base")
        assert len(fetcher.opened_urls) == 1

    asyncio.run(scenario())


def test_checksum_mismatch_leaves_no_artifact(tmp_path: Path) -> None:
    async def scenario() -> None:
        fetcher = FakeFetcher(payload=b"corrupted bytes!")
        store = make_store(tmp_path, fetcher)
        models_dir = tmp_path / "models"
        models_dir.mkdir(parents=True)

        with pytest.raises(ModelChecksumFailedError):
            await store.download("base")
        assert not (models_dir / "ggml-base.bin").exists()
        assert not (models_dir / "ggml-base.bin.part").exists()  # §51: never valid

    asyncio.run(scenario())


def test_ensure_model_detects_corrupt_installed_file(tmp_path: Path) -> None:
    async def scenario() -> None:
        store = make_store(tmp_path, FakeFetcher())
        models_dir = tmp_path / "models"
        models_dir.mkdir(parents=True)
        (models_dir / "ggml-base.bin").write_bytes(b"garbage that is not the model")

        with pytest.raises(ModelChecksumFailedError):
            await store.ensure_model("base")

    asyncio.run(scenario())


def test_missing_and_invalid_model_ids_fail_closed(tmp_path: Path) -> None:
    async def scenario() -> None:
        store = make_store(tmp_path, FakeFetcher())
        for bad in ("nonexistent", "../../etc/passwd", "", "Base", "base;rm"):
            with pytest.raises(ModelNotInstalledError):
                await store.is_installed(bad)
            with pytest.raises(ModelNotInstalledError):
                await store.download(bad)
            with pytest.raises(ModelNotInstalledError):
                await store.ensure_model(bad)
            with pytest.raises(ModelNotInstalledError):
                await store.remove(bad)  # unknown ids never resolve to a path

    asyncio.run(scenario())


def test_downloads_are_serialized_by_single_lock(tmp_path: Path) -> None:
    async def scenario() -> None:
        fetcher = FakeFetcher(delay=0.02)
        manifest = make_manifest(
            make_info(),
            make_info(id="tiny", filename="ggml-tiny.bin"),
        )
        store = make_store(tmp_path, fetcher, manifest)
        (tmp_path / "models").mkdir(parents=True)

        await asyncio.gather(store.download("base"), store.download("tiny"))
        assert fetcher.max_concurrent == 1  # §52
        assert await store.is_installed("base")
        assert await store.is_installed("tiny")

    asyncio.run(scenario())


def test_cancel_download_aborts_and_cleans(tmp_path: Path) -> None:
    async def scenario() -> None:
        fetcher = FakeFetcher(delay=0.05)
        store = make_store(tmp_path, fetcher)
        (tmp_path / "models").mkdir(parents=True)

        task = asyncio.get_running_loop().create_task(store.download("base"))
        assert await wait_until(lambda: len(fetcher.opened_urls) > 0, timeout=2.0)
        assert store.cancel_download() is True

        with pytest.raises(ModelDownloadCancelled):
            await asyncio.wait_for(task, 2.0)
        assert not store.download_in_progress()
        assert not (tmp_path / "models" / "ggml-base.bin").exists()
        assert not (tmp_path / "models" / "ggml-base.bin.part").exists()

    asyncio.run(scenario())


def test_remove_is_idempotent(tmp_path: Path) -> None:
    async def scenario() -> None:
        store = make_store(tmp_path, FakeFetcher())
        models_dir = tmp_path / "models"
        models_dir.mkdir(parents=True)
        final = models_dir / "ggml-base.bin"
        final.write_bytes(FAKE_BYTES)

        await store.remove("base")
        assert not final.exists()
        await store.remove("base")  # no error

    asyncio.run(scenario())

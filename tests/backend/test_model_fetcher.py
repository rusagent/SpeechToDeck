"""UrllibModelFetcher transport tests (§51/§52) over a local http.server.

The SteamOS Decky runtime ships no aiohttp, so the §30 download path runs on
the stdlib transport. These tests prove it end to end against a real local
HTTP server (§90: no external network): Content-Length surfacing, chunked
integrity through the §51 store algorithm, the stable §68 failure code, and
cancellation across the worker-thread boundary.
"""

from __future__ import annotations

import asyncio
import hashlib
import http.server
import threading
import time
from pathlib import Path

import pytest
from backend.domain.contracts import ModelInfo
from backend.domain.errors import ModelDownloadFailedError
from backend.infrastructure.model.model_manifest import ModelManifest
from backend.infrastructure.model.model_store import (
    ModelDownloadCancelled,
    ModelStore,
    UrllibModelFetcher,
)
from conftest import wait_until

PAYLOAD = b"stdlib-transport-payload|" * 4096  # ~102 KiB
SLOW_CHUNK = 4096
SLOW_DELAY_S = 0.03  # ~0.78 s total: a cancelled download must beat the EOF


class _Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:
        if self.path == "/ok":
            self._serve(PAYLOAD, delay=0.0)
        elif self.path == "/slow":
            self._serve(PAYLOAD, delay=SLOW_DELAY_S)
        else:
            self.send_error(404)

    def _serve(self, payload: bytes, *, delay: float) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        try:
            for index in range(0, len(payload), SLOW_CHUNK):
                self.wfile.write(payload[index : index + SLOW_CHUNK])
                self.wfile.flush()
                if delay:
                    time.sleep(delay)
        except (BrokenPipeError, ConnectionResetError):
            # The consumer went away (e.g. cancellation closed the socket).
            pass

    def log_message(self, format: str, *args: object) -> None:
        return None  # keep test output clean


class _FixtureServer:
    """One-shot threaded HTTP server bound to an ephemeral localhost port."""

    def __init__(self) -> None:
        self._server = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Handler)
        self._server.daemon_threads = True
        self.port = self._server.server_address[1]
        self._thread = threading.Thread(target=self._server.serve_forever, daemon=True)
        self._thread.start()

    @property
    def base_url(self) -> str:
        return f"http://127.0.0.1:{self.port}"

    def stop(self) -> None:
        self._server.shutdown()
        self._server.server_close()
        self._thread.join(timeout=3.0)


def make_info(url: str, **overrides: object) -> ModelInfo:
    values: dict[str, object] = {
        "id": "base",
        "engine": "whisper",
        "multilingual": True,
        "filename": "ggml-base.bin",
        "download_url": url,
        "sha256": hashlib.sha256(PAYLOAD).hexdigest(),
        "size_bytes": len(PAYLOAD),
    }
    values.update(overrides)
    return ModelInfo(
        id=str(values["id"]),
        engine=str(values["engine"]),
        multilingual=bool(values["multilingual"]),  # type: ignore[arg-type]
        filename=str(values["filename"]),
        download_url=str(values["download_url"]),
        sha256=str(values["sha256"]),
        size_bytes=int(values["size_bytes"]),  # type: ignore[arg-type]
    )


def test_urllib_transport_streams_and_installs(tmp_path: Path) -> None:
    async def scenario() -> None:
        server = _FixtureServer()
        try:
            # Content-Length surfaces as totalBytes (§52); the body is intact.
            stream = await UrllibModelFetcher().open(f"{server.base_url}/ok")
            try:
                assert stream.total_bytes == len(PAYLOAD)
                chunks = stream.chunks()
                first = await asyncio.wait_for(chunks.__anext__(), 3.0)
                assert first == PAYLOAD[: 64 * 1024]  # 64 KiB chunks
                await chunks.aclose()
            finally:
                await stream.close()

            # The full §51 algorithm through the real store: atomic, private.
            models_dir = tmp_path / "models"
            models_dir.mkdir(parents=True)
            store = ModelStore(
                ModelManifest(models=(make_info(f"{server.base_url}/ok"),)),
                models_dir,
                UrllibModelFetcher(),
            )
            await store.download("base")
            final = models_dir / "ggml-base.bin"
            assert final.read_bytes() == PAYLOAD  # chunked reassembly is exact
            assert not (models_dir / "ggml-base.bin.part").exists()
            assert await store.is_installed("base")
        finally:
            server.stop()

    asyncio.run(scenario())


def test_http_error_maps_to_stable_download_failure(tmp_path: Path) -> None:
    async def scenario() -> None:
        server = _FixtureServer()
        try:
            fetcher = UrllibModelFetcher()
            with pytest.raises(ModelDownloadFailedError) as excinfo:
                await fetcher.open(f"{server.base_url}/missing")
            assert excinfo.value.code == "MODEL_DOWNLOAD_FAILED"
            assert "404" in str(excinfo.value.detail)

            models_dir = tmp_path / "models"
            models_dir.mkdir(parents=True)
            store = ModelStore(
                ModelManifest(models=(make_info(f"{server.base_url}/missing"),)),
                models_dir,
                fetcher,
            )
            with pytest.raises(ModelDownloadFailedError):
                await store.download("base")
            assert not (models_dir / "ggml-base.bin").exists()  # §51: never valid
            assert not (models_dir / "ggml-base.bin.part").exists()
        finally:
            server.stop()

    asyncio.run(scenario())


def test_cancel_survives_thread_boundary(tmp_path: Path) -> None:
    async def scenario() -> None:
        server = _FixtureServer()
        try:
            models_dir = tmp_path / "models"
            models_dir.mkdir(parents=True)
            store = ModelStore(
                ModelManifest(models=(make_info(f"{server.base_url}/slow"),)),
                models_dir,
                UrllibModelFetcher(),
            )
            task = asyncio.get_running_loop().create_task(store.download("base"))
            # The download is mid-stream (first 64 KiB chunk landed).
            assert await wait_until(
                lambda: (models_dir / "ggml-base.bin.part").exists(), timeout=3.0
            )
            assert store.cancel_download() is True
            with pytest.raises(ModelDownloadCancelled):
                await asyncio.wait_for(task, 2.0)  # bounded: no thread leak
            assert not (models_dir / "ggml-base.bin").exists()  # §51
            assert not (models_dir / "ggml-base.bin.part").exists()
        finally:
            server.stop()

    asyncio.run(scenario())

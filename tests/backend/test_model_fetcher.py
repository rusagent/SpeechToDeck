from __future__ import annotations

import asyncio
import hashlib
import http.server
import socket
import ssl
import sys
import threading
import time
import urllib.request
from itertools import pairwise
from pathlib import Path

import pytest
from backend.application.model_service import ModelService
from backend.application.setup_progress import (
    DETAIL_DOWNLOADING,
    STEP_MODEL_ENSURE,
    SetupProgressReporter,
)
from backend.domain.contracts import EVENT_MODEL_DOWNLOAD_COMPLETE, EVENT_SETUP_PROGRESS, ModelInfo
from backend.domain.errors import (
    ModelDownloadCancelledError,
    ModelDownloadFailedError,
    TransientModelDownloadError,
)
from backend.infrastructure.model import model_store
from backend.infrastructure.model.model_manifest import ModelManifest
from backend.infrastructure.model.model_store import (
    ModelDownloadCancelled,
    ModelStore,
    UrllibModelFetcher,
)
from conftest import FakeEventPublisher, wait_until

PAYLOAD = b"stdlib-transport-payload|" * 4096
SLOW_CHUNK = 4096
SLOW_DELAY_S = 0.03

BURST_SEGMENTS = 5
BURST_SEGMENT = 64 * 1024
BURST_PAUSE_S = 1.0
BURST_PAYLOAD = bytes(range(256)) * ((BURST_SEGMENT * BURST_SEGMENTS) // 256)
BURST_DIGEST = hashlib.sha256(BURST_PAYLOAD).hexdigest()


class _Handler(http.server.BaseHTTPRequestHandler):
    last_user_agent: str | None = None

    def do_GET(self) -> None:
        _Handler.last_user_agent = self.headers.get("User-Agent")
        if self.path == "/ok":
            self._serve(PAYLOAD, delay=0.0)
        elif self.path == "/slow":
            self._serve(PAYLOAD, delay=SLOW_DELAY_S)
        elif self.path == "/burst":
            self._serve_burst()
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
            pass

    def _serve_burst(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(BURST_PAYLOAD)))
        self.end_headers()
        try:
            for index in range(0, len(BURST_PAYLOAD), BURST_SEGMENT):
                if index:
                    time.sleep(BURST_PAUSE_S)
                self.wfile.write(BURST_PAYLOAD[index : index + BURST_SEGMENT])
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            pass

    def log_message(self, format: str, *args: object) -> None:
        return None


class _FixtureServer:

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
        multilingual=bool(values["multilingual"]),
        filename=str(values["filename"]),
        download_url=str(values["download_url"]),
        sha256=str(values["sha256"]),
        size_bytes=int(values["size_bytes"]),
    )


def test_urllib_transport_streams_and_installs(tmp_path: Path) -> None:
    async def scenario() -> None:
        server = _FixtureServer()
        try:
            stream = await UrllibModelFetcher().open(f"{server.base_url}/ok")
            try:
                assert _Handler.last_user_agent is not None
                assert _Handler.last_user_agent.startswith("SpeechToDeck/")
                assert stream.total_bytes == len(PAYLOAD)
                chunks = stream.chunks()
                first = await asyncio.wait_for(chunks.__anext__(), 3.0)
                assert first == PAYLOAD[: 64 * 1024]
                await chunks.aclose()
            finally:
                await stream.close()

            models_dir = tmp_path / "models"
            models_dir.mkdir(parents=True)
            store = ModelStore(
                ModelManifest(models=(make_info(f"{server.base_url}/ok"),)),
                models_dir,
                UrllibModelFetcher(),
            )
            await store.download("base")
            final = models_dir / "ggml-base.bin"
            assert final.read_bytes() == PAYLOAD
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
            assert "host=127.0.0.1" in str(excinfo.value.detail)
            assert not isinstance(excinfo.value, TransientModelDownloadError)

            models_dir = tmp_path / "models"
            models_dir.mkdir(parents=True)
            store = ModelStore(
                ModelManifest(models=(make_info(f"{server.base_url}/missing"),)),
                models_dir,
                fetcher,
            )
            with pytest.raises(ModelDownloadFailedError):
                await store.download("base")
            assert not (models_dir / "ggml-base.bin").exists()
            assert not (models_dir / "ggml-base.bin.part").exists()
        finally:
            server.stop()

    asyncio.run(scenario())


def test_transport_failure_is_transient_with_reason_and_host() -> None:

    async def scenario() -> None:
        probe = socket.socket()
        probe.bind(("127.0.0.1", 0))
        dead_port = probe.getsockname()[1]
        probe.close()

        with pytest.raises(TransientModelDownloadError) as excinfo:
            await UrllibModelFetcher().open(f"http://127.0.0.1:{dead_port}/ok")
        assert excinfo.value.code == "MODEL_DOWNLOAD_FAILED"
        detail = str(excinfo.value.detail)
        assert "host=127.0.0.1" in detail
        assert "errno=" in detail or "refused" in detail.lower()
        assert "ConnectionRefusedError" in detail

    asyncio.run(scenario())




class _FakeLoaderHelpers:


    def __init__(self, context: ssl.SSLContext) -> None:
        self.context = context

    def get_ssl_context(self) -> ssl.SSLContext:
        return self.context


def test_loader_context_is_chosen_when_loader_module_is_aliased(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    loader_context = ssl.create_default_context()
    monkeypatch.setitem(sys.modules, "helpers", _FakeLoaderHelpers(loader_context))
    monkeypatch.setattr(model_store, "_resolved_tls", None)

    context, source = model_store.resolve_download_tls_context()

    assert context is loader_context
    assert "loader" in source
    assert context.verify_mode == ssl.CERT_REQUIRED


def test_no_loader_falls_back_to_system_ca_chain_in_order(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    monkeypatch.setitem(sys.modules, "helpers", None)
    monkeypatch.setattr(model_store, "_resolved_tls", None)
    ca_pem = (Path(__file__).parent / "fixtures" / "test-ca-cert.pem").read_bytes()
    first = tmp_path / "ca-certificates.crt"
    second = tmp_path / "ca-bundle.crt"
    first.write_bytes(ca_pem)
    second.write_bytes(ca_pem)

    monkeypatch.setattr(
        model_store,
        "_CA_CANDIDATES",
        (str(tmp_path / "missing.crt"), str(first), str(second)),
    )
    context, source = model_store.resolve_download_tls_context()
    assert "ca-certificates.crt" in source
    assert context.verify_mode == ssl.CERT_REQUIRED

    monkeypatch.setattr(model_store, "_resolved_tls", None)
    monkeypatch.setattr(model_store, "_CA_CANDIDATES", (str(tmp_path / "missing.crt"),))
    context, source = model_store.resolve_download_tls_context()
    assert "default" in source
    assert context.verify_mode == ssl.CERT_REQUIRED


def test_download_passes_selected_context_to_urlopen(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:

    loader_context = ssl.create_default_context()
    seen: list[ssl.SSLContext | None] = []
    real_urlopen = urllib.request.urlopen

    def recording_urlopen(*args: object, **kwargs: object) -> object:
        seen.append(kwargs.get("context"))
        return real_urlopen(*args, **kwargs)

    monkeypatch.setitem(sys.modules, "helpers", _FakeLoaderHelpers(loader_context))
    monkeypatch.setattr(model_store, "_resolved_tls", None)
    monkeypatch.setattr(urllib.request, "urlopen", recording_urlopen)

    async def scenario() -> None:
        server = _FixtureServer()
        try:
            models_dir = tmp_path / "models"
            models_dir.mkdir(parents=True)
            store = ModelStore(
                ModelManifest(models=(make_info(f"{server.base_url}/ok"),)),
                models_dir,
                UrllibModelFetcher(),
            )
            await store.download("base")
            assert (models_dir / "ggml-base.bin").read_bytes() == PAYLOAD
            assert seen == [loader_context]
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
            assert await wait_until(
                lambda: (models_dir / "ggml-base.bin.part").exists(), timeout=3.0
            )
            assert store.cancel_download() is True
            with pytest.raises(ModelDownloadCancelled):
                await asyncio.wait_for(task, 2.0)
            assert not (models_dir / "ggml-base.bin").exists()
            assert not (models_dir / "ggml-base.bin.part").exists()
        finally:
            server.stop()

    asyncio.run(scenario())




class _TimedPublisher(FakeEventPublisher):

    def __init__(self) -> None:
        super().__init__()
        self.times: list[float] = []

    async def publish(self, event_name: str, payload: dict[str, object]) -> None:
        self.times.append(time.monotonic())
        await super().publish(event_name, payload)


def make_download_chain(
    models_dir: Path, url: str
) -> tuple[_TimedPublisher, SetupProgressReporter, ModelService]:
    publisher = _TimedPublisher()
    reporter = SetupProgressReporter(publisher)
    service = ModelService(
        ModelManifest(models=(make_info(url, sha256=BURST_DIGEST, size_bytes=len(BURST_PAYLOAD)),)),
        models_dir,
        UrllibModelFetcher(),
        publisher,
        setup_progress=reporter.download_progress,
    )
    return publisher, reporter, service


def ensure_frames(publisher: _TimedPublisher) -> list[tuple[float, dict[str, object]]]:
    return [
        (stamp, payload)
        for stamp, (name, payload) in zip(publisher.times, publisher.events, strict=True)
        if name == EVENT_SETUP_PROGRESS and payload["step"] == STEP_MODEL_ENSURE
    ]


def test_setup_progress_emits_steadily_through_slow_download(tmp_path: Path) -> None:

    async def scenario() -> None:
        server = _FixtureServer()
        try:
            models_dir = tmp_path / "models"
            models_dir.mkdir(parents=True)
            publisher, reporter, service = make_download_chain(
                models_dir, f"{server.base_url}/burst"
            )
            await reporter.begin_run()
            await reporter.step(1, percent=0, detail_key=DETAIL_DOWNLOADING)

            await service.download_model("base")

            frames = ensure_frames(publisher)
            percents = [int(payload["percent"]) for _, payload in frames]
            assert percents[0] == 0
            assert percents[-1] == 100
            assert percents == sorted(percents)
            increases = [b for a, b in pairwise(percents) if b > a]
            assert len(increases) >= 4
            equal = [b for a, b in pairwise(percents) if b == a]
            assert len(equal) >= 4
            assert all(payload["detailKey"] == "setup.detail.downloading" for _, payload in frames)
            gaps = [(t2 - t1) for (t1, _), (t2, _) in pairwise(frames)]
            assert len(gaps) >= 10
            assert max(gaps) < 0.75
            assert any(name == EVENT_MODEL_DOWNLOAD_COMPLETE for name, _ in publisher.events)
            assert (models_dir / "ggml-base.bin").is_file()
            assert not (models_dir / "ggml-base.bin.part").exists()
        finally:
            server.stop()

    asyncio.run(scenario())


def test_cancel_mid_download_stops_frames_and_cleans_part(tmp_path: Path) -> None:

    async def scenario() -> None:
        server = _FixtureServer()
        try:
            models_dir = tmp_path / "models"
            models_dir.mkdir(parents=True)
            publisher, reporter, service = make_download_chain(
                models_dir, f"{server.base_url}/burst"
            )
            await reporter.begin_run()
            await reporter.step(1, percent=0, detail_key=DETAIL_DOWNLOADING)

            task = asyncio.get_running_loop().create_task(service.download_model("base"))
            assert await wait_until(
                lambda: (models_dir / "ggml-base.bin.part").exists(), timeout=3.0
            )
            assert await wait_until(lambda: len(ensure_frames(publisher)) >= 2, timeout=3.0)

            with pytest.raises(ModelDownloadCancelledError) as excinfo:
                await asyncio.wait_for(task, 3.0)
            assert excinfo.value.code == "MODEL_DOWNLOAD_CANCELLED"

            frames_at_cancel = len(ensure_frames(publisher))
            await asyncio.sleep(1.1)
            assert len(ensure_frames(publisher)) == frames_at_cancel
            assert not (models_dir / "ggml-base.bin").exists()
            assert not (models_dir / "ggml-base.bin.part").exists()
        finally:
            server.stop()

    asyncio.run(scenario())

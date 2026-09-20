"""UrllibModelFetcher transport tests over a local http.server.

The SteamOS Decky runtime ships no aiohttp, so the download path runs on
the stdlib transport. These tests prove it end to end against a real local
HTTP server (no external network): Content-Length surfacing, chunked
integrity through the store algorithm, the stable failure code, and
cancellation across the worker-thread boundary.
"""

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

PAYLOAD = b"stdlib-transport-payload|" * 4096  # ~102 KiB
SLOW_CHUNK = 4096
SLOW_DELAY_S = 0.03  # ~0.78 s total: a cancelled download must beat the EOF

# Burst pacing for the setup-progress steady-feed test: one 64 KiB segment
# (one client CHUNK_SIZE read) per burst, then a >500 ms server pause. Each
# segment is 20% of the payload, so pump frames strictly increase while only
# heartbeat frames can repeat a percent during the pauses.
BURST_SEGMENTS = 5
BURST_SEGMENT = 64 * 1024
BURST_PAUSE_S = 1.0
BURST_PAYLOAD = bytes(range(256)) * ((BURST_SEGMENT * BURST_SEGMENTS) // 256)
BURST_DIGEST = hashlib.sha256(BURST_PAYLOAD).hexdigest()


class _Handler(http.server.BaseHTTPRequestHandler):
    # Last request's User-Agent, captured for the citizen-grade UA assertion.
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
            # The consumer went away (e.g. cancellation closed the socket).
            pass

    def _serve_burst(self) -> None:
        self.send_response(200)
        self.send_header("Content-Type", "application/octet-stream")
        self.send_header("Content-Length", str(len(BURST_PAYLOAD)))
        self.end_headers()
        try:
            for index in range(0, len(BURST_PAYLOAD), BURST_SEGMENT):
                if index:
                    time.sleep(BURST_PAUSE_S)  # pause before every segment but the first
                self.wfile.write(BURST_PAYLOAD[index : index + BURST_SEGMENT])
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
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
            # Content-Length surfaces as totalBytes; the body is intact.
            stream = await UrllibModelFetcher().open(f"{server.base_url}/ok")
            try:
                # Citizen-grade request identity (v0.2.5): the download
                # carries a SpeechToDeck/<version> User-Agent.
                assert _Handler.last_user_agent is not None
                assert _Handler.last_user_agent.startswith("SpeechToDeck/")
                assert stream.total_bytes == len(PAYLOAD)
                chunks = stream.chunks()
                first = await asyncio.wait_for(chunks.__anext__(), 3.0)
                assert first == PAYLOAD[: 64 * 1024]  # 64 KiB chunks
                await chunks.aclose()
            finally:
                await stream.close()

            # The full download algorithm through the real store: atomic, private.
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
            # Diagnosability: HTTP status + host in the detail.
            assert "404" in str(excinfo.value.detail)
            assert "host=127.0.0.1" in str(excinfo.value.detail)
            # HTTP status failures are not the transient retry class.
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
            assert not (models_dir / "ggml-base.bin").exists()  # never valid
            assert not (models_dir / "ggml-base.bin.part").exists()
        finally:
            server.stop()

    asyncio.run(scenario())


def test_transport_failure_is_transient_with_reason_and_host() -> None:
    """On-device v0.1.3 finding: the failure log carried only the generic
    message. A URLError-class transport failure surfaces as the transient
    subclass with the OS reason class, errno and host in the detail, so the
    startup retry ladder can classify it and the journal can be diagnosed."""

    async def scenario() -> None:
        # Bind, then close: the port is guaranteed closed → connection refused.
        probe = socket.socket()
        probe.bind(("127.0.0.1", 0))
        dead_port = probe.getsockname()[1]
        probe.close()

        with pytest.raises(TransientModelDownloadError) as excinfo:
            await UrllibModelFetcher().open(f"http://127.0.0.1:{dead_port}/ok")
        assert excinfo.value.code == "MODEL_DOWNLOAD_FAILED"  # stable code
        detail = str(excinfo.value.detail)
        assert "host=127.0.0.1" in detail  # model hosts are not sensitive
        assert "errno=" in detail or "refused" in detail.lower()
        # The wrapped OS reason class travels into the detail (not just the
        # generic wrapper name): connection refused on Linux is
        # ConnectionRefusedError.
        assert "ConnectionRefusedError" in detail

    asyncio.run(scenario())


# ── TLS context selection ───────────────────────────────────────────────────
#
# On device the plugin runs as a fork of the frozen Decky loader whose
# bundled OpenSSL does not resolve the OS CA store: downloads failed with
# CERTIFICATE_VERIFY_FAILED. The production selection takes the loader's
# certifi context via the loader's bare-name module aliasing, else the
# explicit system CA chain. Verification is never disabled (a
# verify_ssl=False-style context is explicitly rejected).


class _FakeLoaderHelpers:
    """Stand-in for the loader-aliased `decky_loader.helpers` module.

    The loader aliases every `decky_loader.*` module to its bare name before
    executing main.py (sandboxed_plugin.py:93-96), so plugin code imports
    `helpers` from sys.modules — the exact decky-steamgriddb import shape
    (main.py:12 `from helpers import get_ssl_context`).
    """

    def __init__(self, context: ssl.SSLContext) -> None:
        self.context = context

    def get_ssl_context(self) -> ssl.SSLContext:
        return self.context


def test_loader_context_is_chosen_when_loader_module_is_aliased(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """Loader present: the aliased `helpers` module's context is the chosen
    download TLS context, still requiring certificates (loader mechanism:
    decky-loader helpers.py:23,31-32 via sandboxed_plugin.py:93-96)."""
    loader_context = ssl.create_default_context()
    monkeypatch.setitem(sys.modules, "helpers", _FakeLoaderHelpers(loader_context))
    monkeypatch.setattr(model_store, "_resolved_tls", None)

    context, source = model_store.resolve_download_tls_context()

    assert context is loader_context
    assert "loader" in source  # the provenance label reports the loader context
    assert context.verify_mode == ssl.CERT_REQUIRED  # verification never disabled


def test_no_loader_falls_back_to_system_ca_chain_in_order(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Path
) -> None:
    """No loader (`helpers` import fails): the first existing system CA
    bundle wins, and with no bundle at all the default verify paths remain —
    always a certificate-requiring context."""
    # sys.modules[name] = None makes the bare import raise ImportError
    # deterministically, without depending on the host module search path.
    monkeypatch.setitem(sys.modules, "helpers", None)
    monkeypatch.setattr(model_store, "_resolved_tls", None)
    # Real PEM bodies: the resolution loads the winning bundle as a trust
    # anchor, so the candidates must be actual certificates (throwaway test
    # CA, public material only).
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
    assert "ca-certificates.crt" in source  # first *existing* candidate wins
    assert context.verify_mode == ssl.CERT_REQUIRED

    monkeypatch.setattr(model_store, "_resolved_tls", None)
    monkeypatch.setattr(model_store, "_CA_CANDIDATES", (str(tmp_path / "missing.crt"),))
    context, source = model_store.resolve_download_tls_context()
    assert "default" in source
    assert context.verify_mode == ssl.CERT_REQUIRED


def test_download_passes_selected_context_to_urlopen(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Integration through the real transport and store algorithm: the
    selected TLS context is the one handed to urlopen (the on-device
    CERTIFICATE_VERIFY_FAILED wall; steamgriddb main.py:50,65 shape)."""

    loader_context = ssl.create_default_context()
    seen: list[ssl.SSLContext | None] = []
    real_urlopen = urllib.request.urlopen

    def recording_urlopen(*args: object, **kwargs: object) -> object:
        seen.append(kwargs.get("context"))  # type: ignore[arg-type]
        return real_urlopen(*args, **kwargs)  # type: ignore[arg-type]

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
            assert (models_dir / "ggml-base.bin").read_bytes() == PAYLOAD  # intact end to end
            assert seen == [loader_context]  # the chosen context reached urlopen
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
            assert not (models_dir / "ggml-base.bin").exists()  # partial file removed
            assert not (models_dir / "ggml-base.bin.part").exists()
        finally:
            server.stop()

    asyncio.run(scenario())


# ── setup_progress steady feed through the F1/F2 chain (startup step 1) ─────


class _TimedPublisher(FakeEventPublisher):
    """FakeEventPublisher plus a monotonic receive timestamp per event."""

    def __init__(self) -> None:
        super().__init__()
        self.times: list[float] = []

    async def publish(self, event_name: str, payload: dict[str, object]) -> None:
        self.times.append(time.monotonic())
        await super().publish(event_name, payload)


def make_download_chain(
    models_dir: Path, url: str
) -> tuple[_TimedPublisher, SetupProgressReporter, ModelService]:
    """The production setup-progress chain over the real stdlib transport:
    ModelStore pump → ModelService feed → SetupProgressReporter (step 1)."""
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
    """Receive-timestamped `setup_progress` model.ensure frames."""
    return [
        (stamp, payload)
        for stamp, (name, payload) in zip(publisher.times, publisher.events, strict=True)
        if name == EVENT_SETUP_PROGRESS and payload["step"] == STEP_MODEL_ENSURE
    ]


def test_setup_progress_emits_steadily_through_slow_download(tmp_path: Path) -> None:
    """Slow local-HTTP download (real wall-clock pacing; the steady-feed
    guarantee is a timing property and cannot be proven with fake streams):
    model.ensure emits multiple frames with a monotonic percent that strictly
    increases across the bursts, equal-percent frames only where the
    heartbeat fired during the >500 ms server pauses, no inter-frame gap
    anywhere near the pause length (heartbeat: ≤ ~0.4 s; pre-heartbeat the
    gap equals the 1 s pause), final 100 then the download-complete event
    with an installed, .part-free artifact."""

    async def scenario() -> None:
        server = _FixtureServer()
        try:
            models_dir = tmp_path / "models"
            models_dir.mkdir(parents=True)
            publisher, reporter, service = make_download_chain(
                models_dir, f"{server.base_url}/burst"
            )
            # The startup path activates the reporter at step 1 before
            # the download starts (composition.py `_start_daemon`).
            await reporter.begin_run()
            await reporter.step(1, percent=0, detail_key=DETAIL_DOWNLOADING)

            await service.download_model("base")

            frames = ensure_frames(publisher)
            percents = [int(payload["percent"]) for _, payload in frames]
            assert percents[0] == 0
            assert percents[-1] == 100  # final 100 before completion
            assert percents == sorted(percents)  # monotonic non-decreasing
            increases = [b for a, b in pairwise(percents) if b > a]
            assert len(increases) >= 4  # strictly increasing across the bursts
            equal = [b for a, b in pairwise(percents) if b == a]
            assert len(equal) >= 4  # equal frames only from heartbeat ticks
            assert all(payload["detailKey"] == "setup.detail.downloading" for _, payload in frames)
            gaps = [(t2 - t1) for (t1, _), (t2, _) in pairwise(frames)]
            assert len(gaps) >= 10
            # The server pauses 1 s between bursts: without the heartbeat the
            # max gap equals a pause; with it, emissions stay well under 500 ms.
            assert max(gaps) < 0.75
            assert any(name == EVENT_MODEL_DOWNLOAD_COMPLETE for name, _ in publisher.events)
            assert (models_dir / "ggml-base.bin").is_file()  # atomic install
            assert not (models_dir / "ggml-base.bin.part").exists()
        finally:
            server.stop()

    asyncio.run(scenario())


def test_cancel_mid_download_stops_frames_and_cleans_part(tmp_path: Path) -> None:
    """Cancelling mid-download stops the model.ensure feed for good (a
    leaked heartbeat would keep emitting after the pump died) and cleans the
    .part artifact (a partially downloaded model is never valid)."""

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

            # A cancel maps to its own stable code — completion,
            # never MODEL_DOWNLOAD_FAILED (on-device finding).
            with pytest.raises(ModelDownloadCancelledError) as excinfo:
                await asyncio.wait_for(task, 3.0)
            assert excinfo.value.code == "MODEL_DOWNLOAD_CANCELLED"

            frames_at_cancel = len(ensure_frames(publisher))
            await asyncio.sleep(1.1)  # several heartbeat periods: silence must hold
            assert len(ensure_frames(publisher)) == frames_at_cancel
            assert not (models_dir / "ggml-base.bin").exists()
            assert not (models_dir / "ggml-base.bin.part").exists()
        finally:
            server.stop()

    asyncio.run(scenario())

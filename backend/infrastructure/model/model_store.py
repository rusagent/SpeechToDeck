"""ModelStore (spec §51-§53): list / is_installed / download / remove.

Download algorithm per §51: validate model id → download to `*.part` →
stream SHA-256 → validate digest → fsync → atomic rename. A partially
downloaded model is never considered valid. While a download runs, a
time-based heartbeat re-checks the §52 progress throttle so the feed (and
the setup bar fed from it) keeps moving on slow connections.

HTTP transport is isolated behind `ModelHttpFetcher`; the stdlib urllib
implementation runs the blocking request and every chunk read on a worker
thread (asyncio.to_thread, §100), and a threading.Event checked per chunk
carries cancellation across that thread boundary.

TLS context (mature-plugin adopt, audit 2026-09-17): under the Decky loader
the plugin process is a fork of the frozen loader binary whose bundled
OpenSSL does not resolve the OS CA store, so the default context fails with
CERTIFICATE_VERIFY_FAILED on device. The loader builds one certifi-backed
context for its own HTTPS (decky-loader helpers.py:9,23) and aliases its
modules into plugin sys.modules (sandboxed_plugin.py:93-96), so `helpers`
resolves exactly like the shipped decky-steamgriddb import (main.py:12;
`urlopen(req, context=get_ssl_context())` at main.py:50,65). Outside the
loader (tests, local tooling) an explicit system CA chain applies.
Verification is never disabled.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import http.client
import logging
import os
import ssl
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Protocol

from backend.domain.contracts import ModelInfo
from backend.domain.errors import (
    ModelChecksumFailedError,
    ModelDownloadFailedError,
    ModelNotInstalledError,
    TransientModelDownloadError,
)
from backend.infrastructure.model.model_manifest import MODEL_ID_RE, ModelManifest

CHUNK_SIZE = 64 * 1024
# Progress callback throttle (§52): emit when the percent delta reaches 1 or
# when this much time elapsed since the last emission, whichever first.
PROGRESS_MIN_PERCENT_DELTA = 1
PROGRESS_MIN_INTERVAL_S = 0.25
# The chunk pump only emits when a chunk arrives, so on a slow or stalled
# connection nothing re-checks that throttle. While the pump runs, a
# background heartbeat re-checks it at this interval (well under the 250 ms
# gate), keeping consecutive emissions comfortably below 500 ms apart so the
# setup bar moves steadily on slow connections. Equal-percent frames are
# expected heartbeat frames.
PROGRESS_HEARTBEAT_S = 0.1

# Blocking request timeout; one chunk read is bounded by the same budget.
_URLOPEN_TIMEOUT_S = 30.0

_PART_SUFFIX = ".part"

LOGGER = logging.getLogger("speech.model")

# System CA bundle candidates for the no-loader fallback (tests, local
# tooling), most-specific first: SteamOS/Debian, generic OpenSSL, Fedora/RHEL.
# Under the loader the certifi context wins before this chain is consulted;
# with no existing bundle the default verify paths are the last resort. A
# verification-disabling context is never constructed here.
_CA_CANDIDATES = (
    "/etc/ssl/certs/ca-certificates.crt",
    "/etc/ssl/cert.pem",
    "/etc/pki/tls/certs/ca-bundle.crt",
)

# Resolved once per process: the loader aliasing cannot change mid-process.
_resolved_tls: tuple[ssl.SSLContext, str] | None = None


def _loader_ssl_context() -> ssl.SSLContext | None:
    """The Decky loader's certifi context via its bare-name module aliasing.

    Before executing main.py the loader aliases every `decky_loader.*` module
    to its bare name (sandboxed_plugin.py:93-96), so `helpers` resolves to
    decky_loader.helpers — the exact import shape shipped by decky-steamgriddb
    (main.py:12 `from helpers import get_ssl_context`). Returns None outside
    the loader (ImportError) or for a malformed alias; only a real SSLContext
    is accepted, so an unexpected alias can never weaken verification.
    """
    try:
        from helpers import get_ssl_context  # type: ignore[import-not-found]
    except ImportError:
        return None
    context = get_ssl_context()
    return context if isinstance(context, ssl.SSLContext) else None


def resolve_download_tls_context() -> tuple[ssl.SSLContext, str]:
    """TLS context for model downloads plus its audit source label.

    Selection: the loader's certifi context when running under the Decky
    loader, else the first existing system CA bundle, else the default
    verify paths (never a verification-disabling context). The label travels
    into the journal so a TLS failure is attributable to the exact context
    in use (§73-safe: CA paths are not sensitive).
    """
    global _resolved_tls
    if _resolved_tls is None:
        loader_context = _loader_ssl_context()
        if loader_context is not None:
            _resolved_tls = (loader_context, "decky-loader certifi context")
        else:
            for candidate in _CA_CANDIDATES:
                if Path(candidate).is_file():
                    _resolved_tls = (
                        ssl.create_default_context(cafile=candidate),
                        f"system CA bundle {candidate}",
                    )
                    break
            else:
                _resolved_tls = (ssl.create_default_context(), "default verify paths")
        LOGGER.info("model download TLS context: %s", _resolved_tls[1])
    return _resolved_tls


class ModelDownloadCancelled(Exception):
    """Internal signal: the active download was cancelled by the user."""


class DownloadStream(Protocol):
    """An opened HTTP response body streamed as chunks (§51)."""

    @property
    def total_bytes(self) -> int | None:
        """Content-Length when the server advertises it."""
        ...

    def chunks(self) -> AsyncIterator[bytes]:
        """Yield body chunks; the final chunk may be short."""
        ...

    async def close(self) -> None: ...


class ModelHttpFetcher(Protocol):
    """HTTP GET port so tests never need network or threads."""

    async def open(self, url: str) -> DownloadStream: ...


def _url_host(url: str) -> str:
    """Hostname of a download URL (§73-safe: model hosts are not sensitive)."""
    return urllib.parse.urlsplit(url).hostname or "unknown-host"


def _transport_detail(exc: BaseException, host: str) -> str:
    """`ReasonClass [errno=N] <text> host=<host>` for a transport failure.

    Diagnosability without content (§73): the OS-level reason class, its
    errno/OS text and the model host — never transcript or audio data.
    URLError's wrapped OS reason is preferred over the wrapper itself.
    """
    reason = getattr(exc, "reason", None)
    cause = reason if isinstance(reason, BaseException) else exc
    errno = getattr(cause, "errno", None)
    parts = [type(cause).__name__]
    if errno is not None:
        parts.append(f"errno={errno}")
    text = str(cause).strip()
    if text:
        parts.append(text)
    parts.append(f"host={host}")
    return " ".join(parts)


def _urlopen(url: str) -> http.client.HTTPResponse:
    """Blocking GET on a worker thread; non-2xx and transport errors map to
    the stable §68 MODEL_DOWNLOAD_FAILED code with a diagnosable detail
    (reason class + HTTP status/errno + host; §73 lists no transcript/audio
    content). URLError/timeout/connection-reset failures are marked as the
    transient class the §82 startup path may retry. The request runs with the
    resolved TLS context (loader certifi context under the Decky loader,
    explicit system CA chain otherwise) so on-device downloads verify against
    a CA store the frozen loader interpreter actually resolves."""
    request = urllib.request.Request(url, headers={"Accept": "*/*"}, method="GET")
    host = _url_host(url)
    context, _ = resolve_download_tls_context()
    try:
        response: http.client.HTTPResponse = urllib.request.urlopen(
            request, timeout=_URLOPEN_TIMEOUT_S, context=context
        )
    except urllib.error.HTTPError as exc:
        exc.close()  # the error body is never read
        raise ModelDownloadFailedError(
            "model download request failed", detail=f"HTTP {exc.code} host={host}"
        ) from exc
    except urllib.error.URLError as exc:  # wraps the OS reason (timeout, DNS, reset)
        raise TransientModelDownloadError(
            "model download request failed", detail=_transport_detail(exc, host)
        ) from exc
    except OSError as exc:  # raw socket-level failures without the URLError wrap
        raise TransientModelDownloadError(
            "model download request failed", detail=_transport_detail(exc, host)
        ) from exc
    except ValueError as exc:  # unknown scheme / malformed URL: never transient
        raise ModelDownloadFailedError(
            "model download request failed", detail=f"{type(exc).__name__} host={host}"
        ) from exc
    if not 200 <= response.status < 300:
        response.close()
        raise ModelDownloadFailedError(
            "model download request failed", detail=f"HTTP {response.status} host={host}"
        )
    return response


def _content_length(response: http.client.HTTPResponse) -> int | None:
    """Advertised body size; None when the header is absent or malformed."""
    header = response.headers.get("Content-Length")
    if header is None:
        return None
    try:
        return int(header)
    except ValueError:
        return None


class UrllibModelFetcher:
    """stdlib urllib transport (§100/§101: stdlib only on the Deck runtime).

    The SteamOS Decky Loader runtime provides no aiohttp. The blocking
    request and every body read run on a worker thread via asyncio.to_thread,
    chunk-wise at CHUNK_SIZE; a threading.Event checked per chunk carries
    cancellation across the thread boundary (a read already in flight is
    bounded by one chunk). The request carries the resolved TLS context
    (`resolve_download_tls_context`).
    """

    async def open(self, url: str) -> DownloadStream:
        response = await asyncio.to_thread(_urlopen, url)
        return _UrllibDownloadStream(
            response=response,
            total_bytes=_content_length(response),
            host=_url_host(url),
        )


class _UrllibDownloadStream:
    """DownloadStream over a urllib response, read chunk-wise off the loop."""

    def __init__(
        self,
        *,
        response: http.client.HTTPResponse,
        total_bytes: int | None,
        host: str,
    ) -> None:
        self._response = response
        self._total_bytes = total_bytes
        self._host = host
        self._cancel = threading.Event()

    @property
    def total_bytes(self) -> int | None:
        return self._total_bytes

    async def chunks(self) -> AsyncIterator[bytes]:
        try:
            while True:
                if self._cancel.is_set():
                    raise ModelDownloadCancelled()
                try:
                    chunk = await asyncio.to_thread(self._read_chunk)
                except ModelDownloadCancelled:
                    raise
                except (http.client.HTTPException, OSError, TimeoutError) as exc:
                    # Mid-stream connection reset/timeout: the transient
                    # transport class, diagnosable down to errno + host.
                    raise TransientModelDownloadError(
                        "model download interrupted while streaming",
                        detail=_transport_detail(exc, self._host),
                    ) from exc
                if not chunk:
                    return
                yield chunk
        finally:
            self._cancel.set()

    def _read_chunk(self) -> bytes:
        """One blocking 64 KiB read on a worker thread (§100).

        The cancel event is checked before reading so a cancellation requested
        on the event loop stops the pump at the next chunk; a read already in
        flight is bounded by one chunk and its result is discarded.
        """
        if self._cancel.is_set():
            return b""
        return self._response.read(CHUNK_SIZE)

    async def close(self) -> None:
        """Stop the pump and release the connection (idempotent, §51)."""
        self._cancel.set()
        await asyncio.to_thread(self._response.close)


def _progress_due(received: int, total: int | None, last_percent: int, last_emit: float) -> bool:
    """Progress-callback throttle: percent delta ≥ 1 or ≥250 ms elapsed."""
    if (
        total is not None
        and total > 0
        and received * 100 // total - last_percent >= PROGRESS_MIN_PERCENT_DELTA
    ):
        return True
    return time.monotonic() - last_emit >= PROGRESS_MIN_INTERVAL_S


class ModelStore:
    """Model artifact store implementing §51 with the §52 download lock."""

    def __init__(
        self,
        manifest: ModelManifest,
        models_dir: Path,
        fetcher: ModelHttpFetcher,
        *,
        on_progress: Callable[[str, int, int | None], object] | None = None,
    ) -> None:
        self._manifest = manifest
        self._models_dir = models_dir
        self._fetcher = fetcher
        self._on_progress = on_progress
        self._download_lock = asyncio.Lock()
        self._download_task: asyncio.Task[None] | None = None

    def _resolve(self, model_id: str) -> ModelInfo:
        """Validate a model id against the manifest (§109)."""
        if MODEL_ID_RE.fullmatch(model_id) is None:
            raise ModelNotInstalledError("unknown model id", detail=f"id={model_id!r}")
        info = self._manifest.by_id(model_id)
        if info is None:
            # Manifest ids are the only allowed identifiers; traversal and
            # arbitrary ids can never resolve to a file path (§109).
            raise ModelNotInstalledError("unknown model id", detail=f"id={model_id!r}")
        return info

    def _model_path(self, info: ModelInfo) -> Path:
        # Manifest validation already rejected separators and traversal.
        return self._models_dir / info.filename

    async def list_models(self) -> list[ModelInfo]:
        return list(self._manifest.models)

    async def is_installed(self, model_id: str) -> bool:
        info = self._resolve(model_id)
        path = self._model_path(info)
        return await asyncio.to_thread(path.is_file)

    async def ensure_model(self, model_id: str) -> None:
        """Model must be present and match its committed digest (§51, §109)."""
        info = self._resolve(model_id)
        path = self._model_path(info)
        if not await asyncio.to_thread(path.is_file):
            raise ModelNotInstalledError("model is not installed", detail=f"id={model_id}")
        digest = await asyncio.to_thread(self._hash_file, path)
        if digest != info.sha256:
            raise ModelChecksumFailedError(
                "installed model file does not match its manifest digest",
                detail=f"id={model_id}",
            )

    @staticmethod
    def _hash_file(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for block in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(block)
        return digest.hexdigest()

    async def download(self, model_id: str) -> None:
        """Download, checksum, fsync and atomically install a model (§51)."""
        info = self._resolve(model_id)
        async with self._download_lock:  # §52: one download at a time
            self._download_task = asyncio.current_task()
            try:
                await self._download_locked(info)
            except ModelDownloadCancelled:
                raise
            except asyncio.CancelledError:
                raise ModelDownloadCancelled() from None
            finally:
                self._download_task = None

    async def _download_locked(self, info: ModelInfo) -> None:
        final_path = self._model_path(info)
        if final_path.is_file():
            return  # already installed; downloads are idempotent

        part_path = final_path.with_name(final_path.name + _PART_SUFFIX)
        part_path.unlink(missing_ok=True)

        digest = hashlib.sha256()
        received = 0
        last_percent = 0
        last_emit = 0.0
        try:
            stream = await self._fetcher.open(info.download_url)
            try:
                reported_total = (
                    stream.total_bytes if stream.total_bytes is not None else info.size_bytes
                )
                on_progress = self._on_progress
                last_emit = time.monotonic()

                async def emit_progress() -> None:
                    """One throttled progress emission; the chunk pump and the
                    heartbeat share it (same loop, so check-then-emit is
                    atomic between awaits)."""
                    nonlocal last_percent, last_emit
                    if on_progress is None:
                        return
                    if reported_total is not None and reported_total > 0:
                        last_percent = received * 100 // reported_total
                    last_emit = time.monotonic()
                    await _maybe_await(on_progress(info.id, received, reported_total))

                async def heartbeat() -> None:
                    """Time-based progress feed while the pump runs.

                    Re-checks the §52 throttle every PROGRESS_HEARTBEAT_S and
                    emits when due, so the feed keeps emitting (equal-percent
                    heartbeat frames) even when no chunk arrives for a while.
                    """
                    while True:
                        await asyncio.sleep(PROGRESS_HEARTBEAT_S)
                        if _progress_due(received, reported_total, last_percent, last_emit):
                            await emit_progress()

                heartbeat_task = (
                    asyncio.create_task(heartbeat()) if on_progress is not None else None
                )
                try:
                    with part_path.open("wb") as handle:
                        async for chunk in stream.chunks():
                            handle.write(chunk)
                            digest.update(chunk)
                            received += len(chunk)
                            if on_progress is not None and _progress_due(
                                received, reported_total, last_percent, last_emit
                            ):
                                await emit_progress()
                        handle.flush()
                        os.fsync(handle.fileno())  # §51: fsync before rename
                finally:
                    if heartbeat_task is not None:
                        heartbeat_task.cancel()
                        with contextlib.suppress(asyncio.CancelledError):
                            await heartbeat_task
            finally:
                await stream.close()

            if digest.hexdigest() != info.sha256:
                raise ModelChecksumFailedError(
                    "downloaded model does not match its manifest digest",
                    detail=f"id={info.id}",
                )

            final_path.parent.mkdir(parents=True, exist_ok=True)
            os.chmod(part_path, 0o600)  # §110: user-only artifacts
            os.replace(part_path, final_path)  # §51: atomic rename
        except BaseException:
            # A partially downloaded model is never valid (§51).
            part_path.unlink(missing_ok=True)
            raise

        if self._on_progress is not None:
            final_total = reported_total if reported_total is not None else received
            await _maybe_await(self._on_progress(info.id, final_total, reported_total))

    async def remove(self, model_id: str) -> None:
        """Remove an installed model; removing a missing model is idempotent."""
        info = self._resolve(model_id)
        path = self._model_path(info)

        def _remove() -> None:
            path.unlink(missing_ok=True)
            part = path.with_name(path.name + _PART_SUFFIX)
            part.unlink(missing_ok=True)

        await asyncio.to_thread(_remove)

    def cancel_download(self) -> bool:
        """Cancel the active download, if any (§52 single download)."""
        task = self._download_task
        if task is not None and not task.done():
            task.cancel()
            return True
        return False

    def download_in_progress(self) -> bool:
        task = self._download_task
        return task is not None and not task.done()


async def _maybe_await(callback_result: object) -> None:
    """Support sync and async progress callbacks."""
    if asyncio.iscoroutine(callback_result):
        await callback_result

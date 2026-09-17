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
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import http.client
import os
import threading
import time
import urllib.error
import urllib.request
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import Protocol

from backend.domain.contracts import ModelInfo
from backend.domain.errors import (
    ModelChecksumFailedError,
    ModelDownloadFailedError,
    ModelNotInstalledError,
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


def _urlopen(url: str) -> http.client.HTTPResponse:
    """Blocking GET on a worker thread; non-2xx and transport errors map to
    the stable §68 MODEL_DOWNLOAD_FAILED code (detail is a code, §73)."""
    request = urllib.request.Request(url, headers={"Accept": "*/*"}, method="GET")
    try:
        response: http.client.HTTPResponse = urllib.request.urlopen(
            request, timeout=_URLOPEN_TIMEOUT_S
        )
    except urllib.error.HTTPError as exc:
        exc.close()  # the error body is never read
        raise ModelDownloadFailedError(
            "model download request failed", detail=f"HTTP {exc.code}"
        ) from exc
    except (OSError, ValueError) as exc:  # URLError/socket errors, unknown scheme
        raise ModelDownloadFailedError(
            "model download request failed", detail=type(exc).__name__
        ) from exc
    if not 200 <= response.status < 300:
        response.close()
        raise ModelDownloadFailedError(
            "model download request failed", detail=f"HTTP {response.status}"
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
    bounded by one chunk).
    """

    async def open(self, url: str) -> DownloadStream:
        response = await asyncio.to_thread(_urlopen, url)
        return _UrllibDownloadStream(response=response, total_bytes=_content_length(response))


class _UrllibDownloadStream:
    """DownloadStream over a urllib response, read chunk-wise off the loop."""

    def __init__(self, *, response: http.client.HTTPResponse, total_bytes: int | None) -> None:
        self._response = response
        self._total_bytes = total_bytes
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
                    raise ModelDownloadFailedError(
                        "model download interrupted while streaming",
                        detail=type(exc).__name__,
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

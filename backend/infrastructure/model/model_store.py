"""ModelStore (spec §51-§53): list / is_installed / download / remove.

Download algorithm per §51: validate model id → download to `*.part` →
stream SHA-256 → validate digest → fsync → atomic rename. A partially
downloaded model is never considered valid.

HTTP transport is isolated behind `ModelHttpFetcher`; the aiohttp
implementation imports aiohttp lazily inside its method so every other path
(and the unit suite) runs without aiohttp present.
"""

from __future__ import annotations

import asyncio
import hashlib
import os
from collections.abc import AsyncIterator, Callable
from pathlib import Path
from typing import TYPE_CHECKING, Protocol

from backend.domain.contracts import ModelInfo
from backend.domain.errors import (
    ModelChecksumFailedError,
    ModelDownloadFailedError,
    ModelNotInstalledError,
)
from backend.infrastructure.model.model_manifest import MODEL_ID_RE, ModelManifest

if TYPE_CHECKING:  # pragma: no cover - import used for typing only
    import aiohttp

CHUNK_SIZE = 64 * 1024
# Progress callback throttle: emit at most one event per this many bytes.
PROGRESS_EVERY_BYTES = 256 * 1024

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
    """HTTP GET port so tests never need network or aiohttp."""

    async def open(self, url: str) -> DownloadStream: ...


class AiohttpModelFetcher:
    """aiohttp transport (§100/§101): the one sanctioned runtime dependency.

    aiohttp is imported lazily inside `open()`; Decky's runtime provides it.
    """

    async def open(self, url: str) -> DownloadStream:
        import aiohttp  # lazy: only the download path needs it

        session: aiohttp.ClientSession | None = None
        try:
            session = aiohttp.ClientSession()
            response = await session.get(url)
            response.raise_for_status()
        except Exception as exc:
            if session is not None:
                await session.close()
            if isinstance(exc, asyncio.CancelledError):
                raise
            raise ModelDownloadFailedError(
                "model download request failed", detail=type(exc).__name__
            ) from exc

        content_length = response.headers.get("Content-Length")
        total: int | None
        try:
            total = int(content_length) if content_length is not None else None
        except ValueError:
            total = None

        return _AiohttpDownloadStream(session=session, response=response, total_bytes=total)


class _AiohttpDownloadStream:
    def __init__(
        self,
        *,
        session: aiohttp.ClientSession,
        response: aiohttp.ClientResponse,
        total_bytes: int | None,
    ) -> None:
        self._session = session
        self._response = response
        self._total_bytes = total_bytes

    @property
    def total_bytes(self) -> int | None:
        return self._total_bytes

    async def chunks(self) -> AsyncIterator[bytes]:
        async for chunk in self._response.content.iter_chunked(CHUNK_SIZE):
            yield chunk

    async def close(self) -> None:
        self._response.release()
        await self._session.close()


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
        last_reported = 0
        reported_total: int | None = None
        try:
            stream = await self._fetcher.open(info.download_url)
            try:
                reported_total = (
                    stream.total_bytes if stream.total_bytes is not None else info.size_bytes
                )
                with part_path.open("wb") as handle:
                    async for chunk in stream.chunks():
                        handle.write(chunk)
                        digest.update(chunk)
                        received += len(chunk)
                        if (
                            self._on_progress is not None
                            and received - last_reported >= PROGRESS_EVERY_BYTES
                        ):
                            last_reported = received
                            await _maybe_await(self._on_progress(info.id, received, reported_total))
                    handle.flush()
                    os.fsync(handle.fileno())  # §51: fsync before rename
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

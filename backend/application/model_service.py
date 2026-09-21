from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from pathlib import Path

from backend.domain.contracts import (
    EVENT_MODEL_DOWNLOAD_COMPLETE,
    EVENT_MODEL_DOWNLOAD_PROGRESS,
    PROTOCOL_VERSION_V1,
    EventPublisher,
    ModelInfo,
)
from backend.domain.errors import (
    ModelDownloadCancelledError,
    ModelDownloadFailedError,
    ModelNotInstalledError,
)
from backend.infrastructure.model.model_manifest import MODEL_ID_RE, ModelManifest
from backend.infrastructure.model.model_store import (
    ModelDownloadCancelled,
    ModelHttpFetcher,
    ModelStore,
)

LOGGER = logging.getLogger("speech.model")


class ModelService:
    def __init__(
        self,
        manifest: ModelManifest,
        models_dir: Path,
        fetcher: ModelHttpFetcher,
        publisher: EventPublisher,
        setup_progress: Callable[[str, int, int | None], Awaitable[None]] | None = None,
    ) -> None:
        self._manifest = manifest
        self._publisher = publisher
        self._setup_progress = setup_progress
        self._store = ModelStore(
            manifest,
            models_dir,
            fetcher,
            on_progress=self._handle_progress,
        )
        self._download_task: asyncio.Task[None] | None = None

    @property
    def store(self) -> ModelStore:
        return self._store

    async def list_models(self) -> list[dict[str, object]]:
        result: list[dict[str, object]] = []
        for info in await self._store.list_models():
            installed = await self._store.is_installed(info.id)
            result.append(_model_payload(info, installed))
        return result

    async def ensure_model(self, model_id: str) -> None:
        await self._store.ensure_model(model_id)

    async def download_model(self, model_id: str) -> None:
        self._resolve(model_id)
        task = asyncio.get_running_loop().create_task(self._store.download(model_id))
        self._download_task = task
        try:
            await task
        except ModelDownloadCancelled:
            raise ModelDownloadCancelledError(
                "model download cancelled", detail=f"id={model_id}"
            ) from None
        finally:
            if self._download_task is task:
                self._download_task = None
        info = self._resolve(model_id)
        await self._publisher.publish(
            EVENT_MODEL_DOWNLOAD_COMPLETE,
            {
                "protocolVersion": PROTOCOL_VERSION_V1,
                "modelId": info.id,
                "sizeBytes": info.size_bytes,
            },
        )
        LOGGER.info("model downloaded id=%s", info.id)

    async def delete_model(self, model_id: str) -> dict[str, object]:

        info = self._resolve(model_id)
        if self._store.downloading_model_id() == info.id:
            raise ModelDownloadFailedError("model download is in flight", detail=f"id={model_id}")
        freed = await self._store.remove(model_id)
        if freed is None:
            LOGGER.info("model delete no-op (file already absent) id=%s", info.id)
        else:
            LOGGER.info("model deleted id=%s freed=%d", info.id, freed)
        payload: dict[str, object] = {"modelId": info.id}
        if freed is not None:
            payload["freedBytes"] = freed
        return payload

    def cancel_download(self) -> bool:
        task = self._download_task
        if task is not None and not task.done():
            task.cancel()
            return True
        return self._store.cancel_download()

    def download_in_progress(self) -> bool:
        return self._download_task is not None and not self._download_task.done()

    async def _handle_progress(self, model_id: str, received: int, total: int | None) -> None:
        if self._setup_progress is not None:
            await self._setup_progress(model_id, received, total)
        await self._publisher.publish(
            EVENT_MODEL_DOWNLOAD_PROGRESS,
            {
                "protocolVersion": PROTOCOL_VERSION_V1,
                "modelId": model_id,
                "bytesReceived": received,
                "totalBytes": total,
            },
        )

    def _resolve(self, model_id: str) -> ModelInfo:
        if MODEL_ID_RE.fullmatch(model_id) is None:
            raise ModelNotInstalledError("unknown model id", detail=f"id={model_id!r}")
        info = self._manifest.by_id(model_id)
        if info is None:
            raise ModelNotInstalledError("unknown model id", detail=f"id={model_id!r}")
        return info


def _model_payload(info: ModelInfo, installed: bool) -> dict[str, object]:
    payload: dict[str, object] = {
        "id": info.id,
        "engine": info.engine,
        "multilingual": info.multilingual,
        "filename": info.filename,
        "installed": installed,
    }
    if info.size_bytes is not None:
        payload["sizeBytes"] = info.size_bytes
    if info.languages is not None:
        payload["languages"] = list(info.languages)
    if info.description is not None:
        payload["description"] = info.description
    return payload

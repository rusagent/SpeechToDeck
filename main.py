from __future__ import annotations

import asyncio
import logging
import os
import sys
from collections.abc import Awaitable, Callable
from pathlib import Path

_PLUGIN_DIR = Path(__file__).resolve().parent
if str(_PLUGIN_DIR) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_DIR))

from backend.composition import Application, compose
from backend.domain.contracts import EventPublisher
from backend.domain.errors import ErrorCode, InternalError, SpeechError
from backend.infrastructure.decky_events import DeckyEventPublisher

try:
    import decky_plugin

    _DECKY: object | None = decky_plugin
except ModuleNotFoundError:
    _DECKY = None

LOGGER = logging.getLogger("plugin.lifecycle")

_DATA_DIR_ENV = "SPEECHTODECK_DATA_DIR"

DISPOSE_TIMEOUT_S = 4.0

CALLABLE_DEFAULT_BUDGET_S = 30.0

CALLABLE_BUDGET_S: dict[str, float] = {
    "stop_recording": 3600.0,
    "download_model": 3600.0,
    "update_settings": 3600.0,
    "restart_runtime": 3600.0,
}


def _resolve_data_dir() -> Path:

    override = os.environ.get(_DATA_DIR_ENV)
    if override:
        return Path(override)
    decky = _DECKY
    data_dir = getattr(decky, "DECKY_PLUGIN_RUNTIME_DIR", None) if decky is not None else None
    if isinstance(data_dir, str) and data_dir:
        return Path(data_dir)
    return Path.home() / ".local" / "share" / "SpeechToDeck"


def _resolve_event_publisher() -> EventPublisher | None:

    decky = _DECKY
    emit = getattr(decky, "emit", None) if decky is not None else None
    if not callable(emit):
        return None
    return DeckyEventPublisher(emit)


class Plugin:
    def __init__(self) -> None:
        self._app: Application | None = None
        self._disposed: bool = False
        self._compose_lock = asyncio.Lock()

    async def _main(self) -> None:
        if _DECKY is None:
            logging.basicConfig(level=logging.INFO)
        app = await self._ensure_app()
        await app.start()

    async def _unload(self) -> None:
        await self._dispose_app()

    async def _uninstall(self) -> None:
        await self._dispose_app()

    async def _migration(self) -> None:
        app = await self._ensure_app()
        await app.migrate_settings()

    async def get_capabilities(self) -> dict[str, object]:
        return await self._call("get_capabilities", lambda app: app.get_capabilities())

    async def get_status(self) -> dict[str, object]:
        return await self._call("get_status", lambda app: app.get_status())

    async def start_recording(self, session_id: str) -> dict[str, object]:
        return await self._call("start_recording", lambda app: app.start_recording(session_id))

    async def stop_recording(self, session_id: str) -> dict[str, object]:
        return await self._call("stop_recording", lambda app: app.stop_recording(session_id))

    async def cancel_recording(self, session_id: str) -> dict[str, object]:
        return await self._call("cancel_recording", lambda app: app.cancel_recording(session_id))

    async def get_settings(self) -> dict[str, object]:
        return await self._call("get_settings", lambda app: app.get_settings())

    async def update_settings(self, settings: dict[str, object]) -> dict[str, object]:
        return await self._call("update_settings", lambda app: app.update_settings(settings))

    async def list_models(self) -> dict[str, object]:
        return await self._call("list_models", lambda app: app.list_models())

    async def download_model(self, model_id: str) -> dict[str, object]:
        return await self._call("download_model", lambda app: app.download_model(model_id))

    async def cancel_model_download(self) -> dict[str, object]:
        return await self._call("cancel_model_download", lambda app: app.cancel_model_download())

    async def delete_model(self, model_id: str) -> dict[str, object]:
        return await self._call("delete_model", lambda app: app.delete_model(model_id))

    async def restart_runtime(self) -> dict[str, object]:
        return await self._call("restart_runtime", lambda app: _restart(app))

    async def _ensure_app(self) -> Application:

        if self._app is not None:
            return self._app
        async with self._compose_lock:
            if self._disposed:
                raise InternalError("plugin backend is not composed yet")
            if self._app is None:
                self._app = compose(
                    plugin_root=_PLUGIN_DIR,
                    data_dir=_resolve_data_dir(),
                    event_publisher=_resolve_event_publisher(),
                )
            return self._app

    async def _dispose_app(self) -> None:

        app = self._app
        if app is None:
            return
        self._app = None
        self._disposed = True
        try:
            await asyncio.wait_for(app.dispose(), DISPOSE_TIMEOUT_S)
        except TimeoutError:
            LOGGER.error(
                "dispose did not finish within %gs (loader SIGKILLs the backend "
                "5 s after SIGTERM): facade detached and failed closed, but the "
                "backend teardown is incomplete — session/monitor stop, the "
                "daemon SIGTERM/SIGKILL ladder and transcript cleanup may have "
                "been skipped",
                DISPOSE_TIMEOUT_S,
            )

    async def _call(
        self,
        name: str,
        operation: Callable[[Application], Awaitable[dict[str, object]]],
    ) -> dict[str, object]:

        budget = CALLABLE_BUDGET_S.get(name, CALLABLE_DEFAULT_BUDGET_S)
        try:
            result = await _budgeted(name, operation, await self._ensure_app(), budget)
        except SpeechError as error:
            detail = f" ({error.detail})" if error.detail else ""
            if error.code == ErrorCode.MODEL_DOWNLOAD_CANCELLED:
                LOGGER.info("%s cancelled: %s", name, str(error.code))
            elif error.session_id is not None:
                LOGGER.warning(
                    "%s failed: %s (session=%s)%s",
                    name,
                    str(error.code),
                    error.session_id,
                    detail,
                )
            else:
                LOGGER.warning("%s failed: %s%s", name, str(error.code), detail)
            return {"ok": False, **error.payload()}
        return {"ok": True, **result}


async def _restart(app: Application) -> dict[str, object]:
    await app.restart_runtime()
    return {"restarted": True}


async def _budgeted(
    name: str,
    operation: Callable[[Application], Awaitable[dict[str, object]]],
    app: Application,
    budget: float,
) -> dict[str, object]:

    try:
        return await asyncio.wait_for(operation(app), budget)
    except TimeoutError as error:
        raise InternalError(
            f"{name} exceeded its {budget:g}s callable budget",
            detail=f"budget={budget:g}s",
        ) from error

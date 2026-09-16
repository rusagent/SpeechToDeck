"""Decky plugin entrypoint: deliberately thin facade (spec §31).

Exposes exactly the §30 callables and delegates every concern to the composed
application (backend/composition.py). This module contains no process
management, no model downloads, no filesystem business logic, and no
transcription state transitions.

All Decky loader imports are guarded so the module (and the plugin surface)
can be imported and exercised without Decky present (tests, local tooling).
"""

from __future__ import annotations

import logging
import os
from collections.abc import Awaitable, Callable
from pathlib import Path

from backend.composition import Application, compose
from backend.domain.errors import InternalError, SpeechError

try:  # Decky loader injects this module into the plugin process.
    import decky_plugin  # type: ignore[import-not-found]

    _DECKY: object | None = decky_plugin
except ModuleNotFoundError:  # not running under the Decky loader
    _DECKY = None

LOGGER = logging.getLogger("plugin.lifecycle")

_DATA_DIR_ENV = "DECKY_VOICE_KEYBOARD_DATA_DIR"


def _resolve_data_dir() -> Path:
    """Plugin data dir: explicit override → Decky home → local dev fallback.

    The override also lets tests and tooling isolate all writable state
    (§109: writable paths restricted to the plugin data directory).
    """
    override = os.environ.get(_DATA_DIR_ENV)
    if override:
        return Path(override)
    decky = _DECKY
    home = getattr(decky, "DECKY_PLUGIN_HOME", None) if decky is not None else None
    if isinstance(home, str) and home:
        return Path(home)
    return Path.home() / ".local" / "share" / "decky-voice-keyboard"


class Plugin:
    """Thin §31 facade: every callable delegates; none implements logic."""

    def __init__(self) -> None:
        self._app: Application | None = None

    # ── Decky lifecycle hooks (§31) ──────────────────────────────────────────

    async def _main(self) -> None:
        if _DECKY is None:
            logging.basicConfig(level=logging.INFO)
        app = compose(
            plugin_root=Path(__file__).resolve().parent,
            data_dir=_resolve_data_dir(),
        )
        self._app = app
        await app.start()

    async def _unload(self) -> None:
        await self._require_app().dispose()

    async def _uninstall(self) -> None:
        await self._require_app().dispose()

    async def _migration(self) -> None:
        await self._require_app().migrate_settings()

    # ── §30 callables ────────────────────────────────────────────────────────

    async def get_capabilities(self) -> dict[str, object]:
        return await self._call(lambda app: app.get_capabilities())

    async def get_status(self) -> dict[str, object]:
        return await self._call(lambda app: app.get_status())

    async def start_recording(self, session_id: str) -> dict[str, object]:
        return await self._call(lambda app: app.start_recording(session_id))

    async def stop_recording(self, session_id: str) -> dict[str, object]:
        return await self._call(lambda app: app.stop_recording(session_id))

    async def cancel_recording(self, session_id: str) -> dict[str, object]:
        return await self._call(lambda app: app.cancel_recording(session_id))

    async def get_settings(self) -> dict[str, object]:
        return await self._call(lambda app: app.get_settings())

    async def update_settings(self, settings: dict[str, object]) -> dict[str, object]:
        return await self._call(lambda app: app.update_settings(settings))

    async def list_models(self) -> dict[str, object]:
        return await self._call(lambda app: app.list_models())

    async def download_model(self, model_id: str) -> dict[str, object]:
        return await self._call(lambda app: app.download_model(model_id))

    async def cancel_model_download(self) -> dict[str, object]:
        return await self._call(lambda app: app.cancel_model_download())

    async def restart_runtime(self) -> dict[str, object]:
        return await self._call(lambda app: _restart(app))

    # ── internals ────────────────────────────────────────────────────────────

    def _require_app(self) -> Application:
        if self._app is None:
            raise InternalError("plugin backend is not composed yet")
        return self._app

    async def _call(
        self,
        operation: Callable[[Application], Awaitable[dict[str, object]]],
    ) -> dict[str, object]:
        """§68: stable coded results across the Decky boundary; UI text is
        mapped from `code` on the frontend, never from exception strings."""
        try:
            result = await operation(self._require_app())
        except SpeechError as error:
            return {"ok": False, **error.payload()}
        return {"ok": True, **result}


async def _restart(app: Application) -> dict[str, object]:
    await app.restart_runtime()
    return {"restarted": True}

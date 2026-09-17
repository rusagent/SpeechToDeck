"""Decky plugin entrypoint: deliberately thin facade (spec §31).

Exposes exactly the §30 callables and delegates every concern to the composed
application (backend/composition.py). The application is composed lazily on
first use under a lock: the Decky loader runs `_migration` before `_main`
(observed on device, journal 2026-09-17), so no hook may assume `_main` has
composed the backend first. This module contains no process management, no
model downloads, no filesystem business logic, and no transcription state
transitions.

All Decky loader imports are guarded so the module (and the plugin surface)
can be imported and exercised without Decky present (tests, local tooling).
"""

from __future__ import annotations

import asyncio
import logging
import os
import sys
from collections.abc import Awaitable, Callable
from pathlib import Path

_PLUGIN_DIR = Path(__file__).resolve().parent
if str(_PLUGIN_DIR) not in sys.path:
    # Decky loader sandbox (api_version>=1) puts no plugin dir on sys.path (verified on device).
    sys.path.insert(0, str(_PLUGIN_DIR))

from backend.composition import Application, compose  # noqa: E402
from backend.domain.errors import InternalError, SpeechError  # noqa: E402

try:  # Decky loader injects this module into the plugin process.
    import decky_plugin  # type: ignore[import-not-found]

    _DECKY: object | None = decky_plugin
except ModuleNotFoundError:  # not running under the Decky loader
    _DECKY = None

LOGGER = logging.getLogger("plugin.lifecycle")

_DATA_DIR_ENV = "SPEECHTODECK_DATA_DIR"


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
    return Path.home() / ".local" / "share" / "SpeechToDeck"


class Plugin:
    """Thin §31 facade: every callable delegates; none implements logic."""

    def __init__(self) -> None:
        self._app: Application | None = None
        # `_disposed` fails closed after `_unload`/`_uninstall`; `_compose_lock`
        # serializes lazy composition so concurrent loader hooks compose once.
        self._disposed: bool = False
        self._compose_lock = asyncio.Lock()

    # ── Decky lifecycle hooks (§31) ──────────────────────────────────────────

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

    async def _ensure_app(self) -> Application:
        """Double-checked lazy composition (§31 lifecycle order).

        The Decky loader may call any hook first (`_migration` runs before
        `_main` on device), so the first caller composes once under the lock
        and every later caller reuses the same Application. After
        `_unload`/`_uninstall` the facade is disposed and fails closed with
        the stable §68 INTERNAL_ERROR code.
        """
        if self._app is not None:
            return self._app
        async with self._compose_lock:
            if self._disposed:
                raise InternalError("plugin backend is not composed yet")
            if self._app is None:
                self._app = compose(
                    plugin_root=_PLUGIN_DIR,
                    data_dir=_resolve_data_dir(),
                )
            return self._app

    async def _dispose_app(self) -> None:
        """Idempotent teardown: dispose exactly once, then fail closed.

        The facade detaches before awaiting `dispose()` so a callable racing
        the unload fails closed instead of touching a half-disposed backend.
        """
        app = self._app
        if app is None:
            return  # never composed (or already disposed): nothing to tear down
        self._app = None
        self._disposed = True
        await app.dispose()

    async def _call(
        self,
        operation: Callable[[Application], Awaitable[dict[str, object]]],
    ) -> dict[str, object]:
        """§68: stable coded results across the Decky boundary; UI text is
        mapped from `code` on the frontend, never from exception strings."""
        try:
            result = await operation(await self._ensure_app())
        except SpeechError as error:
            return {"ok": False, **error.payload()}
        return {"ok": True, **result}


async def _restart(app: Application) -> dict[str, object]:
    await app.restart_runtime()
    return {"restarted": True}

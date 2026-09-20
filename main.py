"""Decky plugin entrypoint: deliberately thin facade (spec §31).

Exposes exactly the §30 callables (plus the owner-requested `delete_model`
in-app model cleanup route) and delegates every concern to the composed
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
from backend.domain.contracts import EventPublisher  # noqa: E402
from backend.domain.errors import ErrorCode, InternalError, SpeechError  # noqa: E402
from backend.infrastructure.decky_events import DeckyEventPublisher  # noqa: E402

try:  # Decky loader injects this module into the plugin process.
    import decky_plugin  # type: ignore[import-not-found]

    _DECKY: object | None = decky_plugin
except ModuleNotFoundError:  # not running under the Decky loader
    _DECKY = None

LOGGER = logging.getLogger("plugin.lifecycle")

_DATA_DIR_ENV = "SPEECHTODECK_DATA_DIR"

# ── §71 budgets (loader v3.2.9 install/reload-race audit) ────────────────────
# The loader waits for a plugin callable reply WITHOUT a timeout (loader
# v3.2.9 messages.py:39-44) and bounds the backend only at unload: SIGTERM,
# then SIGKILL after 5 s (plugin.py:161-183). One hung await therefore froze
# the panel forever ("Loading settings…" with a healthy backend), and a hung
# teardown dies mid-flight under the SIGKILL. Every §30 callable and the
# disposal therefore run under an explicit, documented budget: no wait on any
# callable path is unbounded (§71).
#
# Disposal must always fit the loader's ~5 s SIGKILL budget with margin: 4 s
# leaves ~1 s for the loader's own shutdown bookkeeping around our teardown.
# The facade detaches BEFORE `dispose()` (see `_dispose_app`), so after a
# timeout we only log loudly what was left incomplete — never propagate a
# hang.
DISPOSE_TIMEOUT_S = 4.0

# Default callable budget: covers settings/model-store/filesystem reads and
# the daemon acknowledgement paths (each internally bounded at
# ACK_TIMEOUT_S = 2 s, voxtype_client.py:56). Routes whose legitimate
# worst-case latency exceeds this get explicit entries below; everything
# unlisted uses the default. `delete_model` (in-app model cleanup) is
# deliberately unlisted: it is a manifest-resolved single unlink — a fast
# route under the default, not a latency outlier.
CALLABLE_DEFAULT_BUDGET_S = 30.0

# Per-route budgets for §30 callables with legitimately longer latency
# (§71: generous but always bounded). Keys are the callable names as passed
# to `Plugin._call`.
CALLABLE_BUDGET_S: dict[str, float] = {
    # `record stop --wait` transcription scales with the recording
    # (max(120 s, 2x recorded) + 5 s CLI grace — voxtype_client.py:74-87). The
    # 24 h recording valve (ADR-012) is a runaway guard, not a use case, so
    # 1 h covers ≈30 min of recorded dictation — far beyond the §74
    # mic-button flow.
    "stop_recording": 3600.0,
    # `download_model` awaits the FULL download (model_service.py:79-105);
    # 1 h covers the largest curated model (1.6 GB, defaults/models.json) at
    # a poor-but-plausible ≈0.5 MB/s deck Wi-Fi.
    "download_model": 3600.0,
    # `update_settings` may drive the full §82 lifecycle transition under the
    # lifecycle lock (composition.py:531-556): a first-run enable can download
    # the model (with the §70 retry ladder), and every runtime-relevant change
    # restarts the daemon with up to MODEL_WARMUP_TIMEOUT_S = 60 s warmup
    # (composition.py:72) plus the ≤5 s §38 shutdown ladder — the same
    # worst case as download_model.
    "update_settings": 3600.0,
    # `restart_runtime` re-runs the whole §82 path (composition.py:429-449):
    # §38 shutdown + runtime verify + model ensure/download + start + 60 s
    # warmup — the same worst case as update_settings.
    "restart_runtime": 3600.0,
}


def _resolve_data_dir() -> Path:
    """Plugin data dir: explicit override → Decky persistent data → local fallback.

    Under the Decky loader the sanctioned persistent data directory is
    `DECKY_PLUGIN_RUNTIME_DIR`: the loader maps it to `$DECKY_HOME/data/<plugin>`
    and pre-creates it before start (loader plugin.py:72-79). Despite the
    "RUNTIME" name it is the persistent per-plugin data dir — the loader never
    clears it and no `DECKY_PLUGIN_DATA_DIR` global exists (loader audit
    2026-09-17, finding 5: `DECKY_PLUGIN_HOME` does not exist). Our app-level
    transient state stays scoped under `<data_dir>/runtime`
    (`PluginPaths.runtime_dir`). The override also lets tests and tooling
    isolate all writable state (§109: writable paths restricted to the plugin
    data directory).
    """
    override = os.environ.get(_DATA_DIR_ENV)
    if override:
        return Path(override)
    decky = _DECKY
    data_dir = getattr(decky, "DECKY_PLUGIN_RUNTIME_DIR", None) if decky is not None else None
    # The loader module defaults every global to "" when its env var is absent,
    # so an empty string must fall through to the local dev path, never Path("").
    if isinstance(data_dir, str) and data_dir:
        return Path(data_dir)
    return Path.home() / ".local" / "share" / "SpeechToDeck"


def _resolve_event_publisher() -> EventPublisher | None:
    """The real Decky event transport when running under the loader.

    `decky_plugin.emit` is a module-level coroutine patched in by the loader
    (sandboxed_plugin.py:99-110), so the bound callable is passed directly.
    Without Decky (tests, tooling) `None` keeps the `compose` default
    (`LoggingEventPublisher`, events logged with transcript text redacted).
    """
    decky = _DECKY
    emit = getattr(decky, "emit", None) if decky is not None else None
    if not callable(emit):
        return None
    return DeckyEventPublisher(emit)


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
                    event_publisher=_resolve_event_publisher(),
                )
            return self._app

    async def _dispose_app(self) -> None:
        """Idempotent teardown: dispose exactly once, then fail closed.

        The facade detaches before awaiting `dispose()` so a callable racing
        the unload fails closed instead of touching a half-disposed backend.

        §71: the dispose await is bounded at `DISPOSE_TIMEOUT_S` (4 s), inside
        the loader's unload budget (loader v3.2.9 plugin.py:161-183: SIGTERM,
        then SIGKILL after 5 s — 4 s leaves ~1 s of margin for the loader's
        own shutdown bookkeeping). On expiry the operation is cancelled, the
        detach-before-dispose ordering above has already failed the surface
        closed, and the skipped backend teardown is logged loudly instead of
        hanging into the SIGKILL.
        """
        app = self._app
        if app is None:
            return  # never composed (or already disposed): nothing to tear down
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
        """§68: stable coded results across the Decky boundary; UI text is
        mapped from `code` on the frontend, never from exception strings.

        Diagnosability choke point: a failed callable is logged here exactly
        once (WARNING) with the callable name, the stable §68 code, the
        session id when the error carries one, and the error's diagnosable
        detail string (HTTP status/errno + host — §73-safe by construction:
        details never carry transcript or audio content). Inner layers stay
        quiet for these coded failures, so one journal line names the failing
        press, its layer and the reason. Successful calls stay quiet (no log
        spam). A user-initiated model-download cancel (§52) is completion,
        not failure: it logs at INFO without "failed" wording so a routine
        cancel never reads like a network failure in the journal (on-device
        v0.2.4 finding).

        §71: the operation runs under its per-route budget
        (`CALLABLE_BUDGET_S`, default `CALLABLE_DEFAULT_BUDGET_S`); a hung
        operation is cancelled and surfaces through this same choke point as
        the stable §68 INTERNAL_ERROR envelope, because the loader itself
        waits for a callable reply without a timeout (loader v3.2.9
        messages.py:39-44).
        """
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
    """Run one §30 operation under its §71 budget (loader v3.2.9 audit).

    The loader waits for a callable reply without a timeout (messages.py:39-44),
    so this budget is the only bound: on expiry the operation is cancelled and
    re-raised as the stable §68 INTERNAL_ERROR, so `_call`'s single choke point
    logs it once and the frontend receives a normal coded failure instead of an
    eternal wait. The detail carries only the callable name and budget — no
    transcript or audio content (§73).
    """
    try:
        return await asyncio.wait_for(operation(app), budget)
    except TimeoutError as error:
        raise InternalError(
            f"{name} exceeded its {budget:g}s callable budget",
            detail=f"budget={budget:g}s",
        ) from error

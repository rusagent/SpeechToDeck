"""Composition root (spec §5, §6): construct and wire everything; no globals.

`compose()` builds the object graph once; `Application` owns the runtime
lifecycle (§82 startup, §38/§83 disposal) and exposes the §30 backend
operations that `main.py` delegates to. No dependency is instantiated inside
application-domain classes.
"""

from __future__ import annotations

import asyncio
import logging
from collections.abc import Awaitable, Callable
from pathlib import Path

from backend.application.model_service import ModelService
from backend.application.setup_progress import (
    DETAIL_CHECKSUM,
    DETAIL_DOWNLOADING,
    DETAIL_SPAWNING,
    DETAIL_VERIFYING,
    DETAIL_WARMUP,
    SetupProgressReporter,
)
from backend.application.speech_service import SpeechApplicationService
from backend.domain.contracts import (
    EVENT_RUNTIME_STATUS,
    PROTOCOL_VERSION_V1,
    EventPublisher,
    Settings,
)
from backend.domain.errors import (
    ModelNotInstalledError,
    RuntimeStartError,
    RuntimeUnavailableError,
    SettingsInvalidError,
    SpeechError,
)
from backend.domain.session import SpeechSessionCoordinator
from backend.infrastructure.model.model_manifest import ModelManifest, load_model_manifest
from backend.infrastructure.model.model_store import ModelHttpFetcher, UrllibModelFetcher
from backend.infrastructure.process.daemon_supervisor import SpeechDaemonSupervisor
from backend.infrastructure.process.process_environment import (
    PluginPaths,
    ensure_directories,
)
from backend.infrastructure.process.runtime_variant import RuntimeVariantResolver
from backend.infrastructure.process.status_monitor import (
    RuntimeStatusMonitor,
    StatusFileWatcher,
    WatchEvent,
)
from backend.infrastructure.process.voxtype_client import VoxtypeClient
from backend.infrastructure.settings.json_settings_repository import (
    JsonSettingsRepository,
    settings_from_payload,
)

LOGGER = logging.getLogger("plugin.lifecycle")

# §82 model.warmup budget (§71: no wait is unbounded): long enough to span
# the §70 restart ladder (bounded delays ≤ 8 s + spawns) so a daemon brought
# back by the restart policy can still report idle, short enough to fail
# closed with a stable code instead of hanging the startup path.
MODEL_WARMUP_TIMEOUT_S = 60.0

# §36/§65: settings the native daemon consumes at start (see
# SpeechDaemonSupervisor._spawn). While the daemon is up, a change to any of
# them requires a supervised restart for the new value to take effect.
_RUNTIME_FIELDS = (
    "model_id",
    "compute_backend",
    "language",
    "max_recording_seconds",
    "vad_enabled",
)


def _runtime_relevant_change(before: Settings, after: Settings) -> bool:
    return any(getattr(before, field) != getattr(after, field) for field in _RUNTIME_FIELDS)


def _daemon_idle(event: WatchEvent) -> bool:
    """Warmup predicate: the daemon state file reports idle (§41 watcher)."""
    snapshot = event.snapshot
    return event.kind == "status" and snapshot is not None and snapshot.state == "idle"


class LoggingEventPublisher:
    """EventPublisher used when no Decky event transport is wired.

    Deliberate and visible: without a transport, events are logged (with
    transcript text redacted, §73) instead of being silently dropped.
    """

    def __init__(self) -> None:
        self._logger = logging.getLogger("plugin.events")

    async def publish(self, event_name: str, payload: dict[str, object]) -> None:
        self._logger.info("event=%s payload=%s", event_name, _redact(payload))


def _redact(payload: dict[str, object]) -> dict[str, object]:
    redacted = dict(payload)
    if "text" in redacted:
        value = redacted["text"]
        length = len(value) if isinstance(value, str) else -1
        redacted["text"] = f"<redacted:{length} chars>"
    return redacted


class Application:
    """Composed backend: owns lifecycle and the §30 operations."""

    def __init__(
        self,
        *,
        paths: PluginPaths,
        publisher: EventPublisher,
        settings: JsonSettingsRepository,
        models: ModelService,
        speech: SpeechApplicationService,
        supervisor: SpeechDaemonSupervisor,
        monitor: RuntimeStatusMonitor,
        client: VoxtypeClient,
        watcher: StatusFileWatcher,
        manifest: ModelManifest,
        resolver: RuntimeVariantResolver,
        setup_progress: SetupProgressReporter,
    ) -> None:
        self.paths = paths
        self.publisher = publisher
        self.settings_repository = settings
        self.models = models
        self.speech = speech
        self.supervisor = supervisor
        self.monitor = monitor
        self.client = client
        self.watcher = watcher
        self.manifest = manifest
        self.resolver = resolver
        self.setup_progress = setup_progress
        self._started = False
        self._disposed = False
        # Serializes every §36 lifecycle transition (§82 startup, settings
        # transitions, §38/§83 disposal): concurrent updates coalesce into
        # one ordered sequence, never restart in parallel, and a disable
        # during startup or an update during unload cannot leave a daemon
        # that contradicts the disposed/disabled state.
        self._lifecycle_lock = asyncio.Lock()

    # ── lifecycle (§82 startup, §36 settings transitions, §38/§83 disposal) ──

    async def start(self) -> None:
        """Load settings, start status consumption, then the daemon (§82).

        A daemon start failure is surfaced (`runtime_status` unavailable) but
        never crashes the plugin: recovery is the explicit restart action
        (§69). Settings/models callables keep working.
        """
        if self._started:
            return
        async with self._lifecycle_lock:
            if self._started or self._disposed:
                return
            self._started = True
            ensure_directories(self.paths)
            settings = await self.settings_repository.load()
            try:
                await self.monitor.start()
            except OSError as exc:
                # §41 requires event-driven status consumption; without it the
                # runtime cannot be supervised safely → fail closed, but keep
                # the settings/models surface usable.
                LOGGER.error("status monitor unavailable: %s", exc)
                await self._publish_runtime_unavailable("status monitor unavailable")
                return

            if not settings.enabled:
                LOGGER.info("plugin disabled by settings; runtime not started")
                return

            await self._start_daemon(settings)

    async def _start_daemon(self, settings: Settings) -> None:
        """§82 tail: verify the runtime, ensure the model, start the
        supervised daemon, wait for warmup — emitting the `setup_progress`
        stream along the way (frozen contract: backend/application/
        setup_progress.py).

        A failure at any step is surfaced (the terminal `failed` setup event
        plus `runtime_status` unavailable) but never crashes the plugin: the
        runtime stays in the existing fail-closed down state (§69), recovery
        is the explicit restart action. Settings/models callables keep
        working.
        """
        setup = self.setup_progress
        await setup.begin_run()
        # Step 0 — runtime.verify: pinned binary presence + digest (§53).
        await setup.step(0, percent=0, detail_key=DETAIL_CHECKSUM)
        try:
            await self.supervisor.verify(settings)
        except SpeechError as exc:
            LOGGER.error("runtime verification failed: %s (%s)", exc.message, exc.detail)
            await self._fail_startup(setup, exc)
            return
        await setup.step(0, percent=100)

        # Step 1 — model.ensure: digest-verify the installed model, or
        # download it with real percent from the throttled download feed
        # (§51; the §52 cancel path stays live during startup).
        installed = await self.models.store.is_installed(settings.model_id)
        await setup.step(
            1,
            percent=0,
            detail_key=DETAIL_VERIFYING if installed else DETAIL_DOWNLOADING,
        )
        try:
            if installed:
                await self.models.ensure_model(settings.model_id)
            else:
                # First-run setup: the download validates the digest and
                # installs atomically (§51), so no second ensure is needed.
                await self.models.download_model(settings.model_id)
        except SpeechError as exc:
            LOGGER.error("model unavailable at startup: %s", exc.message)
            await self._fail_startup(setup, exc)
            return
        await setup.step(1, percent=100)

        # Step 2 — daemon.start: config generation, spawn, alive wait.
        await setup.step(2, percent=0, indeterminate=True, detail_key=DETAIL_SPAWNING)
        try:
            await self.supervisor.start(settings)
        except SpeechError as exc:
            LOGGER.error("runtime start failed: %s (%s)", exc.message, exc.detail)
            await self._fail_startup(setup, exc)
            return
        if not self.supervisor.is_running():
            LOGGER.error("runtime start failed: daemon process exited immediately")
            await self._fail_startup(setup, RuntimeStartError("daemon process exited immediately"))
            return
        # §32 SpeechRuntime.start: initialize the runtime surface (status
        # watch) so warmup is observed through the live monitor path.
        await self.client.start()

        # Step 3 — model.warmup: bounded wait for the daemon state file to
        # report idle through the §41 status watcher.
        await setup.step(3, percent=0, indeterminate=True, detail_key=DETAIL_WARMUP)
        if await self.watcher.wait_until(_daemon_idle, MODEL_WARMUP_TIMEOUT_S) is None:
            LOGGER.error(
                "runtime warmup failed: daemon did not report idle within %gs",
                MODEL_WARMUP_TIMEOUT_S,
            )
            await self._fail_startup(
                setup,
                RuntimeStartError("daemon did not report idle within the warmup budget"),
            )
            return
        await setup.ready()

    async def _fail_startup(self, setup: SetupProgressReporter, exc: SpeechError) -> None:
        """Terminal `failed` setup event + the existing fail-closed surface."""
        await setup.fail(str(exc.code))
        await self._publish_runtime_unavailable(exc.message)

    async def dispose(self) -> None:
        """§38/§83 disposal order; every step idempotent.

        Runs under `_lifecycle_lock`, so an `update_settings` transition in
        flight during unload completes (or is fenced by `_disposed`) before
        the daemon is torn down — `dispose()` never races a spawn into an
        orphaned daemon.
        """
        if self._disposed:
            return
        async with self._lifecycle_lock:
            if self._disposed:
                return
            self._disposed = True
            # 1-2. stop accepting sessions; cancel any active recording (§38).
            await self.speech.shutdown()
            try:
                await self.client.cancel_recording()
            except SpeechError as exc:
                LOGGER.info("nothing to cancel at dispose: %s", exc.code)
            # 3. stop status monitor; 4. SIGTERM daemon → bounded wait → SIGKILL.
            await self.monitor.stop()
            await self.supervisor.stop()
            # 5. silence runtime deliveries; close the watcher.
            await self.client.stop()
            self.watcher.close()
            # 6. §110: transient transcript file removed on clean shutdown.
            self.paths.output_file.unlink(missing_ok=True)
            self._started = False

    async def restart_runtime(self) -> None:
        """§69: fatal runtime errors recover only via explicit restart."""
        settings = await self.settings_repository.load()
        if not settings.enabled:
            raise RuntimeUnavailableError("plugin is disabled by settings")
        await self.models.ensure_model(settings.model_id)
        await self.supervisor.restart(settings)

    async def migrate_settings(self) -> Settings:
        """§31 `_migration`: run the settings migration chain forward once."""
        settings = await self.settings_repository.load()
        await self.settings_repository.save(settings)
        return settings

    # ── §30 callables ────────────────────────────────────────────────────────

    async def get_capabilities(self) -> dict[str, object]:
        """§57 speech-side capability half (the frontend probes the Steam side).

        The microphone and compute-backend probes live inside the native
        daemon (§115 Spike C/D, hardware-gated); until a live daemon reports,
        this report stays conservative (§57: no optimistic assumption):

        - the running daemon owns the microphone; per-recording failures
          surface as the §68 ``MICROPHONE_UNAVAILABLE`` code, so microphone
          availability is reported as the runtime's availability;
        - the CPU backend is the pinned runtime's baseline compute path on the
          supported platform, so it is always reported available;
        - Vulkan is only claimed when the resolved runtime variant is the
          vulkan binary (§47 selection).
        """
        settings = await self.settings_repository.load()
        running = self.supervisor.is_running()
        return {
            "protocolVersion": PROTOCOL_VERSION_V1,
            "speechRuntimeAvailable": running,
            "microphoneAvailable": running,
            "cpuAvailable": True,
            "vulkanAvailable": self.resolver.selected_backend == "vulkan",
            "modelInstalled": await self.models.store.is_installed(settings.model_id),
            # §54 context for diagnostics; the §99 guard ignores extra fields.
            "computeBackend": settings.compute_backend,
            "modelId": settings.model_id,
            "language": settings.language,
        }

    async def get_status(self) -> dict[str, object]:
        settings = await self.settings_repository.load()
        running = self.supervisor.is_running()
        return {
            "protocolVersion": PROTOCOL_VERSION_V1,
            "runtime": {
                "running": running,
                "state": "running" if running else "stopped",
                "restartAttempts": self.supervisor.restart_attempts,
                "enabled": settings.enabled,
            },
            "speech": self.speech.get_status(),
            "modelDownloadInProgress": self.models.download_in_progress(),
        }

    async def get_settings(self) -> dict[str, object]:
        settings = await self.settings_repository.load()
        return settings.to_payload()

    async def update_settings(self, update: dict[str, object]) -> dict[str, object]:
        """Merge a partial wire payload, persist atomically (§55), then drive
        the runtime lifecycle per §36/§64/§65.

        One lock spans read-modify-write and the lifecycle transition, and is
        shared with `start()`/`dispose()`: startup, settings transitions and
        disposal are strictly ordered, so a disable arriving during startup
        still ends with the daemon down (§36/§64) and an update arriving
        during unload never respawns the daemon after `dispose()` (§38/§83).
        Concurrent updates are applied in order and never restart in
        parallel (§70 storm guard). Lifecycle failures are surfaced as
        `runtime_status` events, never as call failures: the settings
        document itself was valid and persisted.
        """
        async with self._lifecycle_lock:
            current = await self.settings_repository.load()
            merged = current.to_payload()
            for key, value in update.items():
                if key == "schemaVersion":
                    # §55: the version is backend-owned; clients never set it.
                    raise SettingsInvalidError("schemaVersion is managed by the backend")
                merged[key] = value
            validated = settings_from_payload(merged)
            await self.settings_repository.save(validated)
            await self._apply_runtime_lifecycle(current, validated)
            return validated.to_payload()

    async def _apply_runtime_lifecycle(self, before: Settings, after: Settings) -> None:
        """§36: the daemon lives exactly while dictation is enabled and its
        start configuration is current; §64: it is absent while disabled.

        Runs with `_lifecycle_lock` held (from `update_settings`), so the
        `_disposed` fence is race-free: once disposal completed, a late
        settings update persists but performs no lifecycle transition.
        """
        if self._disposed:
            return
        if before.enabled and not after.enabled:
            await self._shutdown_runtime()
        elif not before.enabled and after.enabled:
            await self._startup_runtime(after)
        elif (
            after.enabled
            and self.supervisor.is_running()
            and _runtime_relevant_change(before, after)
        ):
            await self._restart_runtime(after)
        # A runtime-relevant change while the daemon is down starts nothing:
        # §70 leaves the runtime unavailable until an explicit restart, and
        # the next start picks up the persisted settings.

    async def _shutdown_runtime(self) -> None:
        """Disable: stop the runtime in the §38 order (the plugin stays up)."""
        # 1-2. stop accepting sessions; cancel any active recording.
        await self.speech.shutdown()
        try:
            await self.client.cancel_recording()
        except SpeechError as exc:
            LOGGER.info("nothing to cancel at disable: %s", exc.code)
        # 3-4. stop status monitor; SIGTERM daemon → bounded wait → SIGKILL.
        await self.monitor.stop()
        await self.supervisor.stop()
        # 5. silence runtime deliveries.
        await self.client.stop()

    async def _startup_runtime(self, settings: Settings) -> None:
        """Enable: (re-)start the runtime along the §82 startup path."""
        self.speech.resume()
        try:
            await self.monitor.start()
        except OSError as exc:
            LOGGER.error("status monitor unavailable: %s", exc)
            await self._publish_runtime_unavailable("status monitor unavailable")
            return
        await self._start_daemon(settings)

    async def _restart_runtime(self, settings: Settings) -> None:
        """§65 sequence: stop → unload old model → start with the new
        settings → health check (daemon status consumption) → ready."""
        try:
            await self.models.ensure_model(settings.model_id)
        except SpeechError as exc:
            LOGGER.error("model unavailable at restart: %s", exc.message)
            await self._publish_runtime_unavailable(exc.message)
            return
        try:
            await self.supervisor.restart(settings)
        except SpeechError as exc:
            LOGGER.error("runtime restart failed: %s (%s)", exc.message, exc.detail)
            await self._publish_runtime_unavailable(exc.message)
            return
        await self.client.start()

    async def start_recording(self, session_id: str) -> dict[str, object]:
        settings = await self.settings_repository.load()
        if not settings.enabled:
            # §36/§64: while dictation is disabled the runtime is absent and
            # no session is accepted; stable §68 code for the frontend.
            raise RuntimeUnavailableError("plugin is disabled by settings")
        if not self.supervisor.is_running():
            raise RuntimeUnavailableError("native runtime is not running")
        # §33 keeps model concerns out of the application service; the
        # facade-level guard surfaces a stable code when the selected model is
        # missing (§90: missing model).
        if not await self.models.store.is_installed(settings.model_id):
            raise ModelNotInstalledError(
                "selected model is not installed", detail=f"id={settings.model_id}"
            )
        await self.speech.start_recording(session_id)
        return {"sessionId": session_id}

    async def stop_recording(self, session_id: str) -> dict[str, object]:
        await self.speech.stop_recording(session_id)
        return {"sessionId": session_id}

    async def cancel_recording(self, session_id: str) -> dict[str, object]:
        await self.speech.cancel_recording(session_id)
        return {"sessionId": session_id}

    async def list_models(self) -> dict[str, object]:
        models = await self.models.list_models()
        return {"protocolVersion": PROTOCOL_VERSION_V1, "models": models}

    async def download_model(self, model_id: str) -> dict[str, object]:
        await self.models.download_model(model_id)
        return {"modelId": model_id}

    async def cancel_model_download(self) -> dict[str, object]:
        cancelled = self.models.cancel_download()
        return {"cancelled": cancelled}

    # ── helpers ──────────────────────────────────────────────────────────────

    async def _publish_runtime_unavailable(self, detail: str) -> None:
        await self.publisher.publish(
            EVENT_RUNTIME_STATUS,
            {
                "protocolVersion": PROTOCOL_VERSION_V1,
                "available": False,
                "state": "unavailable",
                "detail": detail,
            },
        )


def compose(
    *,
    plugin_root: Path,
    data_dir: Path,
    event_publisher: EventPublisher | None = None,
    model_fetcher: ModelHttpFetcher | None = None,
) -> Application:
    """Build the backend object graph (§6). Pure wiring; no I/O effects.

    `event_publisher` is the Decky event transport; when omitted (tests,
    local tooling) events are logged with transcript text redacted (§73).
    `model_fetcher` is overridable so tests never touch the network (§90).
    """
    publisher = event_publisher if event_publisher is not None else LoggingEventPublisher()
    fetcher = model_fetcher if model_fetcher is not None else UrllibModelFetcher()
    paths = PluginPaths(plugin_root=plugin_root, data_dir=data_dir)

    manifest = load_model_manifest(paths.models_manifest)
    settings_repository = JsonSettingsRepository(paths.settings_file)
    setup_progress = SetupProgressReporter(publisher)
    models = ModelService(
        manifest,
        paths.models_dir,
        fetcher,
        publisher,
        setup_progress=setup_progress.download_progress,
    )

    def model_path_for(model_id: str) -> Path:
        """Absolute .bin path of a curated model (§48/§51/§109).

        The daemon config points at OUR downloaded model file so downloads
        and checksums stay under ModelStore control; ids validate against
        the loaded manifest exactly like the store (no traversal).
        """
        info = manifest.by_id(model_id)
        if info is None:
            raise ModelNotInstalledError("unknown model id", detail=f"id={model_id!r}")
        return paths.models_dir / info.filename

    resolver = RuntimeVariantResolver(paths)
    watcher = StatusFileWatcher(paths.native_runtime_dir)
    client = VoxtypeClient(paths, resolver)
    settings_provider: Callable[[], Awaitable[Settings]] = settings_repository.load
    speech = SpeechApplicationService(
        client,
        SpeechSessionCoordinator(),
        publisher,
        settings_provider,
    )
    client.transcript_sink = speech

    supervisor = SpeechDaemonSupervisor(
        paths,
        publisher,
        resolver,
        model_path_for=model_path_for,
        on_unexpected_exit=speech.notify_runtime_lost,
        is_idle=lambda: not speech.has_pending_work(),
    )
    monitor = RuntimeStatusMonitor(watcher, publisher)

    return Application(
        paths=paths,
        publisher=publisher,
        settings=settings_repository,
        models=models,
        speech=speech,
        supervisor=supervisor,
        monitor=monitor,
        client=client,
        watcher=watcher,
        manifest=manifest,
        resolver=resolver,
        setup_progress=setup_progress,
    )

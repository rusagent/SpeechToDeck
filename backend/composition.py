"""Composition root (spec §5, §6): construct and wire everything; no globals.

`compose()` builds the object graph once; `Application` owns the runtime
lifecycle (§82 startup, §38/§83 disposal) and exposes the §30 backend
operations that `main.py` delegates to. No dependency is instantiated inside
application-domain classes.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable
from pathlib import Path

from backend.application.model_service import ModelService
from backend.application.speech_service import SpeechApplicationService
from backend.domain.contracts import (
    EVENT_RUNTIME_STATUS,
    PROTOCOL_VERSION_V1,
    EventPublisher,
    Settings,
)
from backend.domain.errors import (
    ModelNotInstalledError,
    RuntimeUnavailableError,
    SettingsInvalidError,
    SpeechError,
)
from backend.domain.session import SpeechSessionCoordinator
from backend.infrastructure.model.model_manifest import ModelManifest, load_model_manifest
from backend.infrastructure.model.model_store import AiohttpModelFetcher, ModelHttpFetcher
from backend.infrastructure.process.daemon_supervisor import SpeechDaemonSupervisor
from backend.infrastructure.process.process_environment import (
    PluginPaths,
    ensure_directories,
)
from backend.infrastructure.process.status_monitor import (
    RuntimeStatusMonitor,
    StatusFileWatcher,
)
from backend.infrastructure.process.voxtype_client import VoxtypeClient
from backend.infrastructure.settings.json_settings_repository import (
    JsonSettingsRepository,
    settings_from_payload,
)

LOGGER = logging.getLogger("plugin.lifecycle")


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
        self._started = False
        self._disposed = False

    # ── lifecycle (§82 startup, §38/§83 disposal) ────────────────────────────

    async def start(self) -> None:
        """Load settings, start status consumption, then the daemon (§82).

        A daemon start failure is surfaced (`runtime_status` unavailable) but
        never crashes the plugin: recovery is the explicit restart action
        (§69). Settings/models callables keep working.
        """
        if self._started:
            return
        self._started = True
        ensure_directories(self.paths)
        settings = await self.settings_repository.load()
        try:
            await self.monitor.start()
        except OSError as exc:
            # §41 requires event-driven status consumption; without it the
            # runtime cannot be supervised safely → fail closed, but keep the
            # settings/models surface usable.
            LOGGER.error("status monitor unavailable: %s", exc)
            await self._publish_runtime_unavailable("status monitor unavailable")
            return

        if not settings.enabled:
            LOGGER.info("plugin disabled by settings; runtime not started")
            return

        # §82/§36: the model is loaded once at startup by the persistent
        # daemon. A missing or corrupt model keeps the daemon down (§51/§53).
        try:
            await self.models.ensure_model(settings.model_id)
        except SpeechError as exc:
            LOGGER.error("model unavailable at startup: %s", exc.message)
            await self._publish_runtime_unavailable(exc.message)
            return

        try:
            await self.supervisor.start(settings)
        except SpeechError as exc:
            LOGGER.error("runtime start failed: %s (%s)", exc.message, exc.detail)
            await self._publish_runtime_unavailable(exc.message)
            return
        # §32 SpeechRuntime.start: initialize the runtime surface (status
        # watch). The daemon itself is up; recording can begin.
        await self.client.start()

    async def dispose(self) -> None:
        """§38/§83 disposal order; every step idempotent."""
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
        - Vulkan is only claimed when the daemon itself reported it.
        """
        settings = await self.settings_repository.load()
        running = self.supervisor.is_running()
        snapshot = self.watcher.last_snapshot
        return {
            "protocolVersion": PROTOCOL_VERSION_V1,
            "speechRuntimeAvailable": running,
            "microphoneAvailable": running,
            "cpuAvailable": True,
            "vulkanAvailable": snapshot is not None and snapshot.backend == "vulkan",
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
        """Merge a partial wire payload and persist atomically (§55)."""
        current = await self.settings_repository.load()
        merged = current.to_payload()
        for key, value in update.items():
            if key == "schemaVersion":
                # §55: the version is backend-owned; clients never set it.
                raise SettingsInvalidError("schemaVersion is managed by the backend")
            merged[key] = value
        validated = settings_from_payload(merged)
        await self.settings_repository.save(validated)
        return validated.to_payload()

    async def start_recording(self, session_id: str) -> dict[str, object]:
        settings = await self.settings_repository.load()
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
    fetcher = model_fetcher if model_fetcher is not None else AiohttpModelFetcher()
    paths = PluginPaths(plugin_root=plugin_root, data_dir=data_dir)

    manifest = load_model_manifest(paths.models_manifest)
    settings_repository = JsonSettingsRepository(paths.settings_file)
    models = ModelService(manifest, paths.models_dir, fetcher, publisher)

    watcher = StatusFileWatcher(paths.runtime_dir)
    client = VoxtypeClient(paths, watcher)
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
    )

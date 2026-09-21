from __future__ import annotations

import asyncio
import json
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
    ClipboardWriter,
    EventPublisher,
    Settings,
)
from backend.domain.errors import (
    ModelNotInstalledError,
    RuntimeStartError,
    RuntimeUnavailableError,
    SettingsInvalidError,
    SpeechError,
    TransientModelDownloadError,
)
from backend.domain.session import SpeechSessionCoordinator
from backend.infrastructure.clipboard.xclip_writer import XclipClipboardWriter
from backend.infrastructure.model.model_manifest import ModelManifest, load_model_manifest
from backend.infrastructure.model.model_store import ModelHttpFetcher, UrllibModelFetcher
from backend.infrastructure.process.daemon_supervisor import SpeechDaemonSupervisor
from backend.infrastructure.process.level_socket_client import LevelSocketClient
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

MODEL_WARMUP_TIMEOUT_S = 60.0

_RUNTIME_FIELDS = (
    "model_id",
    "compute_backend",
    "language",
)

MODEL_DOWNLOAD_RETRY_DELAYS_S = (2.0, 5.0)


def _runtime_relevant_change(before: Settings, after: Settings) -> bool:
    return any(getattr(before, field) != getattr(after, field) for field in _RUNTIME_FIELDS)


def read_backend_version(plugin_root: Path) -> str | None:

    try:
        payload = json.loads((plugin_root / "package.json").read_text(encoding="utf-8"))
        version = payload["version"]
    except (OSError, ValueError, KeyError, TypeError):
        return None
    return version if isinstance(version, str) and version else None


def _daemon_idle(event: WatchEvent) -> bool:
    snapshot = event.snapshot
    return event.kind == "status" and snapshot is not None and snapshot.state == "idle"


class LoggingEventPublisher:
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
        level_client: LevelSocketClient,
        clipboard_writer: ClipboardWriter | None = None,
        backend_version: str | None = None,
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
        self.level_client = level_client
        self.clipboard_writer = clipboard_writer
        self._backend_version = backend_version
        self._started = False
        self._disposed = False
        self._last_setup_failure: dict[str, object] | None = None
        self._lifecycle_lock = asyncio.Lock()

    async def start(self) -> None:

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
                LOGGER.error("status monitor unavailable: %s", exc)
                await self._publish_runtime_unavailable("status monitor unavailable")
                return

            if not settings.enabled:
                LOGGER.info("plugin disabled by settings; runtime not started")
                return

            await self._start_daemon(settings)

    async def _start_daemon(self, settings: Settings) -> None:

        setup = self.setup_progress
        await setup.begin_run()
        await setup.step(0, percent=0, detail_key=DETAIL_CHECKSUM)
        try:
            await self.supervisor.verify(settings)
        except SpeechError as exc:
            LOGGER.error("runtime verification failed: %s (%s)", exc.message, exc.detail)
            await self._fail_startup(setup, exc)
            return
        await setup.step(0, percent=100)

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
                await self._download_model_with_retry(setup, settings.model_id)
        except SpeechError as exc:
            LOGGER.error("model unavailable at startup: %s (%s)", exc.message, exc.detail)
            await self._fail_startup(setup, exc)
            return
        await setup.step(1, percent=100)

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
        await self.client.start()

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
        self._last_setup_failure = None
        await setup.ready()

    async def _download_model_with_retry(self, setup: SetupProgressReporter, model_id: str) -> None:

        retries = len(MODEL_DOWNLOAD_RETRY_DELAYS_S)
        for attempt in range(1, retries + 2):
            try:
                await self.models.download_model(model_id)
                return
            except SpeechError as exc:
                if not isinstance(exc, TransientModelDownloadError) or attempt > retries:
                    raise
                delay = MODEL_DOWNLOAD_RETRY_DELAYS_S[attempt - 1]
                LOGGER.warning(
                    "transient model download failure (attempt %d/%d): %s (%s); retrying in %gs",
                    attempt,
                    retries + 1,
                    exc.message,
                    exc.detail,
                    delay,
                )
                await setup.step(1, percent=0, detail_key=DETAIL_DOWNLOADING)
                await asyncio.sleep(delay)

    async def _fail_startup(self, setup: SetupProgressReporter, exc: SpeechError) -> None:
        self._last_setup_failure = {"code": str(exc.code), "stepIndex": setup.failing_step_index}
        await setup.fail(str(exc.code))
        await self._publish_runtime_unavailable(exc.message)

    async def dispose(self) -> None:

        if self._disposed:
            return
        async with self._lifecycle_lock:
            if self._disposed:
                return
            self._disposed = True
            await self.speech.shutdown()
            await self._stop_level_stream()
            try:
                await self.client.cancel_recording()
            except SpeechError as exc:
                LOGGER.info("nothing to cancel at dispose: %s", exc.code)
            await self.monitor.stop()
            await self.supervisor.stop()
            await self.client.stop()
            self.watcher.close()
            self.paths.output_file.unlink(missing_ok=True)
            self._started = False

    async def restart_runtime(self) -> None:

        async with self._lifecycle_lock:
            if self._disposed:
                return
            settings = await self.settings_repository.load()
            if not settings.enabled:
                raise RuntimeUnavailableError("plugin is disabled by settings")
            await self._shutdown_runtime()
            await self._startup_runtime(settings)

    async def migrate_settings(self) -> Settings:
        settings = await self.settings_repository.load()
        await self.settings_repository.save(settings)
        return settings

    async def get_capabilities(self) -> dict[str, object]:

        settings = await self.settings_repository.load()
        running = self.supervisor.is_running()
        capabilities: dict[str, object] = {
            "protocolVersion": PROTOCOL_VERSION_V1,
            "speechRuntimeAvailable": running,
            "microphoneAvailable": running,
            "cpuAvailable": True,
            "vulkanAvailable": self.resolver.selected_backend == "vulkan",
            "modelInstalled": await self.models.store.is_installed(settings.model_id),
            "computeBackend": settings.compute_backend,
            "modelId": settings.model_id,
            "language": settings.language,
        }
        if self._backend_version is not None:
            capabilities["backendVersion"] = self._backend_version
        return capabilities

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
                "lastFailure": self._last_setup_failure,
            },
            "speech": self.speech.get_status(),
            "modelDownloadInProgress": self.models.download_in_progress(),
            "dictationFlow": {
                "clipboard": (
                    "xclip"
                    if self.clipboard_writer is not None and self.clipboard_writer.is_available()
                    else "unavailable"
                )
            },
        }

    async def get_settings(self) -> dict[str, object]:
        settings = await self.settings_repository.load()
        return settings.to_payload()

    async def update_settings(self, update: dict[str, object]) -> dict[str, object]:

        async with self._lifecycle_lock:
            current = await self.settings_repository.load()
            merged = current.to_payload()
            for key, value in update.items():
                if key == "schemaVersion":
                    raise SettingsInvalidError("schemaVersion is managed by the backend")
                merged[key] = value
            validated = settings_from_payload(merged)
            await self.settings_repository.save(validated)
            await self._apply_runtime_lifecycle(current, validated)
            return validated.to_payload()

    async def _apply_runtime_lifecycle(self, before: Settings, after: Settings) -> None:

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

    async def _shutdown_runtime(self) -> None:
        await self.speech.shutdown()
        await self._stop_level_stream()
        try:
            await self.client.cancel_recording()
        except SpeechError as exc:
            LOGGER.info("nothing to cancel at disable: %s", exc.code)
        await self.monitor.stop()
        await self.supervisor.stop()
        await self.client.stop()

    async def _startup_runtime(self, settings: Settings) -> None:
        self.speech.resume()
        try:
            await self.monitor.start()
        except OSError as exc:
            LOGGER.error("status monitor unavailable: %s", exc)
            await self._publish_runtime_unavailable("status monitor unavailable")
            return
        await self._start_daemon(settings)

    async def _restart_runtime(self, settings: Settings) -> None:
        try:
            await self.models.ensure_model(settings.model_id)
        except SpeechError as exc:
            LOGGER.error("model unavailable at restart: %s (%s)", exc.message, exc.detail)
            await self._publish_runtime_unavailable(exc.message)
            return
        try:
            await self.supervisor.restart(settings)
        except SpeechError as exc:
            LOGGER.error("runtime restart failed: %s (%s)", exc.message, exc.detail)
            await self._publish_runtime_unavailable(exc.message)
            return
        await self.client.start()
        self._last_setup_failure = None

    async def start_recording(self, session_id: str) -> dict[str, object]:
        settings = await self.settings_repository.load()
        if not settings.enabled:
            raise RuntimeUnavailableError("plugin is disabled by settings")
        if not self.supervisor.is_running():
            raise RuntimeUnavailableError("native runtime is not running")
        if not await self.models.store.is_installed(settings.model_id):
            raise ModelNotInstalledError(
                "selected model is not installed", detail=f"id={settings.model_id}"
            )
        await self.speech.start_recording(session_id)
        await self._start_level_stream()
        return {"sessionId": session_id}

    async def stop_recording(self, session_id: str) -> dict[str, object]:
        try:
            await self.speech.stop_recording(session_id)
        finally:
            await self._stop_level_stream()
        return {"sessionId": session_id}

    async def cancel_recording(self, session_id: str) -> dict[str, object]:
        try:
            await self.speech.cancel_recording(session_id)
        finally:
            await self._stop_level_stream()
        return {"sessionId": session_id}

    async def _start_level_stream(self) -> None:

        try:
            await self.level_client.start()
        except Exception as exc:
            LOGGER.info("audio-level stream start failed: %s", type(exc).__name__)

    async def _stop_level_stream(self) -> None:
        try:
            await self.level_client.stop()
        except Exception as exc:
            LOGGER.info("audio-level stream stop failed: %s", type(exc).__name__)

    async def list_models(self) -> dict[str, object]:
        models = await self.models.list_models()
        return {"protocolVersion": PROTOCOL_VERSION_V1, "models": models}

    async def download_model(self, model_id: str) -> dict[str, object]:
        await self.models.download_model(model_id)
        return {"modelId": model_id}

    async def cancel_model_download(self) -> dict[str, object]:
        cancelled = self.models.cancel_download()
        return {"cancelled": cancelled}

    async def delete_model(self, model_id: str) -> dict[str, object]:

        settings = await self.settings_repository.load()
        if settings.model_id == model_id:
            raise SettingsInvalidError("cannot delete the selected model", detail=f"id={model_id}")
        return await self.models.delete_model(model_id)

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

        info = manifest.by_id(model_id)
        if info is None:
            raise ModelNotInstalledError("unknown model id", detail=f"id={model_id!r}")
        return paths.models_dir / info.filename

    resolver = RuntimeVariantResolver(paths)
    watcher = StatusFileWatcher(paths.native_runtime_dir)
    client = VoxtypeClient(paths, resolver)
    settings_provider: Callable[[], Awaitable[Settings]] = settings_repository.load
    clipboard_writer = XclipClipboardWriter(paths.bin_dir / "xclip", staging_dir=paths.runtime_dir)
    speech = SpeechApplicationService(
        client,
        SpeechSessionCoordinator(),
        publisher,
        settings_provider,
        clipboard_writer=clipboard_writer,
    )
    client.transcript_sink = speech
    level_client = LevelSocketClient(paths.audio_socket, publisher)

    async def on_runtime_lost(exit_code: int | None) -> None:
        await speech.notify_runtime_lost(exit_code)
        await level_client.stop()

    supervisor = SpeechDaemonSupervisor(
        paths,
        publisher,
        resolver,
        model_path_for=model_path_for,
        model_info_for=manifest.by_id,
        on_unexpected_exit=on_runtime_lost,
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
        level_client=level_client,
        clipboard_writer=clipboard_writer,
        backend_version=read_backend_version(plugin_root),
    )

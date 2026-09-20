"""Composition root: construct and wire everything; no globals.

`compose()` builds the object graph once; `Application` owns the runtime
lifecycle (startup, settings transitions, disposal) and exposes the backend
callables that `main.py` delegates to. No dependency is instantiated inside
application-domain classes.
"""

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
from backend.infrastructure.process.cdp_client import CdpClient
from backend.infrastructure.process.cdp_diagnostics import CdpDiagnostics
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

# model.warmup budget (no wait is unbounded): long enough to span
# the restart ladder (bounded delays ≤ 8 s + spawns) so a daemon brought
# back by the restart policy can still report idle, short enough to fail
# closed with a stable code instead of hanging the startup path.
MODEL_WARMUP_TIMEOUT_S = 60.0

# Settings the native daemon consumes at start (see
# SpeechDaemonSupervisor._spawn). While the daemon is up, a change to any of
# them requires a supervised restart for the new value to take effect.
# max_recording_seconds/vad_enabled left the settings document; the
# daemon receives fixed constants, so they no longer drive restarts.
_RUNTIME_FIELDS = (
    "model_id",
    "compute_backend",
    "language",
)

# Last-resort cdpDiagnostics report before the first bounded probe completed
# (never assume availability; the frontend guard renders "unknown").
CDP_REPORT_NOT_PROBED: dict[str, object] = {
    "cdpAvailable": False,
    "spTargetSeen": False,
    "keyboardSeen": False,
    "keyboardVisible": False,
    "reason": "not-probed",
}

# Startup download resilience (on-device finding: one transient network
# error killed startup permanently): bounded automatic retries for the
# transient transport class only (URLError/timeout/connection reset — never
# checksum mismatch, cancellation, HTTP status failures or unknown ids,
# which fail immediately). Bounded ladder: 2 automatic retries
# with a 2 s then 5 s backoff.
MODEL_DOWNLOAD_RETRY_DELAYS_S = (2.0, 5.0)


def _runtime_relevant_change(before: Settings, after: Settings) -> bool:
    return any(getattr(before, field) != getattr(after, field) for field in _RUNTIME_FIELDS)


def read_backend_version(plugin_root: Path) -> str | None:
    """Plugin version from the loader-installed package.json (additive
    diagnostics field, read once at composition).

    Fail-soft by design: a missing, unreadable or malformed package.json — or
    a missing/empty/non-string version — omits the field instead of failing
    composition; the frontend guard ignores the field when absent.
    """
    try:
        payload = json.loads((plugin_root / "package.json").read_text(encoding="utf-8"))
        version = payload["version"]
    except (OSError, ValueError, KeyError, TypeError):
        return None
    return version if isinstance(version, str) and version else None


def _daemon_idle(event: WatchEvent) -> bool:
    """Warmup predicate: the daemon state file reports idle."""
    snapshot = event.snapshot
    return event.kind == "status" and snapshot is not None and snapshot.state == "idle"


class LoggingEventPublisher:
    """EventPublisher used when no Decky event transport is wired.

    Deliberate and visible: without a transport, events are logged (with
    transcript text redacted) instead of being silently dropped.
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
    """Composed backend: owns lifecycle and the backend callables."""

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
        cdp_diagnostics: CdpDiagnostics | None = None,
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
        # Optional cross-view diagnostics: read-only CDP probe behind
        # the user's "Allow Remote CEF Debugging" toggle. Never functional
        # surface — unavailability degrades into the get_status report.
        self.cdp_diagnostics = cdp_diagnostics
        # Additive presentation surface: the audio.sock level
        # stream runs ONLY while a recording session is active and is fully
        # contained — it can never affect the dictation flow.
        self.level_client = level_client
        # Additive best-effort clipboard leg; None keeps the legacy
        # behavior (transcript_ready reports "skipped").
        self.clipboard_writer = clipboard_writer
        # Additive diagnostics fact: the plugin version, read once from
        # package.json at composition (read_backend_version). None omits the
        # field from the capability report.
        self._backend_version = backend_version
        self._cdp_report: dict[str, object] = dict(CDP_REPORT_NOT_PROBED)
        self._cdp_task: asyncio.Task[None] | None = None
        self._started = False
        self._disposed = False
        # Last startup failure for the `get_status` report: stable error
        # code plus the failing step index, cleared by any successful startup
        # path. The frontend setup panel hydrates from it when the terminal
        # `failed` event fired before the panel subscribed (no
        # transcript or audio content).
        self._last_setup_failure: dict[str, object] | None = None
        # Serializes every lifecycle transition (startup, settings
        # transitions, disposal): concurrent updates coalesce into
        # one ordered sequence, never restart in parallel, and a disable
        # during startup or an update during unload cannot leave a daemon
        # that contradicts the disposed/disabled state.
        self._lifecycle_lock = asyncio.Lock()

    # ── lifecycle (startup, settings transitions, disposal) ──────────────────

    async def start(self) -> None:
        """Load settings, start status consumption, then the daemon.

        A daemon start failure is surfaced (`runtime_status` unavailable) but
        never crashes the plugin: recovery is the explicit restart action.
        Settings/models callables keep working.
        """
        if self._started:
            return
        async with self._lifecycle_lock:
            if self._started or self._disposed:
                return
            self._started = True
            ensure_directories(self.paths)
            settings = await self.settings_repository.load()
            self._schedule_cdp_probe()
            try:
                await self.monitor.start()
            except OSError as exc:
                # Event-driven status consumption is required; without it the
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
        """Startup tail: verify the runtime, ensure the model, start the
        supervised daemon, wait for warmup — emitting the `setup_progress`
        stream along the way (frozen contract: backend/application/
        setup_progress.py).

        A failure at any step is surfaced (the terminal `failed` setup event
        plus `runtime_status` unavailable) but never crashes the plugin: the
        runtime stays in the existing fail-closed down state, recovery
        is the explicit restart action. Settings/models callables keep
        working.
        """
        setup = self.setup_progress
        await setup.begin_run()
        # Step 0 — runtime.verify: pinned binary presence + digest.
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
        # (the cancel path stays live during startup). Transient
        # transport failures get the bounded automatic retry ladder.
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
                # installs atomically, so no second ensure is needed.
                await self._download_model_with_retry(setup, settings.model_id)
        except SpeechError as exc:
            # Diagnosability: the detail carries the reason class + HTTP
            # status/errno + host, not just the generic message.
            LOGGER.error("model unavailable at startup: %s (%s)", exc.message, exc.detail)
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
        # SpeechRuntime.start: initialize the runtime surface (status
        # watch) so warmup is observed through the live monitor path.
        await self.client.start()

        # Step 3 — model.warmup: bounded wait for the daemon state file to
        # report idle through the status watcher.
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
        """Model-ensure download with the bounded automatic retry ladder.

        Only the transient transport class (URLError/timeout/connection
        reset) is retried — `MODEL_DOWNLOAD_RETRY_DELAYS_S` attempts with
        backoff; checksum mismatch, cancellation, HTTP status failures and
        unknown ids fail immediately. Every retry re-emits the model.ensure
        step from percent 0 (frozen payload shape, existing detail key).
        """
        retries = len(MODEL_DOWNLOAD_RETRY_DELAYS_S)
        for attempt in range(1, retries + 2):  # 1 initial + `retries` retries
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
                # Fresh attempt signal: model.ensure from percent 0 (frozen
                # payload shape; existing detail key), emitted before the
                # bounded backoff wait.
                await setup.step(1, percent=0, detail_key=DETAIL_DOWNLOADING)
                await asyncio.sleep(delay)

    async def _fail_startup(self, setup: SetupProgressReporter, exc: SpeechError) -> None:
        """Terminal `failed` setup event + the existing fail-closed surface."""
        # Stored for the `get_status` report so the frontend setup panel
        # can reconstruct the failure after the fact (hydration).
        self._last_setup_failure = {"code": str(exc.code), "stepIndex": setup.failing_step_index}
        await setup.fail(str(exc.code))
        await self._publish_runtime_unavailable(exc.message)

    # ── optional CDP diagnostics (read-only, fully contained) ────────────────

    def _schedule_cdp_probe(self) -> None:
        """One bounded probe run in the background; results surface in
        `get_status`. Failure can never affect functional surface."""
        if self.cdp_diagnostics is None or self._disposed:
            return
        if self._cdp_task is not None and not self._cdp_task.done():
            return
        self._cdp_task = asyncio.create_task(self._run_cdp_probe(), name="cdp-diagnostics")

    async def _run_cdp_probe(self) -> None:
        assert self.cdp_diagnostics is not None
        try:
            self._cdp_report = await self.cdp_diagnostics.probe()
        except asyncio.CancelledError:
            raise
        except Exception as exc:
            LOGGER.info("cdp diagnostics probe crashed: %s", type(exc).__name__)
            self._cdp_report = {**CDP_REPORT_NOT_PROBED, "reason": "probe-failed"}

    async def dispose(self) -> None:
        """Disposal order; every step idempotent.

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
            if self._cdp_task is not None and not self._cdp_task.done():
                self._cdp_task.cancel()
            # 1-2. stop accepting sessions; cancel any active recording.
            await self.speech.shutdown()
            await self._stop_level_stream()
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
            # 6. transient transcript file removed on clean shutdown.
            self.paths.output_file.unlink(missing_ok=True)
            self._started = False

    async def restart_runtime(self) -> None:
        """Fatal runtime errors recover only via explicit restart.

        Re-runs the full startup path — runtime verify → model
        ensure/download → daemon start → warmup, with the `setup_progress`
        stream — so recovery after a failed startup is identical to a fresh
        start. The existing runtime (if any) is torn down in the stop order
        first, then `_startup_runtime` drives the sequence. Runs under the
        lifecycle lock like every other lifecycle transition; a failure is
        fail-closed surfaced through the setup/runtime events, never fatal.
        """
        async with self._lifecycle_lock:
            if self._disposed:
                return
            settings = await self.settings_repository.load()
            if not settings.enabled:
                raise RuntimeUnavailableError("plugin is disabled by settings")
            await self._shutdown_runtime()
            await self._startup_runtime(settings)
            # Fresh cross-view facts after an explicit restart action.
            self._schedule_cdp_probe()

    async def migrate_settings(self) -> Settings:
        """Plugin migration hook: run the settings migration chain forward once."""
        settings = await self.settings_repository.load()
        await self.settings_repository.save(settings)
        return settings

    # ── backend callables ────────────────────────────────────────────────────

    async def get_capabilities(self) -> dict[str, object]:
        """Speech-side capability half (the frontend probes the Steam side).

        The microphone and compute-backend probes live inside the native
        daemon (hardware-gated); until a live daemon reports,
        this report stays conservative (no optimistic assumption):

        - the running daemon owns the microphone; per-recording failures
          surface as the ``MICROPHONE_UNAVAILABLE`` code, so microphone
          availability is reported as the runtime's availability;
        - the CPU backend is the pinned runtime's baseline compute path on the
          supported platform, so it is always reported available;
        - Vulkan is only claimed when the resolved runtime variant is the
          vulkan binary.
        """
        settings = await self.settings_repository.load()
        running = self.supervisor.is_running()
        capabilities: dict[str, object] = {
            "protocolVersion": PROTOCOL_VERSION_V1,
            "speechRuntimeAvailable": running,
            "microphoneAvailable": running,
            "cpuAvailable": True,
            "vulkanAvailable": self.resolver.selected_backend == "vulkan",
            "modelInstalled": await self.models.store.is_installed(settings.model_id),
            # Context for diagnostics; the frontend guard ignores extra fields.
            "computeBackend": settings.compute_backend,
            "modelId": settings.model_id,
            "language": settings.language,
        }
        # Additive diagnostics fact: the plugin version for the
        # panel's backend row. Omitted when package.json carried no version.
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
                # Hydration record for the frontend setup panel: the stored
                # last startup failure (error code + failing step) or None.
                "lastFailure": self._last_setup_failure,
            },
            "speech": self.speech.get_status(),
            "modelDownloadInProgress": self.models.download_in_progress(),
            # Optional cross-view diagnostics (additive field):
            # read-only facts behind the user's CEF-debugging toggle. The
            # frontend guard ignores the field when an older backend omits it.
            "cdpDiagnostics": dict(self._cdp_report),
            # Additive dictation-flow facts (optional field) for the
            # panel's diagnostics row: the backend clipboard leg reports its
            # writer availability; "unavailable" means the frontend
            # execCommand copy is the primary clipboard path.
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
        """Merge a partial wire payload, persist atomically, then drive
        the runtime lifecycle.

        One lock spans read-modify-write and the lifecycle transition, and is
        shared with `start()`/`dispose()`: startup, settings transitions and
        disposal are strictly ordered, so a disable arriving during startup
        still ends with the daemon down and an update arriving
        during unload never respawns the daemon after `dispose()`.
        Concurrent updates are applied in order and never restart in
        parallel (storm guard). Lifecycle failures are surfaced as
        `runtime_status` events, never as call failures: the settings
        document itself was valid and persisted.
        """
        async with self._lifecycle_lock:
            current = await self.settings_repository.load()
            merged = current.to_payload()
            for key, value in update.items():
                if key == "schemaVersion":
                    # schemaVersion is owned by the backend; clients never set it.
                    raise SettingsInvalidError("schemaVersion is managed by the backend")
                merged[key] = value
            validated = settings_from_payload(merged)
            await self.settings_repository.save(validated)
            await self._apply_runtime_lifecycle(current, validated)
            return validated.to_payload()

    async def _apply_runtime_lifecycle(self, before: Settings, after: Settings) -> None:
        """Lifecycle rule: the daemon lives exactly while dictation is enabled
        and its start configuration is current; it is absent while disabled.

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
        # the runtime stays unavailable until an explicit restart, and
        # the next start picks up the persisted settings.

    async def _shutdown_runtime(self) -> None:
        """Disable: stop the runtime in the stop order (the plugin stays up)."""
        # 1-2. stop accepting sessions; cancel any active recording.
        await self.speech.shutdown()
        await self._stop_level_stream()
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
        """Enable: (re-)start the runtime along the startup path."""
        self.speech.resume()
        try:
            await self.monitor.start()
        except OSError as exc:
            LOGGER.error("status monitor unavailable: %s", exc)
            await self._publish_runtime_unavailable("status monitor unavailable")
            return
        await self._start_daemon(settings)

    async def _restart_runtime(self, settings: Settings) -> None:
        """Restart sequence: stop → unload old model → start with the new
        settings → health check (daemon status consumption) → ready."""
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
        # A successful settings-driven restart proves the runtime healthy:
        # the stored startup failure record must not outlive it.
        self._last_setup_failure = None

    async def start_recording(self, session_id: str) -> dict[str, object]:
        settings = await self.settings_repository.load()
        if not settings.enabled:
            # While dictation is disabled the runtime is absent and
            # no session is accepted; stable error code for the frontend.
            raise RuntimeUnavailableError("plugin is disabled by settings")
        if not self.supervisor.is_running():
            raise RuntimeUnavailableError("native runtime is not running")
        # Model concerns stay out of the application service; the
        # facade-level guard surfaces a stable code when the selected model is
        # missing.
        if not await self.models.store.is_installed(settings.model_id):
            raise ModelNotInstalledError(
                "selected model is not installed", detail=f"id={settings.model_id}"
            )
        await self.speech.start_recording(session_id)
        # The audio.sock stream runs only while a recording session
        # is active. Contained: a stream failure never fails the start.
        await self._start_level_stream()
        return {"sessionId": session_id}

    async def stop_recording(self, session_id: str) -> dict[str, object]:
        try:
            await self.speech.stop_recording(session_id)
        finally:
            # The session ends with the stop outcome; the stream stops
            # even when the stop failed.
            await self._stop_level_stream()
        return {"sessionId": session_id}

    async def cancel_recording(self, session_id: str) -> dict[str, object]:
        try:
            await self.speech.cancel_recording(session_id)
        finally:
            await self._stop_level_stream()
        return {"sessionId": session_id}

    # ── audio-level stream gate ──────────────────────────────────────────────

    async def _start_level_stream(self) -> None:
        """Start the audio.sock stream after an acknowledged recording start.

        Fully contained: the visualization is additive surface, so any start
        failure is logged and the recording result is untouched.
        """
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
        """Delete one installed model file (in-app model cleanup, owner request).

        Active-model protection: the selected model is never deletable — the
        settings document keeps referencing it and the runtime needs it. The
        guard reads the persisted settings HERE, in the Application: this class
        owns the settings seam (same split as the `start_recording` model
        guard), while ModelService stays settings-free. The rejection carries
        the stable SETTINGS_INVALID code. A successful delete never writes
        settings: the selected model cannot be the deleted one, so `model_id`
        always remains a valid reference.
        """
        settings = await self.settings_repository.load()
        if settings.model_id == model_id:
            raise SettingsInvalidError("cannot delete the selected model", detail=f"id={model_id}")
        return await self.models.delete_model(model_id)

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
    """Build the backend object graph. Pure wiring; no I/O effects.

    `event_publisher` is the Decky event transport; when omitted (tests,
    local tooling) events are logged with transcript text redacted.
    `model_fetcher` is overridable so tests never touch the network.
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
        """Absolute .bin path of a curated model.

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
    # Clipboard leg: the loader-placed bin/xclip (remote_binary pin or
    # manual install). The pin was skipped — no trustworthy pinned upstream
    # binary — so the writer
    # reports "skipped" until the binary exists and the frontend execCommand
    # copy is the primary clipboard path meanwhile.
    clipboard_writer = XclipClipboardWriter(paths.bin_dir / "xclip", staging_dir=paths.runtime_dir)
    speech = SpeechApplicationService(
        client,
        SpeechSessionCoordinator(),
        publisher,
        settings_provider,
        clipboard_writer=clipboard_writer,
    )
    client.transcript_sink = speech
    # Live level stream: additive presentation events while a recording
    # session is active; fully contained.
    level_client = LevelSocketClient(paths.audio_socket, publisher)

    async def on_runtime_lost(exit_code: int | None) -> None:
        """Daemon loss ends any recording session — and its level stream."""
        await speech.notify_runtime_lost(exit_code)
        await level_client.stop()

    supervisor = SpeechDaemonSupervisor(
        paths,
        publisher,
        resolver,
        model_path_for=model_path_for,
        # Effective-language derivation: the config build resolves
        # the selected model's manifest info (declared languages) from the
        # loaded catalog.
        model_info_for=manifest.by_id,
        on_unexpected_exit=on_runtime_lost,
        is_idle=lambda: not speech.has_pending_work(),
    )
    monitor = RuntimeStatusMonitor(watcher, publisher)

    # Optional cross-view diagnostics transport: stdlib CDP client
    # over the user-controlled "Allow Remote CEF Debugging" endpoint. The
    # production keyboard mount never depends on it.
    cdp_diagnostics = CdpDiagnostics(CdpClient())

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
        cdp_diagnostics=cdp_diagnostics,
        backend_version=read_backend_version(plugin_root),
    )

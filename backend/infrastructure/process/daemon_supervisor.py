from __future__ import annotations

import asyncio
import contextlib
import json
import logging
import os
import signal
import sys
import time
from collections.abc import Callable
from pathlib import Path
from types import ModuleType

try:
    import ctypes as _ctypes

    ctypes: ModuleType | None = _ctypes
except ImportError:
    ctypes = None

from backend.domain.contracts import (
    DEFAULT_MAX_RECORDING_SECONDS,
    EVENT_RUNTIME_STATUS,
    PROTOCOL_VERSION_V1,
    EventPublisher,
    ModelInfo,
    Settings,
)
from backend.domain.errors import RuntimeStartError, SpeechError
from backend.infrastructure.process.executable_copy import (
    EXEC_COPY_DIRNAME,
    ensure_executable_copy,
)
from backend.infrastructure.process.process_environment import (
    PluginPaths,
    apply_private_file_mode,
    child_environment,
)
from backend.infrastructure.process.runtime_variant import (
    ResolvedRuntime,
    RuntimeVariantResolver,
    hash_binary,
)

LOGGER = logging.getLogger("speech.runtime")

SHUTDOWN_TIMEOUT_S = 5.0
MAX_RESTART_ATTEMPTS = 3
RESTART_BASE_DELAY_S = 0.5
RESTART_MAX_DELAY_S = 8.0

DAEMON_VAD_ENABLED = False
RESTART_STABILITY_WINDOW_S = 60.0

_LOG_MAX_BYTES = 512 * 1024
_LOG_BACKUPS = 2

PR_SET_PDEATHSIG = 1


def daemon_preexec(parent_pid: int) -> Callable[[], None] | None:

    ctypes_module = ctypes
    if ctypes_module is None or not sys.platform.startswith("linux"):
        return None

    def preexec() -> None:
        libc = ctypes_module.CDLL(None, use_errno=True)
        if libc.prctl(PR_SET_PDEATHSIG, signal.SIGTERM, 0, 0, 0) != 0:
            errno_value = ctypes_module.get_errno()
            raise OSError(errno_value, os.strerror(errno_value))
        if os.getppid() != parent_pid:
            os._exit(1)

    return preexec


ModelPathResolver = Callable[[str], Path]

ModelInfoResolver = Callable[[str], ModelInfo | None]


class DaemonLog:
    def __init__(self, path: Path, *, max_bytes: int = _LOG_MAX_BYTES) -> None:
        self._path = path
        self._max_bytes = max_bytes

    def write_line(self, raw: bytes) -> None:
        text = raw.decode("utf-8", errors="replace").rstrip()
        if not text:
            return
        try:
            if self._path.exists() and self._path.stat().st_size + len(text) > self._max_bytes:
                self._rotate()
            self._path.parent.mkdir(parents=True, exist_ok=True)
            with self._path.open("a", encoding="utf-8") as handle:
                handle.write(text + "\n")
        except OSError:
            LOGGER.debug("daemon log write failed", exc_info=True)

    def _rotate(self) -> None:
        oldest = self._path.with_name(self._path.name + f".{_LOG_BACKUPS}")
        oldest.unlink(missing_ok=True)
        for index in range(_LOG_BACKUPS - 1, 0, -1):
            source = self._path.with_name(self._path.name + f".{index}")
            if source.exists():
                source.rename(self._path.with_name(self._path.name + f".{index + 1}"))
        self._path.rename(self._path.with_name(self._path.name + ".1"))


def _toml_string(value: str) -> str:
    return json.dumps(value)


def _effective_language(settings_language: str, model_info: ModelInfo | None) -> str:

    language = "auto" if settings_language == "system" else settings_language
    if model_info is None:
        return language
    languages = model_info.languages
    if languages is not None and len(languages) == 1:
        return languages[0]
    if not model_info.multilingual:
        return "en"
    return language


def daemon_config_toml(
    settings: Settings,
    *,
    state_file: Path,
    output_file: Path,
    model_path: Path,
    model_info: ModelInfo | None = None,
) -> str:

    language = _effective_language(settings.language, model_info)
    lines = [
        f"engine = {_toml_string('whisper')}",
        f"state_file = {_toml_string(str(state_file))}",
        "",
        "[hotkey]",
        "enabled = false",
        "",
        "[audio]",
        f"max_duration_secs = {DEFAULT_MAX_RECORDING_SECONDS}",
        "",
        "[whisper]",
        f"model = {_toml_string(str(model_path))}",
        f"language = {_toml_string(language)}",
        "on_demand_loading = false",
        "eager_processing = false",
        "",
        "[vad]",
        f"enabled = {'true' if DAEMON_VAD_ENABLED else 'false'}",
        "",
        "[output]",
        f"mode = {_toml_string('file')}",
        f"file_path = {_toml_string(str(output_file))}",
        f"file_mode = {_toml_string('overwrite')}",
        "",
        "[output.notification]",
        "on_recording_start = false",
        "on_recording_stop = false",
        "on_transcription = false",
        "",
        "[osd]",
        "enabled = false",
        "",
    ]
    return "\n".join(lines)


def write_daemon_config(
    paths: PluginPaths,
    settings: Settings,
    model_path: Path,
    *,
    model_info: ModelInfo | None = None,
) -> Path:
    payload = daemon_config_toml(
        settings,
        state_file=paths.status_file,
        output_file=paths.output_file,
        model_path=model_path,
        model_info=model_info,
    )
    config_path = paths.daemon_config
    config_path.parent.mkdir(parents=True, exist_ok=True)
    tmp_path = config_path.with_name(config_path.name + ".tmp")
    try:
        tmp_path.write_text(payload, encoding="utf-8")
        os.replace(tmp_path, config_path)
    except OSError as exc:
        tmp_path.unlink(missing_ok=True)
        raise RuntimeStartError(
            "daemon config could not be written", detail=type(exc).__name__
        ) from exc
    apply_private_file_mode(config_path)
    return config_path


class SpeechDaemonSupervisor:
    def __init__(
        self,
        paths: PluginPaths,
        publisher: EventPublisher,
        resolver: RuntimeVariantResolver,
        *,
        model_path_for: ModelPathResolver,
        model_info_for: ModelInfoResolver | None = None,
        on_unexpected_exit: Callable[[int | None], object] | None = None,
        is_idle: Callable[[], bool] | None = None,
        shutdown_timeout: float = SHUTDOWN_TIMEOUT_S,
        restart_base_delay: float = RESTART_BASE_DELAY_S,
        restart_max_delay: float = RESTART_MAX_DELAY_S,
        max_restart_attempts: int = MAX_RESTART_ATTEMPTS,
        stability_window: float = RESTART_STABILITY_WINDOW_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._paths = paths
        self._publisher = publisher
        self._resolver = resolver
        self._model_path_for = model_path_for
        self._model_info_for = model_info_for
        self._on_unexpected_exit = on_unexpected_exit
        self._is_idle = is_idle or (lambda: True)
        self._shutdown_timeout = shutdown_timeout
        self._restart_base_delay = restart_base_delay
        self._restart_max_delay = restart_max_delay
        self._max_restart_attempts = max_restart_attempts
        self._stability_window = stability_window
        self._clock = clock
        self._proc: asyncio.subprocess.Process | None = None
        self._watch_task: asyncio.Task[None] | None = None
        self._drain_task: asyncio.Task[None] | None = None
        self._verified: tuple[Settings, ResolvedRuntime, Path, Path] | None = None
        self._exec_copy_dir = paths.runtime_dir / EXEC_COPY_DIRNAME
        self._stopping = False
        self._restarts_used = 0
        self._spawned_at = 0.0
        self._settings: Settings | None = None
        self.last_exit_code: int | None = None

    async def verify(self, settings: Settings) -> None:

        self._verified = await self._verify(settings)

    async def start(self, settings: Settings) -> None:

        if self.is_running():
            return
        self._stopping = False
        verified = self._verified
        if verified is None or verified[0] != settings:
            verified = await self._verify(settings)
        self._verified = None
        self._settings = settings
        await self._spawn(settings, verified[1], verified[2], verified[3])

    async def _verify(self, settings: Settings) -> tuple[Settings, ResolvedRuntime, Path, Path]:
        model_info = (
            self._model_info_for(settings.model_id) if self._model_info_for is not None else None
        )
        config_path = await asyncio.to_thread(
            write_daemon_config,
            self._paths,
            settings,
            self._model_path_for(settings.model_id),
            model_info=model_info,
        )
        resolved = await self._resolver.resolve(settings.compute_backend, config_path=config_path)
        if not resolved.binary.is_file():
            raise RuntimeStartError(
                "pinned runtime binary is missing",
                detail=str(resolved.binary.relative_to(self._paths.plugin_root)),
            )
        digest = await asyncio.to_thread(hash_binary, resolved.binary)
        if digest != resolved.artifact.sha256:
            raise RuntimeStartError(
                "runtime binary does not match the pinned digest",
                detail=f"expected {resolved.artifact.sha256[:12]}… got {digest[:12]}…",
            )
        exec_path = await asyncio.to_thread(
            ensure_executable_copy,
            resolved.binary,
            self._exec_copy_dir,
            source_digest=digest,
        )
        return (settings, resolved, config_path, exec_path)

    async def stop(self) -> None:
        self._stopping = True
        proc = self._proc
        if proc is not None:
            await self._terminate(proc)
        await self._await_task_bounded(self._watch_task, "exit watcher")
        await self._await_task_bounded(self._drain_task, "log drain")
        self._proc = None
        self._watch_task = None
        self._drain_task = None

    async def restart(self, settings: Settings) -> None:
        await self.stop()
        self._restarts_used = 0
        self._stopping = False
        await self.start(settings)

    def is_running(self) -> bool:
        proc = self._proc
        return proc is not None and proc.returncode is None

    @property
    def restart_attempts(self) -> int:
        return self._restarts_used

    @property
    def pid(self) -> int | None:
        return self._proc.pid if self._proc is not None else None

    @property
    def selected_backend(self) -> str | None:
        return self._resolver.selected_backend

    async def _spawn(
        self,
        settings: Settings,
        resolved: ResolvedRuntime,
        config_path: Path,
        exec_path: Path,
    ) -> None:
        argv = [
            str(exec_path),
            "--config",
            str(config_path),
            "daemon",
        ]
        try:
            proc = await asyncio.create_subprocess_exec(
                *argv,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,
                stdin=asyncio.subprocess.DEVNULL,
                env=child_environment(self._paths.data_dir),
                start_new_session=True,
                cwd=str(self._paths.data_dir),
                preexec_fn=daemon_preexec(os.getpid()),
            )
        except OSError as exc:
            raise RuntimeStartError(
                "pinned runtime binary could not be executed",
                detail=type(exc).__name__,
            ) from exc

        self._proc = proc
        self._spawned_at = self._clock()
        self._drain_task = asyncio.get_running_loop().create_task(self._drain_output(proc))
        self._watch_task = asyncio.get_running_loop().create_task(self._watch_exit(proc))
        await self._publish_status(
            available=True,
            state="starting",
            pid=proc.pid,
            backend=resolved.backend,
        )

    async def _drain_output(self, proc: asyncio.subprocess.Process) -> None:
        log = DaemonLog(self._paths.daemon_log)
        stream = proc.stdout
        if stream is None:
            return
        while True:
            line = await stream.readline()
            if not line:
                return
            log.write_line(line)

    async def _watch_exit(self, proc: asyncio.subprocess.Process) -> None:
        exit_code = await proc.wait()
        self.last_exit_code = exit_code
        await self._await_task_bounded(self._drain_task, "log drain")
        self._proc = None

        if self._stopping:
            await self._publish_status(available=False, state="stopped", exit_code=exit_code)
            return

        if self._clock() - self._spawned_at >= self._stability_window:
            self._restarts_used = 0

        if self._on_unexpected_exit is not None:
            await _maybe_await(self._on_unexpected_exit(exit_code))

        await self._publish_status(available=False, state="crashed", exit_code=exit_code)
        await self._maybe_restart()

    async def _maybe_restart(self) -> None:
        settings = self._settings
        if settings is None or self._stopping or self.is_running():
            return

        if self._restarts_used >= self._max_restart_attempts:
            await self._publish_status(
                available=False,
                state="unavailable",
                exit_code=self.last_exit_code,
                detail="restart policy exhausted; explicit restart required",
            )
            return

        if not self._is_idle():
            await self._publish_status(
                available=False,
                state="unavailable",
                exit_code=self.last_exit_code,
                detail="restart skipped: session activity pending",
            )
            return

        delay = min(
            self._restart_base_delay * (2**self._restarts_used),
            self._restart_max_delay,
        )
        self._restarts_used += 1
        attempt = self._restarts_used
        await asyncio.sleep(delay)
        if self._stopping or self.is_running():
            return
        try:
            _, resolved, config_path, exec_path = await self._verify(settings)
            await self._spawn(settings, resolved, config_path, exec_path)
        except SpeechError as exc:
            await self._publish_status(
                available=False,
                state="unavailable",
                exit_code=self.last_exit_code,
                detail=exc.message,
            )
            return
        await self._publish_status(available=True, state="restarted", restart_attempt=attempt)

    async def _terminate(self, proc: asyncio.subprocess.Process) -> None:
        pid = proc.pid
        with contextlib.suppress(ProcessLookupError):
            os.killpg(pid, signal.SIGTERM)
        try:
            await asyncio.wait_for(proc.wait(), self._shutdown_timeout)
            return
        except TimeoutError:
            pass
        with contextlib.suppress(ProcessLookupError):
            os.killpg(pid, signal.SIGKILL)
        await proc.wait()

    async def _await_task_bounded(self, task: asyncio.Task[None] | None, label: str) -> None:
        if task is None or task.done():
            return
        try:
            await asyncio.wait_for(asyncio.shield(task), self._shutdown_timeout)
        except TimeoutError:
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                LOGGER.debug("%s task cancelled at shutdown", label)
        except asyncio.CancelledError:
            raise

    async def _publish_status(
        self,
        *,
        available: bool,
        state: str,
        exit_code: int | None = None,
        pid: int | None = None,
        restart_attempt: int | None = None,
        detail: str | None = None,
        backend: str | None = None,
    ) -> None:
        payload: dict[str, object] = {
            "protocolVersion": PROTOCOL_VERSION_V1,
            "available": available,
            "state": state,
        }
        if exit_code is not None:
            payload["exitCode"] = exit_code
        if pid is not None:
            payload["pid"] = pid
        if restart_attempt is not None:
            payload["restartAttempt"] = restart_attempt
        if backend is not None:
            payload["backend"] = backend
        if detail is not None:
            payload["detail"] = detail
        await self._publisher.publish(EVENT_RUNTIME_STATUS, payload)


async def _maybe_await(callback_result: object) -> None:
    if asyncio.iscoroutine(callback_result):
        await callback_result

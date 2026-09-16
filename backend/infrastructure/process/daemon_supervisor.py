"""SpeechDaemonSupervisor (spec §37-§39, §69-§71).

Owns the native STT daemon child process for its whole lifetime:

- starts the exact pinned binary from defaults/runtime-manifest.json and
  fails closed with RUNTIME_START_FAILED while the artifact is unpinned
  (§35, §53 — the repository ships an intentionally unpinned manifest);
- spawns via argument-array `create_subprocess_exec` only (§40);
- redirects daemon stdout/stderr into a rotating log file under the plugin
  data dir, actively drained from a pipe (§39: no unread pipes, no
  transcript content is ever written by this process itself);
- stops in the §38 order: SIGTERM → bounded wait → SIGKILL only if required,
  killing the whole process group so no orphan survives;
- applies the §70 restart policy: at most 3 attempts with bounded exponential
  delay, only when no active session/transcription is pending; afterwards the
  runtime stays unavailable until an explicit restart.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import os
import re
import signal
import time
from collections.abc import Callable
from pathlib import Path

from backend.domain.contracts import (
    EVENT_RUNTIME_STATUS,
    PROTOCOL_VERSION_V1,
    EventPublisher,
    Settings,
)
from backend.domain.errors import RuntimeStartError, SpeechError
from backend.infrastructure.process.process_environment import PluginPaths, child_environment

LOGGER = logging.getLogger("speech.runtime")

SHUTDOWN_TIMEOUT_S = 5.0  # §71: daemon shutdown
MAX_RESTART_ATTEMPTS = 3  # §70
RESTART_BASE_DELAY_S = 0.5  # §70: bounded exponential delay
RESTART_MAX_DELAY_S = 8.0
# A daemon that stayed up this long is considered stable again; the restart
# budget resets so a later crash gets a fresh policy window.
RESTART_STABILITY_WINDOW_S = 60.0

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
_LOG_MAX_BYTES = 512 * 1024
_LOG_BACKUPS = 2


class DaemonLog:
    """Small size-capped rotating log for daemon stdout/stderr (§39)."""

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
            # Diagnostics must never break supervision (§39).
            LOGGER.debug("daemon log write failed", exc_info=True)

    def _rotate(self) -> None:
        oldest = self._path.with_name(self._path.name + f".{_LOG_BACKUPS}")
        oldest.unlink(missing_ok=True)
        for index in range(_LOG_BACKUPS - 1, 0, -1):
            source = self._path.with_name(self._path.name + f".{index}")
            if source.exists():
                source.rename(self._path.with_name(self._path.name + f".{index + 1}"))
        self._path.rename(self._path.with_name(self._path.name + ".1"))


class _RuntimeArtifact:
    """Pinned native runtime metadata (§53)."""

    def __init__(
        self,
        *,
        artifact_id: str,
        engine: str,
        arch: str,
        version: str,
        source: str,
        sha256: str,
        license: str,
    ) -> None:
        self.artifact_id = artifact_id
        self.engine = engine
        self.arch = arch
        self.version = version
        self.source = source
        self.sha256 = sha256
        self.license = license


def load_pinned_runtime_artifact(manifest_path: Path) -> _RuntimeArtifact:
    """Load defaults/runtime-manifest.json; fail closed unless pinned (§53).

    The committed manifest is intentionally unpinned until the runtime lane
    fills it (see bin/README.md); every unpinned field is a hard
    RUNTIME_START_FAILED, never a fallback or a download (§109).
    """
    try:
        raw = json.loads(manifest_path.read_bytes().decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeStartError(
            "runtime manifest cannot be read",
            detail=f"{manifest_path.name}: {type(exc).__name__}",
        ) from exc

    problems: list[str] = []
    artifact_raw: object = None
    if not isinstance(raw, dict) or raw.get("schemaVersion") != 1:
        problems.append("schemaVersion must be 1")
    else:
        artifacts_raw = raw.get("artifacts")
        if not isinstance(artifacts_raw, list) or len(artifacts_raw) == 0:
            problems.append("artifacts must be a non-empty array")
        else:
            artifact_raw = artifacts_raw[0]

    if not problems and not isinstance(artifact_raw, dict):
        problems.append("artifacts[0] must be an object")

    fields = ("id", "engine", "arch", "version", "source", "sha256", "license")
    values: dict[str, str] = {}
    if not problems and isinstance(artifact_raw, dict):
        for field in fields:
            value = artifact_raw.get(field)
            if not isinstance(value, str) or len(value) == 0:
                problems.append(f"{field} is not pinned (empty)")
            else:
                values[field] = value
        sha = values.get("sha256", "")
        if sha and _SHA256_RE.fullmatch(sha) is None:
            problems.append("sha256 must be 64 lowercase hex characters")
        source = values.get("source", "")
        if source and not source.startswith("https://"):
            problems.append("source must be an https URL (§53: never download latest)")

    if problems:
        raise RuntimeStartError(
            "native runtime artifact is not pinned",
            detail="; ".join(problems[:4]),
        )

    return _RuntimeArtifact(
        artifact_id=values["id"],
        engine=values["engine"],
        arch=values["arch"],
        version=values["version"],
        source=values["source"],
        sha256=values["sha256"],
        license=values["license"],
    )


class SpeechDaemonSupervisor:
    """Owns the native daemon child for its whole lifetime (§37)."""

    def __init__(
        self,
        paths: PluginPaths,
        publisher: EventPublisher,
        *,
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
        self._stopping = False
        self._restarts_used = 0
        self._spawned_at = 0.0
        self._settings: Settings | None = None
        self.last_exit_code: int | None = None

    # ── §37 supervisor surface ───────────────────────────────────────────────

    async def start(self, settings: Settings) -> None:
        """Start the pinned binary; idempotent while running (§35, §53)."""
        if self.is_running():
            return
        self._stopping = False
        artifact = load_pinned_runtime_artifact(self._paths.runtime_manifest)
        binary = self._paths.runtime_binary
        if not binary.is_file():
            raise RuntimeStartError(
                "pinned runtime binary is missing",
                detail=str(binary.relative_to(self._paths.plugin_root)),
            )
        digest = await asyncio.to_thread(_hash_binary, binary)
        if digest != artifact.sha256:
            raise RuntimeStartError(
                "runtime binary does not match the pinned digest (§53)",
                detail=f"expected {artifact.sha256[:12]}… got {digest[:12]}…",
            )
        self._settings = settings
        await self._spawn(settings)

    async def stop(self) -> None:
        """§38 stop order: SIGTERM → bounded wait → SIGKILL, group-wide."""
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
        """Explicit user-driven restart; resets the §70 restart budget."""
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

    # ── internals ────────────────────────────────────────────────────────────

    async def _spawn(self, settings: Settings) -> None:
        argv = [
            str(self._paths.runtime_binary),
            "daemon",
            "--status-file",
            str(self._paths.status_file),
            "--output-file",
            str(self._paths.output_file),
            "--control-socket",
            str(self._paths.control_socket),
            "--model",
            settings.model_id,
            "--compute-backend",
            settings.compute_backend,
            "--language",
            settings.language,
            "--vad-enabled",
            "true" if settings.vad_enabled else "false",
            "--max-recording-seconds",
            str(settings.max_recording_seconds),
        ]
        try:
            # §40: argument-array only. start_new_session gives the daemon its
            # own process group so the group kill below cannot miss children.
            proc = await asyncio.create_subprocess_exec(
                *argv,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,  # §39: one drained stream → log file
                stdin=asyncio.subprocess.DEVNULL,
                env=child_environment(self._paths.data_dir),
                start_new_session=True,
                cwd=str(self._paths.data_dir),
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
        )

    async def _drain_output(self, proc: asyncio.subprocess.Process) -> None:
        """§39: actively drain the daemon pipe into the rotating log file."""
        log = DaemonLog(self._paths.daemon_log)
        stream = proc.stdout
        if stream is None:  # pragma: no cover - PIPE is always set above
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

        # §70: the restart budget resets once the daemon proved stable.
        if self._clock() - self._spawned_at >= self._stability_window:
            self._restarts_used = 0

        if self._on_unexpected_exit is not None:
            # Application layer clears any active session (RUNTIME_CRASHED, §69).
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
                detail="restart policy exhausted; explicit restart required (§70)",
            )
            return

        if not self._is_idle():
            # §70: never restart while a transcript insertion may be pending.
            await self._publish_status(
                available=False,
                state="unavailable",
                exit_code=self.last_exit_code,
                detail="restart skipped: session activity pending (§70)",
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
            await self._spawn(settings)
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
        # §38: SIGKILL only if required; the whole group dies with the leader.
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
        if detail is not None:
            payload["detail"] = detail
        await self._publisher.publish(EVENT_RUNTIME_STATUS, payload)


async def _maybe_await(callback_result: object) -> None:
    if asyncio.iscoroutine(callback_result):
        await callback_result


def _hash_binary(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()

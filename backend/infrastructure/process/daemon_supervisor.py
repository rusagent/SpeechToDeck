"""SpeechDaemonSupervisor (spec §37-§39, §69-§71).

Owns the native STT daemon child process for its whole lifetime:

- resolves the pinned binary per compute variant from
  defaults/runtime-manifest.json (cpu → avx2 build, vulkan → vulkan build,
  auto → the §47 probe policy in runtime_variant.py) and fails closed with
  RUNTIME_START_FAILED when the selected artifact is unpinned, its binary is
  missing, or its bytes do not match the pinned digest (§35, §53);
- spawns the daemon from a digest-verified PRIVATE COPY of the pinned binary
  under the plugin data dir, never `bin/` directly: installing an update over
  the RUNNING plugin rewrites `bin/` in place and a direct-executing daemon
  made that abort with `[Errno 26] Text file busy` (deck 2026-09-18). The
  copy is a digest-keyed cache refreshed atomically on every spawn
  verification (executable_copy.py); Linux rename-over-a-running-executable
  is legal, so the refresh can never collide with the running daemon;
- generates one TOML config per daemon start with the exact upstream keys
  (state_file, output file mode, whisper model/language, VAD, disabled
  hotkey/notifications/OSD/streaming) and spawns
  `<private copy> --config <generated> daemon` — the daemon subcommand takes
  no options upstream; all tuning travels through the config file;
- spawns via argument-array `create_subprocess_exec` only (§40), and binds
  the child to this process's lifetime with PR_SET_PDEATHSIG where available
  (mature-plugin adopt, audit 2026-09-17: the loader kills only the plugin
  process — KillMode=process + SIGKILL after the dispose window — so the
  kernel-level parent-death signal closes the orphan hole the group ladder
  alone cannot);
- redirects daemon stdout/stderr into a rotating log file under the plugin
  data dir, actively drained from a pipe (§39: no unread pipes, no
  transcript content is ever written by this process itself);
- stops in the §38 order: SIGTERM → bounded wait → SIGKILL only if required,
  killing the whole process group so no orphan survives (upstream handles
  SIGTERM gracefully and deletes its state file);
- applies the §70 restart policy: at most 3 attempts with bounded exponential
  delay, only when no active session/transcription is pending; afterwards the
  runtime stays unavailable until an explicit restart.
"""

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

try:  # PR_SET_PDEATHSIG is Linux-only (prctl(2)); keep other platforms spawnable.
    import ctypes
except ImportError:  # pragma: no cover - CPython always ships ctypes
    ctypes = None  # type: ignore[assignment]

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

SHUTDOWN_TIMEOUT_S = 5.0  # §71: daemon shutdown
MAX_RESTART_ATTEMPTS = 3  # §70
RESTART_BASE_DELAY_S = 0.5  # §70: bounded exponential delay
RESTART_MAX_DELAY_S = 8.0

# v0.2.6: VAD stays disabled in the generated config. The silero VAD model is
# not bundled with the plugin, so voxtype logs "Failed to initialize VAD,
# continuing without: VAD model not found" and runs without VAD anyway —
# emitting `enabled = true` only configured a feature that never initialized
# on device. Flip back only if a voxtype setup ever ships the VAD model with
# the runtime.
DAEMON_VAD_ENABLED = False
# A daemon that stayed up this long is considered stable again; the restart
# budget resets so a later crash gets a fresh policy window.
RESTART_STABILITY_WINDOW_S = 60.0

_LOG_MAX_BYTES = 512 * 1024
_LOG_BACKUPS = 2

# Linux prctl(2) operation: bind the child to this process's lifetime.
PR_SET_PDEATHSIG = 1


def daemon_preexec(parent_pid: int) -> Callable[[], None] | None:
    """preexec_fn binding the daemon child to this process's lifetime.

    The Decky loader kills only the plugin process: the systemd unit runs
    `KillMode=process` and the loader SIGKILLs it after the bounded dispose
    window (loader plugin.py:161,176-183), so a daemon outliving an aborted
    dispose would survive as an init-reparented orphan (field-documented by
    decky-copyparty main.py:20-27). PR_SET_PDEATHSIG makes the kernel deliver
    SIGTERM to the child the moment this process dies — the shipped DeckyEQ
    worker.py:10-13 / copyparty main.py:36-37 pattern — while the §38
    SIGTERM→SIGKILL group ladder stays the primary shutdown path. The classic
    race guard re-checks the parent after fork: when it died between fork and
    prctl, the child exits immediately instead of outliving the backend
    (DeckyEQ worker.py:14-15). Returns None where prctl is unavailable
    (non-Linux platforms).
    """
    if ctypes is None or not sys.platform.startswith("linux"):
        return None

    def preexec() -> None:  # runs in the forked child, before exec
        libc = ctypes.CDLL(None, use_errno=True)
        if libc.prctl(PR_SET_PDEATHSIG, signal.SIGTERM, 0, 0, 0) != 0:
            errno_value = ctypes.get_errno()
            raise OSError(errno_value, os.strerror(errno_value))
        if os.getppid() != parent_pid:
            # The parent already died mid-spawn: never exec the daemon.
            os._exit(1)

    return preexec


# Model path resolver: settings model id → absolute .bin path in the plugin
# data dir (the ModelStore download target; composition wires it to the
# loaded model manifest so downloads/checksums stay under our control).
ModelPathResolver = Callable[[str], Path]

# Resolved manifest info for the selected model (ADR-012 effective-language
# derivation: the config build needs the declared languages); None when the
# id is unknown or the resolver is not wired (legacy behavior).
ModelInfoResolver = Callable[[str], ModelInfo | None]


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


def _toml_string(value: str) -> str:
    """Escape a TOML basic string (JSON string escaping is TOML-compatible)."""
    return json.dumps(value)


def _effective_language(settings_language: str, model_info: ModelInfo | None) -> str:
    """Effective [whisper] language for the generated config (ADR-012).

    Precedence:

    1. The model declares exactly one language (curated catalog,
       `languages` in defaults/models.json) → that language, ALWAYS. A
       specialized model cannot honor anything else, so a stale persisted
       settings.language (e.g. german model + "en") is ignored here rather
       than reaching the daemon. This subsumes the ADR-011 English-only
       forcing for the shipped catalog (distil-en declares ["en"]).
    2. Known English-only model WITHOUT declared languages
       (multilingual=false) → "en" (ADR-011 fallback, unchanged: .en
       checkpoints cannot auto-detect and cannot honor other languages).
    3. Otherwise the legacy mapping: "system" → "auto" (our sentinel has no
       upstream equivalent), explicit tags pass through. Covers multilingual
       general models, models declaring several languages (the user picks
       among them), and the unwired/unknown-model case.
    """
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
    """Generate the daemon TOML for one start (verified upstream v1.0.1 keys).

    Key mapping against the upstream default config
    (github.com/peteonrails/voxtype `dev`, config/default.toml and
    src/config/*.rs, all cited in bin/README.md):

    - `engine = "whisper"` — top-level engine selection;
    - `state_file` — bare-word state file; the daemon deletes it on shutdown
      (missing file = stopped for consumers);
    - `[audio] max_duration_secs` — §44 recording bound. v0.2.10 (ADR-012):
      a 24 h runaway-recording valve (`DEFAULT_MAX_RECORDING_SECONDS`),
      emitted as a FIXED constant — recording is practically unlimited
      (upstream has no true unlimited mode: 0 auto-stops within ~100 ms).
      v0.2.5 removed the setting from the settings document (owner
      declutter), so no user value reaches this key;
    - `[whisper] model` — absolute path to OUR downloaded ggml file (upstream
      accepts ids or absolute .bin paths; the absolute path keeps downloads
      and checksums under our ModelStore control);
    - `[whisper] language` — effective-language derivation (ADR-012): a
      model that declares exactly ONE language in the manifest gets that
      language REGARDLESS of settings.language (a specialized model cannot
      honor anything else; a stale persisted override like
      german-model + settings "en" must never reach the daemon). Otherwise
      the legacy mapping applies — settings "system" maps to "auto" (no
      upstream equivalent), explicit codes pass through — except for a known
      English-only model without declared languages
      (multilingual=false, ADR-011 fallback), which is pinned to "en"
      because .en checkpoints cannot auto-detect NOR honor any other
      language (on-device 2026-09-19: an en-only model with an explicit "de"
      produced broken transcription);
    - `[whisper] on_demand_loading = false` — the model stays loaded (§82);
    - `[whisper] eager_processing = false` — one-shot dictation only;
    - `[vad] enabled` — v0.2.6: FIXED to false — the silero VAD model is not
      bundled, voxtype warns and continues without it, so a `true` line only
      configured a feature that never initialized (the v0.2.5 fixed-true is
      gone; the settings toggle stays removed, owner declutter);
    - `[output] mode = "file"` + `file_path` + `file_mode = "overwrite"` —
      atomic per-recording transcript writes with the `.done` sidecar;
    - `[output.notification]` all off and `[osd] enabled = false` (upstream
      OSD default is enabled) — no UI side effects from the plugin runtime;
    - `[streaming]` is omitted entirely — upstream treats the section as
      opt-in (`Option<StreamingConfig>`), so streaming stays disabled;
    - `[hotkey] enabled = false` — recording is driven by our client only.
    """
    language = _effective_language(settings.language, model_info)
    lines = [
        f"engine = {_toml_string('whisper')}",
        f"state_file = {_toml_string(str(state_file))}",
        "",
        "[hotkey]",
        "enabled = false",
        "",
        "[audio]",
        # Fixed §44 valve (v0.2.10, ADR-012): see the docstring mapping
        # notes above.
        f"max_duration_secs = {DEFAULT_MAX_RECORDING_SECONDS}",
        "",
        "[whisper]",
        f"model = {_toml_string(str(model_path))}",
        f"language = {_toml_string(language)}",
        "on_demand_loading = false",
        "eager_processing = false",
        "",
        "[vad]",
        # Fixed constant (v0.2.6: silero VAD model not bundled) — see the
        # docstring notes.
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
    """Write the generated daemon config atomically; return its path (§55)."""
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
    """Owns the native daemon child for its whole lifetime (§37)."""

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
        # Private executable cache under the plugin data dir (§109): the
        # daemon never executes bin/ directly (Text-file-busy hazard).
        self._exec_copy_dir = paths.runtime_dir / EXEC_COPY_DIRNAME
        self._stopping = False
        self._restarts_used = 0
        self._spawned_at = 0.0
        self._settings: Settings | None = None
        self.last_exit_code: int | None = None

    # ── §37 supervisor surface ───────────────────────────────────────────────

    async def verify(self, settings: Settings) -> None:
        """§82 verification phase without spawning: config generation, variant
        selection, binary presence and pinned-digest check (§35, §53), plus
        the digest-verified private executable copy.

        Split from `start()` so the startup orchestration can emit its
        `runtime.verify` setup step around the real verification. The verified
        spawn inputs are cached for an immediately following `start()` with
        equal settings; `start()` verifies by itself when called standalone.
        """
        self._verified = await self._verify(settings)

    async def start(self, settings: Settings) -> None:
        """Start the pinned variant binary; idempotent while running (§35, §53).

        Reuses inputs from a preceding `verify()` with equal settings (§82:
        verify → ensure → start) instead of hashing the binary twice. The
        daemon executes the private copy prepared by the verification, never
        `bin/` directly (Text-file-busy hazard, deck 2026-09-18).
        """
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
        """Config generation, variant resolution, presence + digest check, and
        the digest-verified private executable copy (§53: source AND copy)."""
        # The config exists before resolution: the §47 auto probe runs the
        # candidate binary against exactly this configuration. The selected
        # model's manifest info drives the ADR-012 effective-language
        # derivation in the config build (single-language models force their
        # declared language).
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
                "runtime binary does not match the pinned digest (§53)",
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

    @property
    def selected_backend(self) -> str | None:
        """§67 metrics backend of the running/last-started variant."""
        return self._resolver.selected_backend

    # ── internals ────────────────────────────────────────────────────────────

    async def _spawn(
        self,
        settings: Settings,
        resolved: ResolvedRuntime,
        config_path: Path,
        exec_path: Path,
    ) -> None:
        # Real upstream surface: global flags precede the option-less daemon
        # subcommand; all tuning travels through the generated config file.
        # argv[0] is the digest-verified private copy — never bin/ directly —
        # so an update installed over the running plugin cannot hit
        # `[Errno 26] Text file busy` on the executing image.
        argv = [
            str(exec_path),
            "--config",
            str(config_path),
            "daemon",
        ]
        try:
            # §40: argument-array only. start_new_session gives the daemon its
            # own process group so the group kill below cannot miss children;
            # PDEATHSIG (when available) additionally ends the child if this
            # process itself is SIGKILLed outside any graceful path.
            proc = await asyncio.create_subprocess_exec(
                *argv,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.STDOUT,  # §39: one drained stream → log file
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
            # Full §53 re-verification for the §70 restart: the spawn inputs
            # (config, resolved variant, private executable copy) are rebuilt
            # through the same path as a fresh start, so a runtime that
            # changed on disk is never restarted onto an unverified binary.
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

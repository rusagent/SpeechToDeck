"""Voxtype CLI client (spec §40, §42, §71).

Control of the native runtime happens exclusively through argument-array
subprocess invocations of the SELECTED variant binary (§40). The real
upstream surface (v1.0.1, verified against `src/cli/record.rs` and
`src/app/record.rs`) is:

- `record start --file=<transcript path>` — signals the daemon (SIGUSR1)
  and exits 0 once the signal was delivered; bounded by the 2 s ack (§71);
- `record stop --wait --json --timeout <bounded>` — signals the daemon
  (SIGUSR2), then blocks on the `.done` completion sidecar and prints one
  outcome object. Exit codes: 0 transcribed, 3 empty, 4 timed out, 1 failed;
- `record cancel` — writes the cancel trigger file the daemon observes.

Recording flow per §42: previous transcript output and its sidecar are
removed before recording starts, the final outcome is resolved by the stop
command's exit code, the freshly produced output is read exactly once after
a transcribed stop, normalized at the process boundary (exactly one
trailing newline stripped — upstream always writes one), and deleted so a
previous result can never be reused. The stop outcome is delivered through
the TranscriptSink from a background task, so the §71 stop acknowledgement
stays bounded while the final transcription wait stays bounded by the
`--timeout` handed to the CLI plus a small local grace.

The daemon reports empty speech itself (exit 3): the client delivers it as
an empty TranscriptResult and the application service applies the §77
empty-speech path. Errors are never invented from status words — they come
only from these outcomes.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import Callable

from backend.domain.contracts import TranscriptResult, TranscriptSink
from backend.domain.errors import (
    CodedSpeechError,
    RecordingStartError,
    RecordingStopError,
    SpeechError,
    TranscriptionFailedError,
    TranscriptionTimeoutError,
)
from backend.infrastructure.process.process_environment import (
    PluginPaths,
    child_environment,
)
from backend.infrastructure.process.runtime_variant import RuntimeVariantResolver

LOGGER = logging.getLogger("speech.runtime")

ACK_TIMEOUT_S = 2.0  # §71: record start/stop/cancel acknowledgement
# §71 final-wait floor for the CLI's `--timeout`: the historical v0.2.x
# budget, kept exactly for short recordings. With the 24 h recording valve
# (ADR-012) there is no fixed cap to budget from, so the handed-out
# --timeout grows with the actually recorded duration (`final_wait_budget`).
DEFAULT_FINAL_TIMEOUT_S = 120.0
STOP_TIME_FACTOR = 2.0  # ≈ twice real time: whisper headroom for long audio
# Local grace on top of the CLI's own --timeout: the CLI reports timeout
# (exit 4) itself; only a hung CLI is killed here.
_STOP_CLI_GRACE_S = 5.0
_ERROR_DETAIL_LIMIT = 200

# Upstream `record stop --wait` exit contract (src/app/record.rs).
_EXIT_TRANSCRIBED = 0
_EXIT_EMPTY = 3
_EXIT_TIMEOUT = 4


def final_wait_budget(recorded_seconds: float, floor_s: float) -> float:
    """§71 `record stop --timeout` budget, scaled with the recording (ADR-012).

    max(floor, recorded_seconds * STOP_TIME_FACTOR): short recordings keep
    their exact current bound (the floor), longer ones get transcription
    headroom proportional to what was actually recorded. From 45 s recorded
    upward this stays at or below the application watchdog's scaled budget
    (which adds its 30 s grace), so the upstream exit-4 timeout remains the
    primary reporter; below 45 s the 120 s floor exceeds the watchdog's
    90 s floor, which fires first — the historical v0.2.x relationship,
    kept by the floors on purpose. Deterministic in `recorded_seconds`;
    strictly bounded at every length (§71: no wait is unbounded).
    """
    return max(floor_s, recorded_seconds * STOP_TIME_FACTOR)


class VoxtypeClient:
    """SpeechRuntime adapter over the pinned runtime's CLI (§32, §35)."""

    def __init__(
        self,
        paths: PluginPaths,
        resolver: RuntimeVariantResolver,
        *,
        ack_timeout: float = ACK_TIMEOUT_S,
        final_transcript_timeout: float = DEFAULT_FINAL_TIMEOUT_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._paths = paths
        self._resolver = resolver
        self._ack_timeout = ack_timeout
        self._final_timeout = final_transcript_timeout
        self._clock = clock
        self.transcript_sink: TranscriptSink | None = None
        self._delivery_task: asyncio.Task[None] | None = None
        self._stop_proc: asyncio.subprocess.Process | None = None
        # Monotonic timestamp of the last acknowledged `record start`; drives
        # the ADR-012 scaled stop budget. One-shot: consumed by stop, cleared
        # by cancel.
        self._recording_started_at: float | None = None

    # ── SpeechRuntime port (§32) ─────────────────────────────────────────────

    async def start(self) -> None:
        """Runtime surface ready: drop stale output from a previous session."""
        # §42/§110: a transcript (or sidecar) left behind by a crashed
        # previous plugin session must never be reused; every recording also
        # clears both before it starts.
        self._clear_output_artifacts()

    async def stop(self) -> None:
        await self._abort_delivery()

    async def start_recording(self) -> None:
        self._require_sink()
        # §42 step 1: remove/truncate previous transcript output and its
        # completion sidecar.
        self._clear_output_artifacts()
        await self._control(
            ["record", "start", f"--file={self._paths.output_file}"],
            start_failure=RecordingStartError,
        )
        # The daemon is recording from here: the ADR-012 stop budget measures
        # the real recording span from the acknowledged start.
        self._recording_started_at = self._clock()

    async def stop_recording(self) -> None:
        self._require_sink()
        started_at = self._recording_started_at
        self._recording_started_at = None
        recorded_seconds = max(0.0, self._clock() - started_at) if started_at is not None else 0.0
        # §42 steps 2-3 run in the background: the stop acknowledgement stays
        # bounded (§71) while the CLI's --wait resolves the final outcome.
        self._delivery_task = asyncio.get_running_loop().create_task(
            self._deliver_final_transcript(recorded_seconds)
        )

    async def cancel_recording(self) -> None:
        try:
            await self._control(["record", "cancel"], start_failure=RecordingStopError)
        finally:
            self._recording_started_at = None
            # §72: cancellation discards any pending result unconditionally.
            await self._abort_delivery()

    # ── transcript delivery (§42) ────────────────────────────────────────────

    def _require_sink(self) -> TranscriptSink:
        if self.transcript_sink is None:
            raise TranscriptionFailedError("transcript sink is not wired")
        return self.transcript_sink

    def _clear_output_artifacts(self) -> None:
        self._paths.output_file.unlink(missing_ok=True)
        self._paths.output_sidecar_file.unlink(missing_ok=True)

    async def _abort_delivery(self) -> None:
        task = self._delivery_task
        self._delivery_task = None
        if task is not None and not task.done():
            # A running stop CLI is bounded by its own --timeout, but §72
            # cancellation (and teardown) must not leave it lingering: kill
            # it before cancelling the delivery task.
            proc = self._stop_proc
            self._stop_proc = None
            if proc is not None and proc.returncode is None:
                proc.kill()
                with contextlib.suppress(ProcessLookupError):
                    await proc.communicate()
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                LOGGER.debug("pending transcript delivery aborted")
            except Exception:
                LOGGER.debug("pending transcript delivery aborted with error")

    async def _deliver_final_transcript(self, recorded_seconds: float) -> None:
        sink = self._require_sink()
        started = self._clock()
        try:
            exit_code, stderr_text = await self._run_stop_command(recorded_seconds)
        except asyncio.CancelledError:
            raise
        except SpeechError as exc:
            # The stop CLI could not run (variant unresolved, spawn failure):
            # surface it through the sink instead of dying unretrieved.
            await sink.on_transcript_error(exc)
            return
        except Exception as exc:
            await sink.on_transcript_error(
                TranscriptionFailedError("stop command failed", detail=type(exc).__name__)
            )
            return

        if exit_code == _EXIT_TIMEOUT or exit_code is None:
            # Exit 4 is the CLI's own --timeout; None means the CLI itself
            # never finished within the local grace and was killed (§71).
            await sink.on_transcript_error(
                TranscriptionTimeoutError("final transcription wait timed out")
            )
            return

        if exit_code == _EXIT_EMPTY:
            # §77: the daemon itself reported empty speech (no transcript file
            # is written); deliver an empty result, the application applies
            # the empty-speech path.
            self._clear_output_artifacts()
            await sink.on_transcript(self._result(text="", started=started))
            return

        if exit_code != _EXIT_TRANSCRIBED:
            await sink.on_transcript_error(
                TranscriptionFailedError(
                    "native runtime failed to transcribe",
                    detail=stderr_text[:_ERROR_DETAIL_LIMIT] or f"exit={exit_code}",
                )
            )
            return

        try:
            result = self._read_output_once(started)
        except FileNotFoundError:
            await sink.on_transcript_error(
                TranscriptionFailedError("transcript output missing after a transcribed stop")
            )
            return
        await sink.on_transcript(result)

    async def _run_stop_command(self, recorded_seconds: float) -> tuple[int | None, str]:
        """Run `record stop --wait --json --timeout N`; return (exit, stderr).

        N is the ADR-012 scaled budget (`final_wait_budget`): the floor for
        short recordings, growing with the recorded duration otherwise.

        stdout is discarded: the upstream --json outcome object embeds the
        transcript text, so it is never read into a loggable buffer (§73).
        """
        timeout = max(1, round(final_wait_budget(recorded_seconds, self._final_timeout)))
        argv = self._cli_argv(
            ["record", "stop", "--wait", "--json", "--timeout", str(timeout)],
            start_failure=RecordingStopError,
        )
        proc = await self._spawn_cli(argv, start_failure=RecordingStopError)
        self._stop_proc = proc
        try:
            _, stderr = await asyncio.wait_for(proc.communicate(), timeout + _STOP_CLI_GRACE_S)
        except TimeoutError:
            proc.kill()
            with contextlib.suppress(ProcessLookupError):
                await proc.communicate()
            return None, ""
        finally:
            self._stop_proc = None
        detail = stderr.decode("utf-8", errors="replace").strip()
        return proc.returncode, detail

    def _read_output_once(self, started: float) -> TranscriptResult:
        """§42: read the newly produced output exactly once, then remove it."""
        output_path = self._paths.output_file
        raw = output_path.read_bytes()  # single read; a previous session's
        # output was removed before recording started.
        output_path.unlink(missing_ok=True)
        self._paths.output_sidecar_file.unlink(missing_ok=True)
        # §43: normalize invalid UTF-8 at the process boundary. The upstream
        # writer always appends exactly one trailing newline; strip exactly
        # that one here (further trimming happens in the application, §43).
        text = raw.decode("utf-8", errors="replace")
        if text.endswith("\n"):
            text = text[:-1]
        return self._result(text=text, started=started)

    def _result(self, *, text: str, started: float) -> TranscriptResult:
        backend = self._resolver.selected_backend
        return TranscriptResult(
            text=text,
            backend=backend if backend in ("cpu", "vulkan") else None,
            transcription_duration_ms=(self._clock() - started) * 1000.0,
        )

    # ── CLI control (§40) ────────────────────────────────────────────────────

    def _cli_argv(
        self,
        args: list[str],
        *,
        start_failure: type[CodedSpeechError],
    ) -> list[str]:
        """Full argv for a control invocation of the SELECTED variant binary.

        The generated daemon config travels along so the CLI resolves the
        same output/state configuration as the running daemon. An unresolved
        variant (no daemon was ever started) fails closed with the caller's
        stable error instead of invoking an arbitrary binary.
        """
        binary_path = self._resolver.selected_binary_path
        if binary_path is None:
            raise start_failure("native runtime is not running", detail="variant unresolved")
        return [str(binary_path), "--config", str(self._paths.daemon_config), *args]

    async def _spawn_cli(
        self,
        argv: list[str],
        *,
        start_failure: type[CodedSpeechError],
    ) -> asyncio.subprocess.Process:
        try:
            return await asyncio.create_subprocess_exec(
                *argv,
                stdout=asyncio.subprocess.PIPE,
                stderr=asyncio.subprocess.PIPE,
                stdin=asyncio.subprocess.DEVNULL,
                env=child_environment(self._paths.data_dir),
            )
        except OSError as exc:
            raise start_failure(
                "native runtime CLI could not be executed",
                detail=type(exc).__name__,
            ) from exc

    async def _control(
        self,
        args: list[str],
        *,
        start_failure: type[CodedSpeechError],
    ) -> None:
        """Bounded fire-and-forget control invocation (start/cancel, §71).

        The daemon is "running" for the supervisor the moment the process is
        spawned, but the CLI control surface (pid file) appears only after
        the daemon finished booting. A transient refusal is retried until
        the §71 acknowledgement budget is spent; the last error is raised
        then — a genuinely dead runtime fails with the same stable code,
        just after the full ack window.
        """
        deadline = self._clock() + self._ack_timeout
        delay = 0.05
        while True:
            argv = self._cli_argv(args, start_failure=start_failure)
            proc = await self._spawn_cli(argv, start_failure=start_failure)
            try:
                _, stderr = await asyncio.wait_for(proc.communicate(), self._ack_timeout)
            except TimeoutError:
                proc.kill()
                with contextlib.suppress(ProcessLookupError):
                    await proc.communicate()
                raise start_failure(
                    "native runtime did not acknowledge in time",
                    detail=f"timeout after {self._ack_timeout:g}s",
                ) from None

            if proc.returncode == 0:
                return
            remaining = deadline - self._clock()
            if remaining <= 0:
                detail = stderr.decode("utf-8", errors="replace").strip()
                raise start_failure(
                    f"native runtime command {args[0]!r} failed",
                    detail=detail[:_ERROR_DETAIL_LIMIT] or f"exit={proc.returncode}",
                )
            await asyncio.sleep(min(delay, remaining))
            delay *= 2

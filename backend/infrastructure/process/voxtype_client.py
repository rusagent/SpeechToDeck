"""Voxtype CLI client (spec §40, §42, §71).

Control of the native runtime happens exclusively through argument-array
subprocess invocations (§40). Recording flow per §42: previous transcript
output is removed before recording starts, and the freshly produced output is
read exactly once after stop, normalized at the process boundary, and deleted
so a previous result can never be reused.

Acknowledgement timeouts are 2 s (§71). The final transcription wait is
bounded by policy and resolved event-driven through StatusFileWatcher —
there is no polling loop (§41).
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
    TranscriptionFailedError,
    TranscriptionTimeoutError,
)
from backend.infrastructure.process.process_environment import PluginPaths, child_environment
from backend.infrastructure.process.status_monitor import (
    StatusFileWatcher,
    WatcherClosedError,
    WatchEvent,
    transcription_failed_from_status,
)

LOGGER = logging.getLogger("speech.runtime")

ACK_TIMEOUT_S = 2.0  # §71: record start/stop acknowledgement
DEFAULT_FINAL_TIMEOUT_S = 120.0  # bounded by max-recording/model policy (§71)
_ERROR_DETAIL_LIMIT = 200


class VoxtypeClient:
    """SpeechRuntime adapter over the pinned runtime's CLI (§32, §35)."""

    def __init__(
        self,
        paths: PluginPaths,
        watcher: StatusFileWatcher,
        *,
        ack_timeout: float = ACK_TIMEOUT_S,
        final_transcript_timeout: float = DEFAULT_FINAL_TIMEOUT_S,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._paths = paths
        self._watcher = watcher
        self._ack_timeout = ack_timeout
        self._final_timeout = final_transcript_timeout
        self._clock = clock
        self.transcript_sink: TranscriptSink | None = None
        self._delivery_task: asyncio.Task[None] | None = None

    # ── SpeechRuntime port (§32) ─────────────────────────────────────────────

    async def start(self) -> None:
        """Initialize the runtime surface: the event-driven status watch."""
        self._ensure_watch()

    async def stop(self) -> None:
        await self._abort_delivery()

    def _ensure_watch(self) -> None:
        try:
            self._watcher.start()
        except OSError as exc:
            raise TranscriptionFailedError(
                "event-driven status watch unavailable", detail=str(exc)
            ) from exc

    async def start_recording(self) -> None:
        self._require_sink()
        self._ensure_watch()  # §42 delivery depends on the watch being live
        # §42 step 1: remove/truncate previous transcript output.
        self._paths.output_file.unlink(missing_ok=True)
        await self._control(["record", "start"], start_failure=RecordingStartError)

    async def stop_recording(self) -> None:
        self._require_sink()
        await self._control(["record", "stop"], start_failure=RecordingStopError)
        # §42 step 2-3: wait for the final transcription state, then read the
        # newly produced output exactly once and hand it to the sink.
        self._delivery_task = asyncio.get_running_loop().create_task(
            self._deliver_final_transcript()
        )

    async def cancel_recording(self) -> None:
        try:
            await self._control(["record", "cancel"], start_failure=RecordingStopError)
        finally:
            # §72: cancellation discards any pending result unconditionally.
            await self._abort_delivery()

    # ── transcript delivery (§42) ────────────────────────────────────────────

    def _require_sink(self) -> TranscriptSink:
        if self.transcript_sink is None:
            raise TranscriptionFailedError("transcript sink is not wired")
        return self.transcript_sink

    async def _abort_delivery(self) -> None:
        task = self._delivery_task
        self._delivery_task = None
        if task is not None and not task.done():
            task.cancel()
            try:
                await task
            except asyncio.CancelledError:
                LOGGER.debug("pending transcript delivery aborted")
            except Exception:
                LOGGER.debug("pending transcript delivery aborted with error")

    def _final_predicate(self, event: WatchEvent) -> bool:
        if event.kind == "output":
            return True
        if event.kind == "status" and event.snapshot is not None and event.snapshot.is_error:
            return True
        # The output may already exist if its event was dispatched before this
        # wait began; the file is unlinked at every start_recording (§42), so
        # existence always means fresh output.
        return self._paths.output_file.is_file()

    async def _deliver_final_transcript(self) -> None:
        sink = self._require_sink()
        started = self._clock()
        try:
            event = await self._watcher.wait_until(self._final_predicate, self._final_timeout)
        except WatcherClosedError as exc:
            await sink.on_transcript_error(
                TranscriptionFailedError("status watch ended", detail=str(exc))
            )
            return

        if event is None:
            await sink.on_transcript_error(
                TranscriptionTimeoutError("final transcription wait timed out")
            )
            return

        if (
            event.kind == "status"
            and event.snapshot is not None
            and not self._paths.output_file.is_file()
        ):
            # Daemon reported an error state without producing output. If the
            # output does exist (e.g. the immediate predicate check satisfied
            # the wait through the filesystem fallback), the fresh transcript
            # wins — the contract only writes output on success (§42).
            await sink.on_transcript_error(transcription_failed_from_status(event.snapshot))
            return

        try:
            result = self._read_output_once(started)
        except FileNotFoundError:
            await sink.on_transcript_error(
                TranscriptionFailedError("transcript output disappeared before read")
            )
            return
        await sink.on_transcript(result)

    def _read_output_once(self, started: float) -> TranscriptResult:
        """§42: read the newly produced output exactly once, then remove it."""
        output_path = self._paths.output_file
        raw = output_path.read_bytes()  # single read; a previous session's
        # output was removed before recording started.
        output_path.unlink(missing_ok=True)
        # §43: normalize invalid UTF-8 at the process boundary. Trimming and
        # further validation happen in the application layer (§43/§78).
        text = raw.decode("utf-8", errors="replace")
        snapshot = self._watcher.last_snapshot
        duration_ms = (self._clock() - started) * 1000.0
        return TranscriptResult(
            text=text,
            backend=snapshot.backend if snapshot is not None else None,
            transcription_duration_ms=duration_ms,
        )

    # ── CLI control (§40) ────────────────────────────────────────────────────

    async def _control(
        self,
        args: list[str],
        *,
        start_failure: type[CodedSpeechError],
    ) -> None:
        argv = [
            str(self._paths.runtime_binary),
            *args,
            "--control-socket",
            str(self._paths.control_socket),
        ]
        try:
            proc = await asyncio.create_subprocess_exec(
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

        try:
            stdout, stderr = await asyncio.wait_for(proc.communicate(), self._ack_timeout)
        except TimeoutError:
            proc.kill()
            with contextlib.suppress(ProcessLookupError):
                await proc.communicate()
            raise start_failure(
                "native runtime did not acknowledge in time",
                detail=f"timeout after {self._ack_timeout:g}s",
            ) from None

        if proc.returncode != 0:
            detail = (stderr or stdout).decode("utf-8", errors="replace").strip()
            raise start_failure(
                f"native runtime command {args[1]!r} failed",
                detail=detail[:_ERROR_DETAIL_LIMIT] or f"exit={proc.returncode}",
            )

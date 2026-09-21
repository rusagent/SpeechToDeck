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

ACK_TIMEOUT_S = 2.0
DEFAULT_FINAL_TIMEOUT_S = 120.0
STOP_TIME_FACTOR = 2.0
_STOP_CLI_GRACE_S = 5.0
_ERROR_DETAIL_LIMIT = 200

_EXIT_TRANSCRIBED = 0
_EXIT_EMPTY = 3
_EXIT_TIMEOUT = 4


def final_wait_budget(recorded_seconds: float, floor_s: float) -> float:

    return max(floor_s, recorded_seconds * STOP_TIME_FACTOR)


class VoxtypeClient:
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
        self._recording_started_at: float | None = None

    async def start(self) -> None:
        self._clear_output_artifacts()

    async def stop(self) -> None:
        await self._abort_delivery()

    async def start_recording(self) -> None:
        self._require_sink()
        self._clear_output_artifacts()
        await self._control(
            ["record", "start", f"--file={self._paths.output_file}"],
            start_failure=RecordingStartError,
        )
        self._recording_started_at = self._clock()

    async def stop_recording(self) -> None:
        self._require_sink()
        started_at = self._recording_started_at
        self._recording_started_at = None
        recorded_seconds = max(0.0, self._clock() - started_at) if started_at is not None else 0.0
        self._delivery_task = asyncio.get_running_loop().create_task(
            self._deliver_final_transcript(recorded_seconds)
        )

    async def cancel_recording(self) -> None:
        try:
            await self._control(["record", "cancel"], start_failure=RecordingStopError)
        finally:
            self._recording_started_at = None
            await self._abort_delivery()

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
            await sink.on_transcript_error(exc)
            return
        except Exception as exc:
            await sink.on_transcript_error(
                TranscriptionFailedError("stop command failed", detail=type(exc).__name__)
            )
            return

        if exit_code == _EXIT_TIMEOUT or exit_code is None:
            await sink.on_transcript_error(
                TranscriptionTimeoutError("final transcription wait timed out")
            )
            return

        if exit_code == _EXIT_EMPTY:
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
        output_path = self._paths.output_file
        raw = output_path.read_bytes()
        output_path.unlink(missing_ok=True)
        self._paths.output_sidecar_file.unlink(missing_ok=True)
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

    def _cli_argv(
        self,
        args: list[str],
        *,
        start_failure: type[CodedSpeechError],
    ) -> list[str]:

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

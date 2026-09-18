"""Speech application service (spec §33, §42-§43, §67, §71-§74).

Responsibilities (§33):

- validate session ids;
- enforce the single-session invariant (via SpeechSessionCoordinator, §34);
- coordinate the native runtime through the §32 SpeechRuntime port;
- correlate native results with versioned Decky events (§30, §67).

Transcript handling stays minimal (§43): trim, reject NUL, enforce the §78
size bound. Transcript text is never logged and never persisted (§73).
Cancellation is first-class (§72): it discards the result, removes the active
session and emits no transcript.

v0.2 additive: after a successful transcription a bounded best-effort
system-clipboard write runs through the ClipboardWriter port; its outcome
travels as the additive `transcript_ready` "clipboard" field
("ok" | "failed" | "skipped") and can never fail the transcription (§106).
"""

from __future__ import annotations

import asyncio
import logging
import re
import time
from collections.abc import Awaitable, Callable
from dataclasses import dataclass, field

from backend.domain.contracts import (
    EVENT_SPEECH_ERROR,
    EVENT_SPEECH_STATUS,
    EVENT_TRANSCRIPT_READY,
    PROTOCOL_VERSION_V1,
    ClipboardStatus,
    ClipboardWriter,
    EventPublisher,
    Settings,
    SpeechRuntime,
    TranscriptResult,
)
from backend.domain.errors import (
    ErrorCode,
    InvalidSessionIdError,
    InvalidTranscriptError,
    RecordingStartError,
    RecordingStopError,
    RuntimeCrashedError,
    RuntimeUnavailableError,
    SessionConflictError,
    SpeechError,
    TranscriptionTimeoutError,
    TranscriptTooLargeError,
)
from backend.domain.session import ActiveSpeechSession, SpeechSessionCoordinator

LOGGER = logging.getLogger("dictation.session")

ACK_TIMEOUT_S = 2.0  # §71: record start/stop acknowledgement
DEFAULT_TRANSCRIPT_GRACE_S = 30.0  # added to max recording for the final wait (§71)
MAX_TRANSCRIPT_BYTES = 16 * 1024  # §78
# Additive v0.2 clipboard write bound: the writer has its own internal
# timeout; this outer bound guarantees the transcript event is never delayed
# by more than this, whatever the writer does.
CLIPBOARD_WRITE_TIMEOUT_S = 6.0
_CLIPBOARD_STATUSES: tuple[str, ...] = ("ok", "failed", "skipped")
_SESSION_ID_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")

# Sentinel resolved into the pending-delivery future when a session ends by
# cancellation: the in-flight stop() simply returns without emitting anything.
_CANCELLED = object()


@dataclass
class _Diagnostics:
    """§74: local-only counters. Nothing here leaves the device except via
    the explicit `get_status` callable."""

    recordings_started: int = 0
    recordings_completed: int = 0
    recordings_cancelled: int = 0
    runtime_crashes: int = 0
    total_transcription_ms: float = 0.0
    last_error_code: str | None = None
    _transcriptions: int = field(default=0, repr=False)

    def note_transcription(self, duration_ms: float) -> None:
        self.total_transcription_ms += duration_ms
        self._transcriptions += 1

    @property
    def average_transcription_ms(self) -> float:
        if self._transcriptions == 0:
            return 0.0
        return self.total_transcription_ms / self._transcriptions

    def payload(self) -> dict[str, object]:
        return {
            "recordingsStarted": self.recordings_started,
            "recordingsCompleted": self.recordings_completed,
            "recordingsCancelled": self.recordings_cancelled,
            "runtimeCrashes": self.runtime_crashes,
            "averageTranscriptionMs": round(self.average_transcription_ms, 1),
            "lastErrorCode": self.last_error_code,
        }


class SpeechApplicationService:
    """Coordinates sessions, the runtime, and Decky events (§33)."""

    def __init__(
        self,
        runtime: SpeechRuntime,
        sessions: SpeechSessionCoordinator,
        publisher: EventPublisher,
        settings_provider: Callable[[], Awaitable[Settings]],
        *,
        ack_timeout: float = ACK_TIMEOUT_S,
        transcript_grace_seconds: float = DEFAULT_TRANSCRIPT_GRACE_S,
        max_transcript_bytes: int = MAX_TRANSCRIPT_BYTES,
        clock: Callable[[], float] = time.monotonic,
        clipboard_writer: ClipboardWriter | None = None,
        clipboard_timeout: float = CLIPBOARD_WRITE_TIMEOUT_S,
    ) -> None:
        self._runtime = runtime
        self._sessions = sessions
        self._publisher = publisher
        self._settings_provider = settings_provider
        self._ack_timeout = ack_timeout
        self._transcript_grace = transcript_grace_seconds
        self._max_transcript_bytes = max_transcript_bytes
        self._clock = clock
        # Additive v0.2: best-effort system-clipboard write after a
        # successful transcription. Unwired (or unavailable) → the
        # transcript_ready event reports "skipped" and the flow is unchanged.
        self._clipboard_writer = clipboard_writer
        self._clipboard_timeout = clipboard_timeout
        self._operation_lock = asyncio.Lock()
        self._pending_delivery: asyncio.Future[object] | None = None
        self._shutting_down = False
        # Sync mirrors for the supervisor's idle check and get_status; the
        # coordinator lock remains the enforcement authority.
        self._active_session_id: str | None = None
        self.counters = _Diagnostics()

    # ── §33 operations ───────────────────────────────────────────────────────

    async def start_recording(self, session_id: str) -> None:
        self._validate_session_id(session_id)
        async with self._operation_lock:
            self._ensure_accepting(session_id)
            try:
                await self._sessions.begin(session_id, self._clock())
            except SessionConflictError as exc:
                await self._publish_error(exc)
                raise
            self._active_session_id = session_id
            try:
                await asyncio.wait_for(self._runtime.start_recording(), self._ack_timeout)
            except TimeoutError:
                await self._fail(
                    RecordingStartError("start acknowledgement timed out", session_id=session_id)
                )
            except SpeechError as exc:
                if exc.session_id is None:
                    exc.session_id = session_id
                await self._fail(exc)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                await self._fail(
                    RecordingStartError(
                        "runtime failed to start recording",
                        detail=type(exc).__name__,
                        session_id=session_id,
                    )
                )
            self.counters.recordings_started += 1
            await self._publish_state("recording", session_id)

    async def stop_recording(self, session_id: str) -> None:
        self._validate_session_id(session_id)
        async with self._operation_lock:
            session = await self._require_session(session_id)
            try:
                await asyncio.wait_for(self._runtime.stop_recording(), self._ack_timeout)
            except TimeoutError:
                await self._fail(
                    RecordingStopError("stop acknowledgement timed out", session_id=session_id)
                )
            except SpeechError as exc:
                if exc.session_id is None:
                    exc.session_id = session_id
                await self._fail(exc)
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                await self._fail(
                    RecordingStopError(
                        "runtime failed to stop recording",
                        detail=type(exc).__name__,
                        session_id=session_id,
                    )
                )
            stop_monotonic = self._clock()
            pending: asyncio.Future[object] = asyncio.get_running_loop().create_future()
            self._pending_delivery = pending
            await self._publish_state("transcribing", session_id)

        # Wait outside the operation lock so cancellation can interject (§72).
        active = await self._sessions.active()
        if active is None:
            return  # cancelled meanwhile; cancel flow owns the outcome
        try:
            outcome = await asyncio.wait_for(
                asyncio.shield(pending), await self._transcription_timeout()
            )
        except TimeoutError:
            pending.cancel()
            await self._fail(
                TranscriptionTimeoutError(
                    "final transcription did not arrive in time", session_id=session_id
                )
            )
        finally:
            if self._pending_delivery is pending:
                self._pending_delivery = None

        if isinstance(outcome, SpeechError):
            await self._fail(outcome)
        if outcome is _CANCELLED:
            return
        assert isinstance(outcome, TranscriptResult)
        await self._emit_transcript(session, stop_monotonic, outcome)

    async def cancel_recording(self, session_id: str) -> None:
        self._validate_session_id(session_id)
        async with self._operation_lock:
            await self._require_session(session_id)
            pending = self._pending_delivery
            try:
                await asyncio.wait_for(self._runtime.cancel_recording(), self._ack_timeout)
            except TimeoutError:
                await self._abandon(session_id, pending)
                error = RecordingStopError(
                    "cancel acknowledgement timed out", session_id=session_id
                )
                await self._publish_error(error)
                raise error from None
            except SpeechError as exc:
                await self._abandon(session_id, pending)
                if exc.session_id is None:
                    exc.session_id = session_id
                await self._publish_error(exc)
                raise
            except asyncio.CancelledError:
                raise
            except Exception as exc:
                await self._abandon(session_id, pending)
                error = RecordingStopError(
                    "runtime failed to cancel recording",
                    detail=type(exc).__name__,
                    session_id=session_id,
                )
                await self._publish_error(error)
                raise error from exc
            await self._abandon(session_id, pending)
            self.counters.recordings_cancelled += 1
            # §72: no transcript, no clipboard, no insertion — just state.
            await self._publish_state("ready", session_id=None)

    # ── TranscriptSink (§42): native results arrive here ────────────────────

    async def on_transcript(self, result: TranscriptResult) -> None:
        pending = self._pending_delivery
        if pending is None or pending.done():
            # A result without a waiting stop() is stale (§42: never reused).
            LOGGER.info("discarding transcript delivered outside an active stop")
            return
        if not pending.done():
            pending.set_result(result)

    async def on_transcript_error(self, error: SpeechError) -> None:
        pending = self._pending_delivery
        if pending is None or pending.done():
            LOGGER.info("discarding runtime error without a waiting stop: %s", error.code)
            return
        if not pending.done():
            pending.set_result(error)

    # ── lifecycle / supervision hooks ────────────────────────────────────────

    async def notify_runtime_lost(self, exit_code: int | None) -> None:
        """Supervisor callback: the daemon exited unexpectedly (§69)."""
        self.counters.runtime_crashes += 1
        self.counters.last_error_code = str(ErrorCode.RUNTIME_CRASHED)
        session = await self._sessions.clear()
        error = RuntimeCrashedError(
            "native runtime exited unexpectedly",
            detail=f"exit={exit_code}" if exit_code is not None else None,
            session_id=session.session_id if session else None,
        )
        pending = self._pending_delivery
        if pending is not None and not pending.done():
            pending.set_result(error)
        elif session is not None:
            await self._publish_error(error)
        self._active_session_id = None

    async def shutdown(self) -> None:
        """Stop accepting sessions: drop the session, silence deliveries.

        Terminal at plugin teardown (§83); after a settings-driven disable
        (§36) `resume` re-enables session acceptance.
        """
        self._shutting_down = True
        pending = self._pending_delivery
        if pending is not None and not pending.done():
            pending.set_result(_CANCELLED)
        await self._sessions.clear()
        self._active_session_id = None

    def resume(self) -> None:
        """Re-accept sessions after `shutdown` (§36: dictation re-enabled)."""
        self._shutting_down = False

    def has_pending_work(self) -> bool:
        """True while a session or a transcript delivery is outstanding."""
        return self._active_session_id is not None or self._pending_delivery is not None

    def get_status(self) -> dict[str, object]:
        state = "recording" if self._active_session_id is not None else "ready"
        payload: dict[str, object] = {
            "protocolVersion": PROTOCOL_VERSION_V1,
            "state": state,
            "activeSessionId": self._active_session_id,
            "counters": self.counters.payload(),
        }
        return payload

    # ── internals ────────────────────────────────────────────────────────────

    @staticmethod
    def _validate_session_id(session_id: str) -> None:
        if not isinstance(session_id, str) or _SESSION_ID_RE.fullmatch(session_id) is None:
            raise InvalidSessionIdError("session id has an invalid format")

    def _ensure_accepting(self, session_id: str) -> None:
        if self._shutting_down:
            raise RuntimeUnavailableError("plugin is shutting down", session_id=session_id)

    async def _require_session(self, session_id: str) -> ActiveSpeechSession:
        try:
            return await self._sessions.require(session_id)
        except SpeechError as exc:
            await self._publish_error(exc)
            raise

    async def _abandon(self, session_id: str, pending: asyncio.Future[object] | None) -> None:
        await self._sessions.clear(session_id)
        if pending is not None and not pending.done():
            pending.set_result(_CANCELLED)
        if self._pending_delivery is pending:
            self._pending_delivery = None
        self._active_session_id = None

    async def _publish_state(self, state: str, session_id: str | None = None) -> None:
        payload: dict[str, object] = {
            "protocolVersion": PROTOCOL_VERSION_V1,
            "state": state,
        }
        if session_id is not None:
            payload["sessionId"] = session_id
        await self._publisher.publish(EVENT_SPEECH_STATUS, payload)

    async def _publish_error(self, error: SpeechError) -> None:
        await self._publisher.publish(EVENT_SPEECH_ERROR, error.payload())

    async def _fail(self, error: SpeechError) -> None:
        """Single failure funnel (§69): clear state, publish, raise."""
        if error.session_id is not None:
            await self._sessions.clear(error.session_id)
        else:
            await self._sessions.clear()
        if self._pending_delivery is not None and not self._pending_delivery.done():
            self._pending_delivery.set_result(_CANCELLED)
        self._pending_delivery = None
        self._active_session_id = None
        self.counters.last_error_code = str(error.code)
        await self._publish_error(error)
        raise error

    async def _emit_transcript(
        self,
        session: ActiveSpeechSession,
        stop_monotonic: float,
        result: TranscriptResult,
    ) -> None:
        # §43 normalization: trim only. NUL and size are hard rejections (§78).
        text = result.text.strip()
        if not text:
            # §77 empty-speech path: the runtime itself reported empty (the
            # client delivers exit 3 as an empty result). Return to ready
            # with no transcript, no insertion and no error.
            await self._sessions.clear(session.session_id)
            self._active_session_id = None
            self.counters.recordings_completed += 1
            self.counters.note_transcription(max(0.0, (self._clock() - stop_monotonic) * 1000.0))
            await self._publish_state("ready", session_id=None)
            return
        if "\0" in text:
            await self._fail(
                InvalidTranscriptError(
                    "transcript contains NUL characters", session_id=session.session_id
                )
            )
        if len(text.encode("utf-8")) > self._max_transcript_bytes:
            await self._fail(
                TranscriptTooLargeError(
                    "transcript exceeds the maximum size", session_id=session.session_id
                )
            )

        settings = await self._settings_provider()
        audio_ms = result.audio_duration_ms
        if audio_ms is None:
            audio_ms = max(0.0, (stop_monotonic - session.started_monotonic) * 1000.0)
        transcription_ms = result.transcription_duration_ms
        if transcription_ms is None:
            transcription_ms = max(0.0, (self._clock() - stop_monotonic) * 1000.0)
        # §67 freezes metrics.computeBackend to "cpu" | "vulkan": prefer the
        # daemon-reported backend, then the explicit setting; "auto" resolves
        # to the runtime's baseline "cpu" when the daemon under-reports.
        backend = (
            result.backend
            if result.backend in ("cpu", "vulkan")
            else (
                settings.compute_backend if settings.compute_backend in ("cpu", "vulkan") else "cpu"
            )
        )

        payload: dict[str, object] = {
            "protocolVersion": PROTOCOL_VERSION_V1,
            "sessionId": session.session_id,
            "text": text,
            "metrics": {
                "audioDurationMs": round(audio_ms, 1),
                "transcriptionDurationMs": round(transcription_ms, 1),
                "modelId": settings.model_id,
                "computeBackend": backend,
            },
        }
        # Additive v0.2 (§67 optional field): best-effort system-clipboard
        # write BEFORE the event so the payload carries the honest outcome.
        # Contained (§106): a clipboard failure is reported, never raised —
        # the transcription itself has already succeeded.
        payload["clipboard"] = await self._copy_transcript_to_clipboard(text)
        await self._sessions.clear(session.session_id)
        self._active_session_id = None
        self.counters.recordings_completed += 1
        self.counters.note_transcription(transcription_ms)
        await self._publisher.publish(EVENT_TRANSCRIPT_READY, payload)
        await self._publish_state("ready", session_id=None)

    async def _copy_transcript_to_clipboard(self, text: str) -> ClipboardStatus:
        """Bounded, contained system-clipboard write (v0.2, additive).

        "skipped" without a wired writer; the writer maps its own failure
        modes to statuses, and anything unexpected (raise, hang past the
        outer bound) degrades to "failed". The text is handed to the writer
        only — never logged (§73).
        """
        writer = self._clipboard_writer
        if writer is None:
            return "skipped"
        try:
            status = await asyncio.wait_for(writer.write_text(text), self._clipboard_timeout)
        except asyncio.CancelledError:
            raise
        except BaseException:
            LOGGER.warning("clipboard write crashed; reported as failed")
            return "failed"
        if status not in _CLIPBOARD_STATUSES:
            return "failed"
        return status

    async def _transcription_timeout(self) -> float:
        """§71: final transcription bounded by max-recording/model policy."""
        settings = await self._settings_provider()
        return settings.max_recording_seconds + self._transcript_grace

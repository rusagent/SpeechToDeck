"""SpeechApplicationService tests (spec §33, §42-§43, §67, §71-§74).

Uses the §91 FakeSpeechRuntime: deterministic, no hardware.
"""

from __future__ import annotations

import asyncio
import dataclasses

import pytest
from backend.application.speech_service import SpeechApplicationService
from backend.domain.contracts import DEFAULT_SETTINGS, ClipboardStatus, Settings
from backend.domain.errors import (
    InvalidSessionIdError,
    InvalidTranscriptError,
    RecordingStopError,
    RuntimeCrashedError,
    SessionConflictError,
    StaleSessionError,
    TranscriptionTimeoutError,
    TranscriptTooLargeError,
)
from backend.domain.session import SpeechSessionCoordinator
from conftest import FakeEventPublisher, FakeSpeechRuntime

EVENTS = "speech_status"
READY = "transcript_ready"
ERROR = "speech_error"


class FakeClipboardWriter:
    """ClipboardWriter double recording the handed-over text (§73 oracle:
    the writer must receive the NORMALIZED transcript, never the raw one)."""

    def __init__(
        self,
        status: ClipboardStatus = "ok",
        *,
        error: BaseException | None = None,
        hang_s: float = 0.0,
    ) -> None:
        self.status = status
        self.error = error
        self.hang_s = hang_s
        self.texts: list[str] = []

    def is_available(self) -> bool:
        return True

    async def write_text(self, text: str) -> ClipboardStatus:
        self.texts.append(text)
        if self.error is not None:
            raise self.error
        if self.hang_s:
            await asyncio.sleep(self.hang_s)
        return self.status


class Harness:
    def __init__(self, settings: Settings | None = None, **kwargs: object) -> None:
        self.publisher = FakeEventPublisher()
        self.runtime = FakeSpeechRuntime()
        self.current_settings = settings or DEFAULT_SETTINGS
        grace = kwargs.pop("transcript_grace_seconds", 30.0)
        self.service = SpeechApplicationService(
            self.runtime,
            SpeechSessionCoordinator(),
            self.publisher,
            self._settings_provider,
            transcript_grace_seconds=grace,
            **kwargs,
        )
        self.runtime.sink = self.service

    async def _settings_provider(self) -> Settings:
        return self.current_settings


def test_happy_stop_emits_correlated_transcript_ready() -> None:
    async def scenario() -> None:
        harness = Harness()
        await harness.service.start_recording("session-1")
        assert "start_recording" in harness.runtime.calls

        stop_task = asyncio.get_running_loop().create_task(
            harness.service.stop_recording("session-1")
        )
        await asyncio.sleep(0.05)
        await harness.runtime.emit_transcript("  hello world  ")
        await asyncio.wait_for(stop_task, 2.0)

        ready = harness.publisher.payloads(READY)
        assert len(ready) == 1
        payload = ready[0]
        assert payload["protocolVersion"] == 1
        assert payload["sessionId"] == "session-1"
        assert payload["text"] == "hello world"  # §43: trimmed only
        metrics = payload["metrics"]
        assert metrics["audioDurationMs"] == 1234.0
        assert metrics["transcriptionDurationMs"] == 42.0
        assert metrics["modelId"] == "base"
        assert metrics["computeBackend"] == "cpu"

        states = [p["state"] for p in harness.publisher.payloads(EVENTS)]
        assert states == ["recording", "transcribing", "ready"]
        status = harness.service.get_status()
        assert status["counters"]["recordingsStarted"] == 1
        assert status["counters"]["recordingsCompleted"] == 1
        assert not harness.service.has_pending_work()

    asyncio.run(scenario())


def test_duplicate_start_conflicts_and_session_survives() -> None:
    async def scenario() -> None:
        harness = Harness()
        await harness.service.start_recording("session-1")
        with pytest.raises(SessionConflictError):
            await harness.service.start_recording("session-2")
        assert harness.publisher.codes(ERROR) == ["SESSION_CONFLICT"]
        # Original session is still the one active session (§10).
        status = harness.service.get_status()
        assert status["activeSessionId"] == "session-1"

    asyncio.run(scenario())


def test_stale_stop_and_cancel_are_rejected() -> None:
    async def scenario() -> None:
        harness = Harness()
        with pytest.raises(StaleSessionError):
            await harness.service.stop_recording("ghost")
        with pytest.raises(StaleSessionError):
            await harness.service.cancel_recording("ghost")
        await harness.service.start_recording("session-1")
        with pytest.raises(StaleSessionError):
            await harness.service.stop_recording("session-2")
        assert harness.publisher.codes(ERROR).count("STALE_SESSION") == 3

    asyncio.run(scenario())


def test_invalid_session_id_rejected_before_runtime() -> None:
    async def scenario() -> None:
        harness = Harness()
        for bad in ("", "has space", "../traversal", "x" * 200, "new\nline"):
            with pytest.raises(InvalidSessionIdError):
                await harness.service.start_recording(bad)
        assert harness.runtime.calls == []  # never reached the runtime

    asyncio.run(scenario())


def test_cancel_discards_result_and_emits_no_transcript() -> None:
    async def scenario() -> None:
        harness = Harness()
        await harness.service.start_recording("session-1")

        stop_wait = asyncio.get_running_loop().create_task(
            harness.service.stop_recording("session-1")
        )
        await asyncio.sleep(0.05)
        await harness.service.cancel_recording("session-1")
        await asyncio.wait_for(stop_wait, 2.0)

        # §72: cancellation removes the session, emits no transcript.
        assert harness.publisher.payloads(READY) == []
        assert "cancel_recording" in harness.runtime.calls
        states = [p["state"] for p in harness.publisher.payloads(EVENTS)]
        assert states[-1] == "ready"
        assert harness.service.get_status()["counters"]["recordingsCancelled"] == 1

    asyncio.run(scenario())


def test_cancel_without_session_is_stale() -> None:
    async def scenario() -> None:
        harness = Harness()
        with pytest.raises(StaleSessionError):
            await harness.service.cancel_recording("ghost")

    asyncio.run(scenario())


def test_nul_transcript_rejected() -> None:
    async def scenario() -> None:
        harness = Harness()
        await harness.service.start_recording("session-1")
        stop_task = asyncio.get_running_loop().create_task(
            harness.service.stop_recording("session-1")
        )
        await asyncio.sleep(0.05)
        await harness.runtime.emit_transcript("bad\0text")
        with pytest.raises(InvalidTranscriptError):
            await asyncio.wait_for(stop_task, 2.0)
        assert harness.publisher.payloads(READY) == []
        assert harness.publisher.codes(ERROR) == ["INVALID_TRANSCRIPT"]
        assert not harness.service.has_pending_work()  # session cleaned up (§69)

    asyncio.run(scenario())


def test_oversized_transcript_rejected() -> None:
    async def scenario() -> None:
        harness = Harness()
        await harness.service.start_recording("session-1")
        stop_task = asyncio.get_running_loop().create_task(
            harness.service.stop_recording("session-1")
        )
        await asyncio.sleep(0.05)
        await harness.runtime.emit_transcript("x" * (16 * 1024 + 1))
        with pytest.raises(TranscriptTooLargeError):
            await asyncio.wait_for(stop_task, 2.0)
        assert harness.publisher.payloads(READY) == []
        assert harness.publisher.codes(ERROR) == ["TRANSCRIPT_TOO_LARGE"]

    asyncio.run(scenario())


def test_empty_transcript_is_not_an_error() -> None:
    async def scenario() -> None:
        harness = Harness()
        await harness.service.start_recording("session-1")
        stop_task = asyncio.get_running_loop().create_task(
            harness.service.stop_recording("session-1")
        )
        await asyncio.sleep(0.05)
        # The real runtime reports empty speech as an empty result (client
        # maps the `record stop --wait` exit 3 outcome).
        await harness.runtime.emit_transcript("   ")
        await asyncio.wait_for(stop_task, 2.0)
        # §77: no transcript, no insertion, no error. The EMPTY
        # `transcript_ready` event is still the outcome channel the frontend
        # machine consumes to leave the stop flow — it never subscribes to
        # `speech_status`, and without the event the §8 machine wedged in
        # `transcribing` and locked the mic button (on-device deck
        # 2026-09-18, owner: "nichts gesagt → locked").
        ready = harness.publisher.payloads(READY)
        assert len(ready) == 1
        assert ready[0]["text"] == ""
        assert ready[0]["sessionId"] == "session-1"
        assert ready[0]["clipboard"] == "skipped"
        assert harness.publisher.payloads(ERROR) == []
        states = [p["state"] for p in harness.publisher.payloads(EVENTS)]
        assert states == ["recording", "transcribing", "ready"]
        status = harness.service.get_status()
        assert status["counters"]["recordingsCompleted"] == 1
        assert not harness.service.has_pending_work()

    asyncio.run(scenario())


def test_stop_acknowledgement_timeout_clears_session() -> None:
    async def scenario() -> None:
        harness = Harness(ack_timeout=0.15)
        harness.runtime.stop_hangs = True
        await harness.service.start_recording("session-1")
        with pytest.raises(RecordingStopError):
            await harness.service.stop_recording("session-1")
        assert harness.publisher.codes(ERROR) == ["RECORDING_STOP_FAILED"]
        # §69: cleanup happened; a new session can start immediately.
        harness.runtime.stop_hangs = False
        await harness.service.start_recording("session-2")
        await harness.service.cancel_recording("session-2")

    asyncio.run(scenario())


def test_final_transcription_timeout() -> None:
    async def scenario() -> None:
        # Small max-recording so the bounded §71 wait (max-recording + grace)
        # stays fast; the timeout mapping is identical at any duration.
        settings = dataclasses.replace(DEFAULT_SETTINGS, max_recording_seconds=2)
        harness = Harness(settings=settings, transcript_grace_seconds=0.1)
        await harness.service.start_recording("session-1")
        with pytest.raises(TranscriptionTimeoutError):
            await harness.service.stop_recording("session-1")  # nothing ever emitted
        assert harness.publisher.codes(ERROR) == ["TRANSCRIPTION_TIMEOUT"]
        assert not harness.service.has_pending_work()

    asyncio.run(scenario())


def test_runtime_crash_while_recording_notifies_and_clears() -> None:
    async def scenario() -> None:
        harness = Harness()
        await harness.service.start_recording("session-1")
        await harness.service.notify_runtime_lost(3)
        errors = harness.publisher.payloads(ERROR)
        assert len(errors) == 1
        assert errors[0]["code"] == "RUNTIME_CRASHED"
        assert errors[0]["sessionId"] == "session-1"
        assert not harness.service.has_pending_work()
        with pytest.raises(StaleSessionError):
            await harness.service.stop_recording("session-1")
        assert harness.service.get_status()["counters"]["runtimeCrashes"] == 1

    asyncio.run(scenario())


def test_runtime_crash_during_transcription_wait_supersedes_stop() -> None:
    async def scenario() -> None:
        harness = Harness()
        await harness.service.start_recording("session-1")
        stop_task = asyncio.get_running_loop().create_task(
            harness.service.stop_recording("session-1")
        )
        await asyncio.sleep(0.05)
        await harness.service.notify_runtime_lost(None)
        with pytest.raises(RuntimeCrashedError):
            await asyncio.wait_for(stop_task, 2.0)
        # Exactly one speech_error for the crash (published via the stop path).
        assert harness.publisher.codes(ERROR) == ["RUNTIME_CRASHED"]

    asyncio.run(scenario())


def test_transcript_without_waiting_stop_is_discarded() -> None:
    async def scenario() -> None:
        harness = Harness()
        await harness.service.start_recording("session-1")
        # §42: a result arriving outside an active stop must never surface.
        await harness.runtime.emit_transcript("stale words")
        await harness.service.cancel_recording("session-1")
        assert harness.publisher.payloads(READY) == []

    asyncio.run(scenario())


# ── v0.2 additive clipboard leg (transcript_ready "clipboard" field) ────────


def _run_transcript_scenario(harness: Harness, text: str = "  hello world  ") -> None:
    async def scenario() -> None:
        await harness.service.start_recording("session-1")
        stop_task = asyncio.get_running_loop().create_task(
            harness.service.stop_recording("session-1")
        )
        await asyncio.sleep(0.05)
        await harness.runtime.emit_transcript(text)
        await asyncio.wait_for(stop_task, 2.0)

    asyncio.run(scenario())


def test_clipboard_ok_travels_in_transcript_ready() -> None:
    writer = FakeClipboardWriter("ok")
    harness = Harness(clipboard_writer=writer)
    _run_transcript_scenario(harness)

    ready = harness.publisher.payloads(READY)
    assert len(ready) == 1
    assert ready[0]["clipboard"] == "ok"
    # The writer received the §43-normalized text, never the raw payload.
    assert writer.texts == ["hello world"]
    # The dictation flow is otherwise unchanged.
    states = [p["state"] for p in harness.publisher.payloads(EVENTS)]
    assert states == ["recording", "transcribing", "ready"]


def test_clipboard_writer_crash_never_fails_the_transcription() -> None:
    writer = FakeClipboardWriter("ok", error=RuntimeError("loader socket gone"))
    harness = Harness(clipboard_writer=writer)
    _run_transcript_scenario(harness)

    ready = harness.publisher.payloads(READY)
    assert len(ready) == 1
    assert ready[0]["clipboard"] == "failed"  # contained (§106), reported
    assert ready[0]["text"] == "hello world"  # the transcript still delivered
    states = [p["state"] for p in harness.publisher.payloads(EVENTS)]
    assert states == ["recording", "transcribing", "ready"]
    assert harness.publisher.payloads(ERROR) == []


def test_clipboard_timeout_maps_to_failed() -> None:
    writer = FakeClipboardWriter("ok", hang_s=5.0)
    harness = Harness(clipboard_writer=writer, clipboard_timeout=0.05)
    _run_transcript_scenario(harness)

    ready = harness.publisher.payloads(READY)
    assert ready[0]["clipboard"] == "failed"
    assert ready[0]["text"] == "hello world"


def test_unavailable_writer_reports_skipped() -> None:
    writer = FakeClipboardWriter("skipped")
    harness = Harness(clipboard_writer=writer)
    _run_transcript_scenario(harness)
    assert harness.publisher.payloads(READY)[0]["clipboard"] == "skipped"


def test_unwired_clipboard_reports_skipped_and_changes_nothing_else() -> None:
    # Default (no writer wired): the frozen transcript_ready core is intact,
    # only the additive field reports the skipped backend leg.
    harness = Harness()
    _run_transcript_scenario(harness)

    ready = harness.publisher.payloads(READY)
    assert len(ready) == 1
    assert ready[0]["clipboard"] == "skipped"
    payload = dict(ready[0])
    payload.pop("clipboard")
    assert set(payload) == {"protocolVersion", "sessionId", "text", "metrics"}


def test_empty_transcript_writes_no_clipboard() -> None:
    writer = FakeClipboardWriter("ok")
    harness = Harness(clipboard_writer=writer)
    _run_transcript_scenario(harness, text="   ")  # §77 empty-speech path

    assert writer.texts == []  # nothing copied
    # The empty outcome event still travels (the frontend machine consumes
    # it to leave the stop flow; deck 2026-09-18 lock finding) — but the
    # clipboard leg is skipped, never attempted with empty text.
    ready = harness.publisher.payloads(READY)
    assert len(ready) == 1
    assert ready[0]["text"] == ""
    assert ready[0]["clipboard"] == "skipped"
    states = [p["state"] for p in harness.publisher.payloads(EVENTS)]
    assert states == ["recording", "transcribing", "ready"]

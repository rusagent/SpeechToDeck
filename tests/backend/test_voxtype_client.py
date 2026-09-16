"""VoxtypeClient tests (spec §40, §42, §71) against the real fixture daemon."""

from __future__ import annotations

import asyncio
import json
import os

import pytest
from backend.domain.errors import (
    RecordingStartError,
    RecordingStopError,
)
from backend.infrastructure.process.status_monitor import StatusFileWatcher
from backend.infrastructure.process.voxtype_client import VoxtypeClient
from conftest import (
    SinkCollector,
    build_fixture_binary,
    make_paths,
    spawn_fixture_daemon,
    stop_process_group,
)


def test_record_roundtrip_reads_output_exactly_once(tmp_path: object) -> None:
    async def scenario() -> None:
        paths = make_paths(tmp_path)  # type: ignore[arg-type]
        binary = build_fixture_binary(paths.plugin_root)
        proc = await spawn_fixture_daemon(paths, binary)
        watcher = StatusFileWatcher(paths.runtime_dir)
        sink = SinkCollector()
        client = VoxtypeClient(paths, watcher, final_transcript_timeout=3.0)
        client.transcript_sink = sink
        try:
            # Stale output from a previous session is removed at start (§42).
            paths.output_file.write_text("STALE PREVIOUS TRANSCRIPT", encoding="utf-8")

            await client.start_recording()
            assert not paths.output_file.exists()

            await client.stop_recording()
            assert await sink.wait_delivery(3.0)

            assert len(sink.results) == 1
            result = sink.results[0]
            assert result.text == "hello world"
            assert result.backend == "cpu"
            assert result.transcription_duration_ms is not None
            # Exactly once: the output file is removed after the single read.
            assert not paths.output_file.exists()
            assert sink.errors == []
        finally:
            await client.stop()
            watcher.close()
            await stop_process_group(proc)

    asyncio.run(scenario())  # type: ignore[arg-type]


def test_start_acknowledgement_timeout(tmp_path: object) -> None:
    async def scenario() -> None:
        paths = make_paths(tmp_path)  # type: ignore[arg-type]
        binary = build_fixture_binary(paths.plugin_root)
        proc = await spawn_fixture_daemon(paths, binary, ack_sleep="3")
        watcher = StatusFileWatcher(paths.runtime_dir)
        sink = SinkCollector()
        client = VoxtypeClient(paths, watcher, ack_timeout=0.3)
        client.transcript_sink = sink
        try:
            with pytest.raises(RecordingStartError) as excinfo:
                await client.start_recording()
            assert "acknowledge" in excinfo.value.message
            assert sink.results == []
        finally:
            await client.stop()
            watcher.close()
            await stop_process_group(proc)

    asyncio.run(scenario())  # type: ignore[arg-type]


def test_start_fails_without_daemon(tmp_path: object) -> None:
    async def scenario() -> None:
        paths = make_paths(tmp_path)  # type: ignore[arg-type]
        build_fixture_binary(paths.plugin_root)  # binary exists; no daemon runs
        watcher = StatusFileWatcher(paths.runtime_dir)
        sink = SinkCollector()
        client = VoxtypeClient(paths, watcher, ack_timeout=0.5)
        client.transcript_sink = sink
        try:
            with pytest.raises(RecordingStartError):
                await client.start_recording()
            assert sink.results == []
        finally:
            await client.stop()
            watcher.close()

    asyncio.run(scenario())  # type: ignore[arg-type]


def test_stop_acknowledgement_timeout(tmp_path: object) -> None:
    async def scenario() -> None:
        paths = make_paths(tmp_path)  # type: ignore[arg-type]
        binary = build_fixture_binary(paths.plugin_root)
        proc = await spawn_fixture_daemon(paths, binary, stop_ack_sleep="3")
        watcher = StatusFileWatcher(paths.runtime_dir)
        sink = SinkCollector()
        client = VoxtypeClient(paths, watcher, ack_timeout=0.3, final_transcript_timeout=1.0)
        client.transcript_sink = sink
        try:
            await client.start_recording()
            with pytest.raises(RecordingStopError) as excinfo:
                await client.stop_recording()
            assert "acknowledge" in excinfo.value.message
            assert sink.results == [] and sink.errors == []
        finally:
            await client.stop()
            watcher.close()
            await stop_process_group(proc)

    asyncio.run(scenario())  # type: ignore[arg-type]


def test_transcription_timeout_when_daemon_hangs(tmp_path: object) -> None:
    async def scenario() -> None:
        paths = make_paths(tmp_path)  # type: ignore[arg-type]
        binary = build_fixture_binary(paths.plugin_root)
        proc = await spawn_fixture_daemon(paths, binary, hang_transcription=True)
        watcher = StatusFileWatcher(paths.runtime_dir)
        sink = SinkCollector()
        client = VoxtypeClient(paths, watcher, final_transcript_timeout=0.4)
        client.transcript_sink = sink
        try:
            await client.start_recording()
            await client.stop_recording()
            assert await sink.wait_delivery(2.0)
            assert len(sink.errors) == 1
            assert str(sink.errors[0].code) == "TRANSCRIPTION_TIMEOUT"
            assert sink.results == []
        finally:
            await client.stop()
            watcher.close()
            await stop_process_group(proc)

    asyncio.run(scenario())  # type: ignore[arg-type]


def test_cancel_discards_pending_result(tmp_path: object) -> None:
    async def scenario() -> None:
        paths = make_paths(tmp_path)  # type: ignore[arg-type]
        binary = build_fixture_binary(paths.plugin_root)
        proc = await spawn_fixture_daemon(paths, binary, transcribe_delay="1.5")
        watcher = StatusFileWatcher(paths.runtime_dir)
        sink = SinkCollector()
        client = VoxtypeClient(paths, watcher, final_transcript_timeout=3.0)
        client.transcript_sink = sink
        try:
            await client.start_recording()
            await client.cancel_recording()  # §72: aborts pending delivery
            await asyncio.sleep(0.1)
            assert sink.results == [] and sink.errors == []
        finally:
            await client.stop()
            watcher.close()
            await stop_process_group(proc)

    asyncio.run(scenario())  # type: ignore[arg-type]


def test_output_already_present_when_wait_begins_is_delivered(tmp_path: object) -> None:
    """Regression: fresh output that exists before the delivery wait registers
    must be read, not misclassified via the last status event (§42)."""

    async def scenario() -> None:
        paths = make_paths(tmp_path)  # type: ignore[arg-type]
        build_fixture_binary(paths.plugin_root)
        # A valid status file at watch start gives the watcher a last-known
        # status ("idle") — the exact pre-state of the delivery race.
        paths.status_file.write_text(
            json.dumps({"protocolVersion": 1, "state": "idle", "backend": "cpu"}),
            encoding="utf-8",
        )
        watcher = StatusFileWatcher(paths.runtime_dir)
        sink = SinkCollector()
        client = VoxtypeClient(paths, watcher, final_transcript_timeout=1.0)
        client.transcript_sink = sink
        try:
            await client.start()  # watcher live; last status becomes "idle"
            await asyncio.sleep(0.1)
            # Simulate a daemon that finished transcribing before the client's
            # delivery wait began: fresh output on disk, last status "idle".
            tmp = paths.output_file.with_suffix(".tmp")
            tmp.write_text("early final words", encoding="utf-8")
            os.replace(tmp, paths.output_file)

            await client._deliver_final_transcript()  # private API: deterministic race unit

            assert len(sink.results) == 1
            assert sink.results[0].text == "early final words"
            assert sink.errors == []
            assert not paths.output_file.exists()  # read exactly once (§42)
        finally:
            await client.stop()
            watcher.close()

    asyncio.run(scenario())  # type: ignore[arg-type]


def test_malformed_status_does_not_break_delivery(tmp_path: object) -> None:
    async def scenario() -> None:
        paths = make_paths(tmp_path)  # type: ignore[arg-type]
        binary = build_fixture_binary(paths.plugin_root)
        proc = await spawn_fixture_daemon(paths, binary)
        watcher = StatusFileWatcher(paths.runtime_dir)
        sink = SinkCollector()
        client = VoxtypeClient(paths, watcher, final_transcript_timeout=3.0)
        client.transcript_sink = sink
        try:
            await client.start_recording()
            await client.stop_recording()
            # Corrupt the status channel mid-transcription; the §42 wait is
            # event-driven on the output file and must still succeed.
            await asyncio.sleep(0.02)
            paths.status_file.write_text("garbage{{{", encoding="utf-8")
            assert await sink.wait_delivery(3.0)
            assert len(sink.results) == 1
            assert sink.results[0].text == "hello world"
        finally:
            await client.stop()
            watcher.close()
            await stop_process_group(proc)

    asyncio.run(scenario())  # type: ignore[arg-type]

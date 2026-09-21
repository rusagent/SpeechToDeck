from __future__ import annotations

import asyncio
import os

import pytest
from backend.infrastructure.process.status_monitor import (
    RuntimeStatusMonitor,
    StatusFileWatcher,
    WatcherClosedError,
    parse_status_word,
)
from conftest import FakeEventPublisher, make_paths, wait_until


def write_status_file(paths: object, word: str) -> None:
    paths.runtime_dir.mkdir(parents=True, exist_ok=True)
    paths.native_runtime_dir.mkdir(parents=True, exist_ok=True)
    paths.status_file.write_text(word, encoding="utf-8")


def test_parse_status_word_valid_and_malformed() -> None:
    for word in ("idle", "recording", "streaming", "transcribing", " idle\n"):
        snapshot = parse_status_word(word)
        assert snapshot is not None
    assert parse_status_word(b"recording").state == "recording"
    for bad in (b'{"state": "idle"}', b"", b"stopped", b"warp-drive", "error"):
        assert parse_status_word(bad) is None


def test_monitor_emits_typed_events_and_survives_malformed_status(tmp_path: object) -> None:
    async def scenario() -> None:
        paths = make_paths(tmp_path)
        write_status_file(paths, "idle")
        publisher = FakeEventPublisher()
        watcher = StatusFileWatcher(paths.native_runtime_dir)
        monitor = RuntimeStatusMonitor(watcher, publisher)
        try:
            await monitor.start()
            assert await wait_until(
                lambda: any(p.get("state") == "idle" for p in publisher.payloads("runtime_status")),
                timeout=2.0,
            )

            write_status_file(paths, "recording")
            assert await wait_until(
                lambda: any(
                    p.get("state") == "recording" for p in publisher.payloads("runtime_status")
                ),
                timeout=2.0,
            )

            paths.status_file.write_text("garbage-not-a-word{{{", encoding="utf-8")
            assert await wait_until(
                lambda: any(
                    p.get("malformedPayload") is True for p in publisher.payloads("runtime_status")
                ),
                timeout=2.0,
            )

            write_status_file(paths, "transcribing")
            assert await wait_until(
                lambda: any(
                    p.get("state") == "transcribing" for p in publisher.payloads("runtime_status")
                ),
                timeout=2.0,
            )
            assert monitor.last_state == "transcribing"
            assert monitor.malformed_payloads >= 1
        finally:
            await monitor.stop()
            watcher.close()

    asyncio.run(scenario())


def test_streaming_state_maps_to_recording(tmp_path: object) -> None:

    async def scenario() -> None:
        paths = make_paths(tmp_path)
        publisher = FakeEventPublisher()
        watcher = StatusFileWatcher(paths.native_runtime_dir)
        monitor = RuntimeStatusMonitor(watcher, publisher)
        try:
            await monitor.start()
            write_status_file(paths, "streaming")
            assert await wait_until(
                lambda: any(
                    p.get("state") == "recording" and p.get("malformedPayload") is False
                    for p in publisher.payloads("runtime_status")
                ),
                timeout=2.0,
            )
        finally:
            await monitor.stop()
            watcher.close()

    asyncio.run(scenario())


def test_missing_state_file_is_synthesized_as_stopped(tmp_path: object) -> None:
    async def scenario() -> None:
        paths = make_paths(tmp_path)
        publisher = FakeEventPublisher()
        watcher = StatusFileWatcher(paths.native_runtime_dir)
        monitor = RuntimeStatusMonitor(watcher, publisher)
        try:
            await monitor.start()
            assert await wait_until(
                lambda: any(
                    p.get("state") == "stopped" and p.get("available") is False
                    for p in publisher.payloads("runtime_status")
                ),
                timeout=2.0,
            )

            write_status_file(paths, "recording")
            assert await wait_until(
                lambda: any(
                    p.get("state") == "recording" for p in publisher.payloads("runtime_status")
                ),
                timeout=2.0,
            )
            os.unlink(paths.status_file)
            assert await wait_until(
                lambda: (
                    [p.get("state") for p in publisher.payloads("runtime_status")].count("stopped")
                    >= 2
                ),
                timeout=2.0,
            )
        finally:
            await monitor.stop()
            watcher.close()

    asyncio.run(scenario())


def test_watcher_notifies_output_events(tmp_path: object) -> None:
    async def scenario() -> None:
        paths = make_paths(tmp_path)
        watcher = StatusFileWatcher(paths.native_runtime_dir)
        try:
            watcher.start()
            waiter = asyncio.get_running_loop().create_task(
                watcher.wait_until(lambda event: event.kind == "output", timeout=2.0)
            )
            await asyncio.sleep(0.05)
            tmp = paths.output_file.with_suffix(".tmp")
            tmp.write_text("final words\n", encoding="utf-8")
            os.replace(tmp, paths.output_file)
            event = await asyncio.wait_for(waiter, 2.0)
            assert event is not None and event.kind == "output"
        finally:
            watcher.close()

    asyncio.run(scenario())


def test_watcher_wait_times_out_without_events(tmp_path: object) -> None:
    async def scenario() -> None:
        paths = make_paths(tmp_path)
        watcher = StatusFileWatcher(paths.native_runtime_dir)
        try:
            watcher.start()
            started = asyncio.get_running_loop().time()
            event = await watcher.wait_until(lambda e: e.kind == "output", timeout=0.2)
            elapsed = asyncio.get_running_loop().time() - started
            assert event is None
            assert 0.15 <= elapsed < 1.5
        finally:
            watcher.close()

    asyncio.run(scenario())


def test_watcher_close_fails_pending_waiters(tmp_path: object) -> None:
    async def scenario() -> None:
        paths = make_paths(tmp_path)
        watcher = StatusFileWatcher(paths.native_runtime_dir)
        watcher.start()
        waiter = asyncio.get_running_loop().create_task(
            watcher.wait_until(lambda event: event.kind == "output", timeout=10.0)
        )
        await asyncio.sleep(0.05)
        watcher.close()
        with pytest.raises(WatcherClosedError):
            await asyncio.wait_for(waiter, 1.0)

    asyncio.run(scenario())


def test_no_events_after_stop(tmp_path: object) -> None:
    async def scenario() -> None:
        paths = make_paths(tmp_path)
        publisher = FakeEventPublisher()
        watcher = StatusFileWatcher(paths.native_runtime_dir)
        monitor = RuntimeStatusMonitor(watcher, publisher)
        await monitor.start()
        await monitor.stop()
        watcher.close()

        write_status_file(paths, "idle")
        await asyncio.sleep(0.1)
        assert publisher.payloads("runtime_status") == []

    asyncio.run(scenario())

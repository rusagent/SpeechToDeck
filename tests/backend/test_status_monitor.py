"""Event-driven status monitor tests (spec §41, §90 malformed status)."""

from __future__ import annotations

import asyncio
import json
import os

import pytest
from backend.infrastructure.process.status_monitor import (
    RuntimeStatusMonitor,
    StatusFileWatcher,
    WatcherClosedError,
    parse_status_payload,
)
from conftest import FakeEventPublisher, make_paths, wait_until


def write_status_file(paths: object, state: str, *, backend: str = "cpu") -> None:
    paths.runtime_dir.mkdir(parents=True, exist_ok=True)  # type: ignore[attr-defined]
    payload = {"protocolVersion": 1, "state": state, "backend": backend}
    tmp = paths.runtime_dir / "status.json.tmp"  # type: ignore[attr-defined]
    tmp.write_text(json.dumps(payload), encoding="utf-8")
    os.replace(tmp, paths.status_file)  # type: ignore[attr-defined]


def test_parse_status_payload_valid_and_malformed() -> None:
    snapshot = parse_status_payload(b'{"protocolVersion":1,"state":"recording"}')
    assert snapshot is not None and snapshot.state == "recording"
    assert snapshot.backend is None
    for bad in (
        b"not json{{{",
        b'{"state":"recording"}',  # missing protocolVersion
        b'{"protocolVersion":2,"state":"idle"}',  # wrong version
        b'{"protocolVersion":1,"state":"warp-drive"}',  # unknown state
        b"[1,2,3]",
        b"",
    ):
        assert parse_status_payload(bad) is None


def test_monitor_emits_typed_events_and_survives_malformed_status(tmp_path: object) -> None:
    async def scenario() -> None:
        paths = make_paths(tmp_path)
        write_status_file(paths, "idle")
        publisher = FakeEventPublisher()
        watcher = StatusFileWatcher(paths.runtime_dir)
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

            # §90 malformed native status: surfaced, never fatal.
            paths.status_file.write_text("garbage-not-json{{{", encoding="utf-8")
            assert await wait_until(
                lambda: any(
                    p.get("malformedPayload") is True for p in publisher.payloads("runtime_status")
                ),
                timeout=2.0,
            )

            # Recovery: the next valid status resumes the stream.
            write_status_file(paths, "transcribing")
            assert await wait_until(
                lambda: any(
                    p.get("state") == "transcribing" for p in publisher.payloads("runtime_status")
                ),
                timeout=2.0,
            )
            assert monitor.last_state == "transcribing"
            # The in-place garbage write produces several real file events;
            # what matters is that every one of them was surfaced, not the
            # exact count.
            assert monitor.malformed_payloads >= 1
        finally:
            await monitor.stop()
            watcher.close()

    asyncio.run(scenario())


def test_watcher_notifies_output_events(tmp_path: object) -> None:
    async def scenario() -> None:
        paths = make_paths(tmp_path)
        watcher = StatusFileWatcher(paths.runtime_dir)
        try:
            watcher.start()
            waiter = asyncio.get_running_loop().create_task(
                watcher.wait_until(lambda event: event.kind == "output", timeout=2.0)
            )
            await asyncio.sleep(0.05)
            tmp = paths.output_file.with_suffix(".tmp")
            tmp.write_text("final words", encoding="utf-8")
            os.replace(tmp, paths.output_file)
            event = await asyncio.wait_for(waiter, 2.0)
            assert event is not None and event.kind == "output"
        finally:
            watcher.close()

    asyncio.run(scenario())


def test_watcher_wait_times_out_without_events(tmp_path: object) -> None:
    async def scenario() -> None:
        paths = make_paths(tmp_path)
        watcher = StatusFileWatcher(paths.runtime_dir)
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
        watcher = StatusFileWatcher(paths.runtime_dir)
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
        watcher = StatusFileWatcher(paths.runtime_dir)
        monitor = RuntimeStatusMonitor(watcher, publisher)
        await monitor.start()
        await monitor.stop()
        watcher.close()

        # Writes after close must not crash anything (fd is gone).
        write_status_file(paths, "idle")
        await asyncio.sleep(0.1)
        assert publisher.payloads("runtime_status") == []

    asyncio.run(scenario())

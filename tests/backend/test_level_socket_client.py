"""LevelSocketClient tests: coalescing, lifecycle, containment (v0.2 §61/§106).

The client runs against a REAL unix socket in tmp_path whose server writes
recorded-frame bytes in the verified wire layout (``=Ifff``, the same struct
the fixtures pin); events land on the FakeEventPublisher. Oracle: the wire
contract from voxtype v1.0.1 levels.rs plus the §61 coalescing budget (15 Hz
event vectors while a recording session is active).
"""

from __future__ import annotations

import asyncio
import struct
from pathlib import Path

from backend.infrastructure.process.level_socket_client import LevelSocketClient
from conftest import FakeEventPublisher


def encode_frame(seq: int, minimum: float, maximum: float, peak_dbfs: float) -> bytes:
    return struct.pack("=Ifff", seq, minimum, maximum, peak_dbfs)


class AutoClock:
    """Monotonic clock that advances a fixed step per frame read
    (deterministic cadence test: each frame 'arrives' 10 ms after the
    previous one — the real 100 Hz source rate)."""

    def __init__(self, step_s: float = 0.01) -> None:
        self.now = 0.0
        self.step = step_s

    def __call__(self) -> float:
        value = self.now
        self.now += self.step
        return value


class FakeLevelHub:
    """Unix socket server that hands each connection the next prepared byte
    batch (FIFO) and closes, mirroring the hub's per-subscriber connections.
    A connection that arrives with no batch prepared parks, as a hub without
    a capture does — and consumes nothing: delivery follows consumption
    order, not the cumulative connection count, so a parked earlier-session
    connection (one stopped before its capture began) cannot steal a later
    session's frames."""

    def __init__(self, socket_path: Path) -> None:
        self.socket_path = socket_path
        self.batches: list[bytes] = []
        self.connections = 0
        self._server: asyncio.AbstractServer | None = None
        self._handlers: set[asyncio.Task[None]] = set()

    async def start(self) -> None:
        self._server = await asyncio.start_unix_server(self._accept, str(self.socket_path))

    def _accept(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        # start_unix_server also accepts a plain callback; wrapping keeps the
        # handler tasks known so stop() can cancel parked ones deterministically
        # (3.12+ wait_closed() waits for handler tasks and would hang forever).
        task = asyncio.get_running_loop().create_task(self._handle(reader, writer))
        self._handlers.add(task)
        task.add_done_callback(self._handlers.discard)

    async def _handle(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        del reader
        self.connections += 1
        try:
            batch = self.batches.pop(0) if self.batches else None
            if batch is None:
                await asyncio.Event().wait()  # parked until hub.stop() cancels
                return
            writer.write(batch)
            await writer.drain()
        finally:
            # Also covers cancelled parked handlers: without this close the
            # server transport stays open and 3.12+ wait_closed() hangs.
            writer.close()

    async def stop(self) -> None:
        if self._server is not None:
            self._server.close()
            for task in list(self._handlers):
                task.cancel()
            await asyncio.gather(*self._handlers, return_exceptions=True)
            await self._server.wait_closed()
            self._server = None


async def wait_until(predicate: object, timeout: float = 2.0) -> bool:
    deadline = asyncio.get_running_loop().time() + timeout
    while asyncio.get_running_loop().time() < deadline:
        if callable(predicate) and predicate():
            return True
        await asyncio.sleep(0.01)
    return False


def build_client(
    socket_path: Path,
    publisher: object,
    **kwargs: float,
) -> LevelSocketClient:
    kwargs.setdefault("emit_interval_s", 1 / 15)
    kwargs.setdefault("reconnect_base_delay_s", 0.01)
    kwargs.setdefault("reconnect_max_delay_s", 0.05)
    return LevelSocketClient(socket_path, publisher, **kwargs)  # type: ignore[arg-type]


def test_coalesces_burst_frames_into_capped_ordered_events(tmp_path: Path) -> None:
    async def scenario() -> None:
        publisher = FakeEventPublisher()
        hub = FakeLevelHub(tmp_path / "audio.sock")
        await hub.start()
        client = build_client(hub.socket_path, publisher, max_frames_per_event=6)
        try:
            # 20 frames in one burst: the cap branch flushes 6/6/6; the tail
            # 2 stay buffered until the next frame (as on a live stream).
            hub.batches = [b"".join(encode_frame(seq, -0.5, 0.5, -3.0 - seq) for seq in range(20))]
            await client.start()
            assert await wait_until(lambda: client.published_events >= 3)

            events = publisher.payloads("recording_level")
            assert len(events) == 3
            flat: list[list[float]] = []
            for event in events:
                assert event["protocolVersion"] == 1
                assert event["kind"] == "recording_level"
                frames = event["frames"]
                assert isinstance(frames, list) and 0 < len(frames) <= 6
                flat.extend(frames)  # type: ignore[arg-type]
            # Ordering preserved; values are the parsed wire values (rounded).
            assert len(flat) == 18
            assert flat[0] == [-0.5, 0.5, -3.0]
            assert flat[6] == [-0.5, 0.5, -9.0]
            assert client.dropped_frames == 0
            assert client.is_running
        finally:
            await client.stop()
            await hub.stop()

    asyncio.run(scenario())


def test_event_cadence_tracks_the_coalescing_budget(tmp_path: Path) -> None:
    async def scenario() -> None:
        publisher = FakeEventPublisher()
        hub = FakeLevelHub(tmp_path / "audio.sock")
        await hub.start()
        # Real 100 Hz pace (10 ms per frame) via the injected clock, default
        # 15 Hz event budget and cap 8: the interval branch must fire long
        # before the buffer can grow unbounded, so every event stays within
        # the cap and 140 frames (1.4 s of stream time) yield well more than
        # the 140/8 = 18 cap-bound events — i.e. a ~15 Hz event cadence.
        client = LevelSocketClient(
            hub.socket_path,
            publisher,
            reconnect_base_delay_s=0.01,
            reconnect_max_delay_s=0.05,
            clock=AutoClock(step_s=0.01),
        )
        try:
            hub.batches = [b"".join(encode_frame(seq, -0.1, 0.1, -20.0) for seq in range(140))]
            await client.start()
            assert await wait_until(lambda: client.published_events >= 17)

            events = publisher.payloads("recording_level")
            assert len(events) >= 17
            covered = 0
            for event in events:
                frames = event["frames"]
                assert isinstance(frames, list) and 0 < len(frames) <= 8
                # Batches are contiguous in seq, in stream order.
                assert event["seq"] == covered + len(frames) - 1
                covered += len(frames)
        finally:
            await client.stop()
            await hub.stop()

    asyncio.run(scenario())


def test_reconnects_after_the_daemon_closes_the_stream(tmp_path: Path) -> None:
    async def scenario() -> None:
        publisher = FakeEventPublisher()
        hub = FakeLevelHub(tmp_path / "audio.sock")
        await hub.start()
        client = build_client(hub.socket_path, publisher, max_frames_per_event=6)
        try:
            # Connection 1: the hub closes right after the batch (slow-
            # consumer drop or capture end) — the client must reconnect.
            hub.batches = [
                b"".join(encode_frame(seq, -0.2, 0.2, -10.0) for seq in range(6)),
                # Connection 2 (hub serving again after its respawn window):
                b"".join(encode_frame(100 + seq, -0.3, 0.3, -5.0) for seq in range(6)),
            ]
            await client.start()
            assert await wait_until(lambda: hub.connections >= 2)
            assert await wait_until(lambda: client.published_events >= 2)

            events = publisher.payloads("recording_level")
            assert events[0]["seq"] == 5
            assert events[1]["seq"] == 105  # the second connection's tail
            assert client.reconnects >= 1
        finally:
            await client.stop()
            await hub.stop()

    asyncio.run(scenario())


def test_publisher_failure_is_contained(tmp_path: Path) -> None:
    async def scenario() -> None:
        hub = FakeLevelHub(tmp_path / "audio.sock")
        await hub.start()

        class FailingPublisher:
            def __init__(self) -> None:
                self.calls = 0

            async def publish(self, event_name: str, payload: dict[str, object]) -> None:
                del event_name, payload
                self.calls += 1
                raise RuntimeError("loader socket gone")

        publisher = FailingPublisher()
        client = build_client(hub.socket_path, publisher, max_frames_per_event=6)
        try:
            hub.batches = [b"".join(encode_frame(seq, 0.0, 0.1, -20.0) for seq in range(12))]
            await client.start()
            assert await wait_until(lambda: publisher.calls >= 2)
            # §106: the stream stays alive; failures are contained.
            assert client.is_running
        finally:
            await client.stop()
            await hub.stop()

    asyncio.run(scenario())


def test_corrupt_frames_are_dropped_and_counted(tmp_path: Path) -> None:
    async def scenario() -> None:
        publisher = FakeEventPublisher()
        hub = FakeLevelHub(tmp_path / "audio.sock")
        await hub.start()
        client = build_client(hub.socket_path, publisher, max_frames_per_event=3)
        try:
            garbage = struct.pack("=Ifff", 1, 9.0, 9.0, 42.0)  # out of contract
            good = encode_frame(2, -0.1, 0.1, -20.0)
            hub.batches = [garbage + good + garbage + good + good + good]
            await client.start()
            assert await wait_until(lambda: client.published_events >= 1)
            assert client.dropped_frames == 2
            # Only valid windows reach the event vector (3 flushed at the
            # cap; the 4th is buffered for the next frame, as on a stream).
            events = publisher.payloads("recording_level")
            assert len(events) == 1
            assert events[0]["frames"] == [[-0.1, 0.1, -20.0]] * 3
        finally:
            await client.stop()
            await hub.stop()

    asyncio.run(scenario())


def test_stop_is_prompt_and_idempotent(tmp_path: Path) -> None:
    async def scenario() -> None:
        publisher = FakeEventPublisher()
        hub = FakeLevelHub(tmp_path / "audio.sock")
        await hub.start()
        client = build_client(hub.socket_path, publisher)
        try:
            await client.start()
            assert client.is_running
            await asyncio.wait_for(client.stop(), 1.0)
            assert not client.is_running
            await asyncio.wait_for(client.stop(), 1.0)  # idempotent
            assert publisher.payloads("recording_level") == []
        finally:
            await hub.stop()

    asyncio.run(scenario())


def test_start_after_stop_gets_a_fresh_stream(tmp_path: Path) -> None:
    async def scenario() -> None:
        # Named defect this pins: a stop() used to fence a later start()
        # (recording 2 never streamed). Every new recording session must get
        # a fresh stream after the previous one stopped.
        publisher = FakeEventPublisher()
        hub = FakeLevelHub(tmp_path / "audio.sock")
        await hub.start()
        client = build_client(hub.socket_path, publisher, max_frames_per_event=6)
        try:
            await client.start()
            # Session 1 starts before its capture exists: the hub parks the
            # connection (CI's 3.11 wait_for always delivers it before the
            # stop). Gate on it so the restart below deterministically follows
            # a parked first-session connection, never a scheduler coin flip.
            assert await wait_until(lambda: hub.connections >= 1)
            await asyncio.wait_for(client.stop(), 1.0)

            hub.batches = [b"".join(encode_frame(seq, 0.0, 0.2, -14.0) for seq in range(6))]
            await client.start()
            assert client.is_running
            assert await wait_until(lambda: client.published_events >= 1)
            assert publisher.payloads("recording_level")[0]["seq"] == 5
        finally:
            await client.stop()
            await hub.stop()

    asyncio.run(scenario())


def test_missing_socket_is_contained_with_bounded_backoff(tmp_path: Path) -> None:
    async def scenario() -> None:
        publisher = FakeEventPublisher()
        client = build_client(tmp_path / "does-not-exist.sock", publisher)
        try:
            await client.start()
            await asyncio.sleep(0.08)
            # No socket anywhere: still running (recording unaffected),
            # still nothing published, retries bounded by the backoff cap.
            assert client.is_running
            assert publisher.payloads("recording_level") == []
        finally:
            await client.stop()

    asyncio.run(scenario())

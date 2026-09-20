"""Live audio-level stream from the daemon's audio.sock.

Connects to the pinned runtime's audio-level broadcast socket
(`PluginPaths.audio_socket`; the hub is started unconditionally at daemon
boot, upstream v1.0.1 daemon.rs:2710-2725), reads the 16-byte frames
(`level_frames.py`, wire contract verified at tag v1.0.1) and coalesces them
into additive `recording_level` event vectors at 15 Hz:

.. code-block:: json

    {"protocolVersion": 1, "kind": "recording_level", "seq": 4211,
     "frames": [[-0.25, 0.5, -6.021], [-0.5, 0.75, -2.5]]}

`frames` are `[min, max, peakDbfs]` triples of the frames accumulated since
the last event (typically 6-7 at 100 Hz source rate; capped so a stalled
publisher cannot grow the vector unboundedly). This is an amplitude
envelope, not an FFT — the frontend renders a live level strip, not a
spectrum.

Lifecycle (no idle loops): `start()` is called only after a recording
start was acknowledged and `stop()` when the session ends (stop, cancel,
failure, disable, dispose, runtime loss) — the stream never runs while idle.
The daemon emits frames only while a recording session provides a sample
stream (levels.rs:17-22); between recordings the hub accepts connections and
delivers nothing, so a blocked read is parked work, not a busy loop.

Robustness: the broadcast is lossy by design — subscribers that fall behind
over the 300 ms per-subscriber queue are disconnected (levels.rs:130-132),
and the self-healing listener can respawn (upstream issue #391), leaving the
socket file briefly unconnectable. A bounded backoff reconnect therefore
runs while started, mirroring upstream's own reference bridge.

Containment: the stream is additive presentation surface. Every
failure — missing socket, refused connection, parse drop, publisher error —
is contained (static log line plus a counter), retried while started, and
can never fail the recording itself.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import time
from collections.abc import Callable
from pathlib import Path

from backend.domain.contracts import (
    EVENT_RECORDING_LEVEL,
    PROTOCOL_VERSION_V1,
    EventPublisher,
)
from backend.infrastructure.process.level_frames import (
    FRAME_BYTES,
    AudioLevelFrame,
    parse_frame,
)

LOGGER = logging.getLogger("speech.levels")

#: Event cadence (15 Hz coalesced vectors ≈ well under 2 KB/s).
LEVEL_EVENT_HZ = 15

#: Upper bound on frames per event vector (burst cushion over 100 Hz / 15 Hz).
MAX_FRAMES_PER_EVENT = 8

#: Bounded connect/read cycle before one reconnect backoff step.
CONNECT_TIMEOUT_S = 2.0

_FRAME_VALUE_DECIMALS = 4
_PEAK_DECIMALS = 3


class LevelSocketClient:
    """Coalesces audio.sock frames into `recording_level` events."""

    def __init__(
        self,
        socket_path: Path,
        publisher: EventPublisher,
        *,
        emit_interval_s: float = 1.0 / LEVEL_EVENT_HZ,
        max_frames_per_event: int = MAX_FRAMES_PER_EVENT,
        connect_timeout_s: float = CONNECT_TIMEOUT_S,
        reconnect_base_delay_s: float = 1.0,
        reconnect_max_delay_s: float = 8.0,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self._socket_path = socket_path
        self._publisher = publisher
        self._emit_interval = emit_interval_s
        self._max_frames = max_frames_per_event
        self._connect_timeout = connect_timeout_s
        self._base_delay = reconnect_base_delay_s
        self._max_delay = reconnect_max_delay_s
        self._clock = clock
        self._task: asyncio.Task[None] | None = None
        self._stop_requested = False
        # Local diagnostics counters; surfaced only through get_status.
        self.dropped_frames = 0
        self.published_events = 0
        self.reconnects = 0

    @property
    def is_running(self) -> bool:
        """True while the stream task is alive (started and not stopped)."""
        return self._task is not None and not self._task.done()

    async def start(self) -> None:
        """Begin streaming (idempotent, restartable). Called only while a
        recording session is active; never raises into the recording path.
        A previous stop does not fence a new start — every recording
        session gets a fresh stream."""
        if self.is_running:
            return
        self._stop_requested = False
        self._task = asyncio.get_running_loop().create_task(self._run(), name="audio-level-stream")

    async def stop(self) -> None:
        """Stop streaming and close the connection. Idempotent."""
        self._stop_requested = True
        task = self._task
        self._task = None
        if task is None:
            return
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

    # ── internals ────────────────────────────────────────────────────────────

    async def _run(self) -> None:
        backoff = self._base_delay
        while not self._stop_requested:
            try:
                reader, writer = await asyncio.wait_for(
                    asyncio.open_unix_connection(str(self._socket_path)),
                    self._connect_timeout,
                )
            except asyncio.CancelledError:
                raise
            except (OSError, TimeoutError) as exc:
                # Missing socket (daemon down), refusal (listener respawn
                # window), or connect stall: contained, then bounded backoff.
                LOGGER.info("audio.sock connect unavailable: %s", type(exc).__name__)
                if await self._backoff_sleep(backoff):
                    return
                backoff = min(backoff * 2, self._max_delay)
                continue
            backoff = self._base_delay
            try:
                await self._read_loop(reader, writer)
            except asyncio.IncompleteReadError:
                # The hub closed us: capture ended, or the 300 ms subscriber
                # queue overflowed (slow-consumer drop, levels.rs:130-132).
                LOGGER.info("audio.sock stream closed by the daemon")
            except asyncio.CancelledError:
                raise
            except OSError as exc:
                LOGGER.info("audio.sock stream error: %s", type(exc).__name__)
            finally:
                writer.close()
                with contextlib.suppress(OSError):
                    await writer.wait_closed()
            if self._stop_requested:
                return
            if await self._backoff_sleep(backoff):
                return
            backoff = min(backoff * 2, self._max_delay)
            self.reconnects += 1

    async def _backoff_sleep(self, delay: float) -> bool:
        """Sleep the reconnect delay; True when a stop was requested."""
        try:
            await asyncio.sleep(delay)
        except asyncio.CancelledError:
            return True
        return self._stop_requested

    async def _read_loop(
        self,
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        buffer: list[AudioLevelFrame] = []
        last_flush = self._clock()
        while True:
            data = await reader.readexactly(FRAME_BYTES)
            frame = parse_frame(data)
            if frame is None:
                # Corrupt/foreign window: dropped, never rendered.
                self.dropped_frames += 1
                continue
            buffer.append(frame)
            now = self._clock()
            if len(buffer) >= self._max_frames or (now - last_flush) >= self._emit_interval:
                await self._flush(buffer, frame.seq)
                last_flush = now

    async def _flush(self, buffer: list[AudioLevelFrame], seq: int) -> None:
        if not buffer:
            return
        frames = [
            [
                round(frame.minimum, _FRAME_VALUE_DECIMALS),
                round(frame.maximum, _FRAME_VALUE_DECIMALS),
                round(frame.peak_dbfs, _PEAK_DECIMALS),
            ]
            for frame in buffer
        ]
        buffer.clear()
        payload: dict[str, object] = {
            "protocolVersion": PROTOCOL_VERSION_V1,
            "kind": "recording_level",
            "seq": seq,
            "frames": frames,
        }
        try:
            await self._publisher.publish(EVENT_RECORDING_LEVEL, payload)
            self.published_events += 1
        except asyncio.CancelledError:
            raise
        except Exception:
            # Contained: an event is feedback, not control flow, and
            # frame values are amplitude numbers, not transcript content —
            # but the log stays static anyway.
            LOGGER.warning("recording_level publish failed; event dropped")

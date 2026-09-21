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

LEVEL_EVENT_HZ = 15

MAX_FRAMES_PER_EVENT = 8

CONNECT_TIMEOUT_S = 2.0

_FRAME_VALUE_DECIMALS = 4
_PEAK_DECIMALS = 3


class LevelSocketClient:
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
        self.dropped_frames = 0
        self.published_events = 0
        self.reconnects = 0

    @property
    def is_running(self) -> bool:
        return self._task is not None and not self._task.done()

    async def start(self) -> None:
        if self.is_running:
            return
        self._stop_requested = False
        self._task = asyncio.get_running_loop().create_task(self._run(), name="audio-level-stream")

    async def stop(self) -> None:
        self._stop_requested = True
        task = self._task
        self._task = None
        if task is None:
            return
        task.cancel()
        with contextlib.suppress(asyncio.CancelledError):
            await task

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
                LOGGER.info("audio.sock connect unavailable: %s", type(exc).__name__)
                if await self._backoff_sleep(backoff):
                    return
                backoff = min(backoff * 2, self._max_delay)
                continue
            backoff = self._base_delay
            try:
                await self._read_loop(reader, writer)
            except asyncio.IncompleteReadError:
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
            LOGGER.warning("recording_level publish failed; event dropped")

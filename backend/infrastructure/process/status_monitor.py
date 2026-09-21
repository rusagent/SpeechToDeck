from __future__ import annotations

import asyncio
import ctypes
import logging
import os
import struct
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from backend.domain.contracts import EVENT_RUNTIME_STATUS, PROTOCOL_VERSION_V1, EventPublisher
from backend.infrastructure.process.process_environment import OUTPUT_FILENAME, STATUS_FILENAME

LOGGER = logging.getLogger("speech.runtime")

_IN_CLOEXEC = 0o2000000
_IN_NONBLOCK = 0o4000
_IN_MODIFY = 0x2
_IN_CLOSE_WRITE = 0x8
_IN_MOVED_TO = 0x80
_IN_CREATE = 0x100
_IN_DELETE = 0x200
_IN_Q_OVERFLOW = 0x4000
_WATCH_MASK = _IN_MODIFY | _IN_CLOSE_WRITE | _IN_MOVED_TO | _IN_CREATE | _IN_DELETE

_EVENT_HEADER = struct.Struct("iIII")
_READ_BUFFER_SIZE = 64 * 1024

KNOWN_DAEMON_STATES = frozenset({"idle", "recording", "streaming", "transcribing"})

MONITOR_STATE_MAP = {
    "idle": "idle",
    "recording": "recording",
    "streaming": "recording",
    "transcribing": "transcribing",
    "stopped": "stopped",
}


class WatcherClosedError(OSError):
    pass


@dataclass(frozen=True)
class StatusSnapshot:
    state: str


def parse_status_word(data: bytes | str) -> StatusSnapshot | None:
    try:
        word = (data.decode("utf-8") if isinstance(data, bytes) else data).strip()
    except UnicodeDecodeError:
        return None
    if word not in KNOWN_DAEMON_STATES:
        return None
    return StatusSnapshot(state=word)


@dataclass(frozen=True)
class WatchEvent:
    kind: Literal["status", "output"]
    snapshot: StatusSnapshot | None = None


WatchCallback = Callable[[WatchEvent], None]
WatchPredicate = Callable[[WatchEvent], bool]


class _Waiter:
    def __init__(self, predicate: WatchPredicate, future: asyncio.Future[WatchEvent]) -> None:
        self.predicate = predicate
        self.future = future


class StatusFileWatcher:
    def __init__(self, runtime_dir: Path) -> None:
        self._runtime_dir = runtime_dir
        self._status_file = runtime_dir / STATUS_FILENAME
        self._output_file = runtime_dir / OUTPUT_FILENAME
        self._fd: int | None = None
        self._loop: asyncio.AbstractEventLoop | None = None
        self._subscribers: list[WatchCallback] = []
        self._waiters: list[_Waiter] = []
        self._last_status_event: WatchEvent | None = None
        self.malformed_count = 0

    def start(self) -> None:
        if self._fd is not None:
            return
        libc = ctypes.CDLL(None, use_errno=True)
        libc.inotify_init1.argtypes = [ctypes.c_int]
        libc.inotify_init1.restype = ctypes.c_int
        libc.inotify_add_watch.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_uint32]
        libc.inotify_add_watch.restype = ctypes.c_int

        fd = libc.inotify_init1(_IN_CLOEXEC | _IN_NONBLOCK)
        if fd < 0:
            raise OSError("inotify_init1 failed; event-driven status watch unavailable")
        added = libc.inotify_add_watch(fd, str(self._runtime_dir).encode("utf-8"), _WATCH_MASK)
        if added < 0:
            os.close(fd)
            raise OSError(f"cannot watch runtime directory {self._runtime_dir}")

        self._fd = fd
        self._loop = asyncio.get_running_loop()
        self._loop.add_reader(fd, self._on_readable)

        self._dispatch(self._current_status_event())

    def close(self) -> None:
        if self._fd is None:
            return
        assert self._loop is not None
        self._loop.remove_reader(self._fd)
        os.close(self._fd)
        self._fd = None
        for waiter in list(self._waiters):
            if not waiter.future.done():
                waiter.future.set_exception(WatcherClosedError("status watcher closed"))
        self._waiters.clear()
        self._subscribers.clear()

    def subscribe(self, callback: WatchCallback) -> Callable[[], None]:
        self._subscribers.append(callback)

        def _unsubscribe() -> None:
            if callback in self._subscribers:
                self._subscribers.remove(callback)

        return _unsubscribe

    async def wait_until(self, predicate: WatchPredicate, timeout: float) -> WatchEvent | None:
        loop = asyncio.get_running_loop()
        future: asyncio.Future[WatchEvent] = loop.create_future()
        waiter = _Waiter(predicate, future)
        self._waiters.append(waiter)

        current = self._last_status_event
        if current is not None and predicate(current):
            self._waiters.remove(waiter)
            return current

        try:
            return await asyncio.wait_for(future, timeout)
        except TimeoutError:
            return None
        finally:
            if waiter in self._waiters:
                self._waiters.remove(waiter)

    @property
    def last_snapshot(self) -> StatusSnapshot | None:
        event = self._last_status_event
        return event.snapshot if event is not None else None

    def _current_status_event(self) -> WatchEvent:
        try:
            snapshot = parse_status_word(self._status_file.read_bytes())
        except FileNotFoundError:
            snapshot = StatusSnapshot(state="stopped")
        except OSError:
            snapshot = None
        return WatchEvent(kind="status", snapshot=snapshot)

    def _on_readable(self) -> None:
        if self._fd is None:
            return
        try:
            buffer = os.read(self._fd, _READ_BUFFER_SIZE)
        except BlockingIOError:
            return
        offset = 0
        while offset + _EVENT_HEADER.size <= len(buffer):
            wd, mask, _cookie, name_len = _EVENT_HEADER.unpack_from(buffer, offset)
            offset += _EVENT_HEADER.size
            name_bytes = buffer[offset : offset + name_len]
            offset += name_len
            name = name_bytes.split(b"\0", 1)[0].decode("utf-8", errors="replace")
            if mask & _IN_Q_OVERFLOW:
                LOGGER.warning("inotify queue overflow; status events may be missing")
                continue
            if name == STATUS_FILENAME:
                if mask & _IN_DELETE:
                    stopped = StatusSnapshot(state="stopped")
                    self._dispatch(WatchEvent(kind="status", snapshot=stopped))
                else:
                    self._dispatch(self._current_status_event())
            elif name == OUTPUT_FILENAME and mask & (_IN_MOVED_TO | _IN_CLOSE_WRITE | _IN_CREATE):
                self._dispatch(WatchEvent(kind="output"))
            del wd

    def _dispatch(self, event: WatchEvent) -> None:
        if event.kind == "status":
            self._last_status_event = event
            if event.snapshot is None:
                self.malformed_count += 1
                LOGGER.warning(
                    "malformed daemon status payload (%dth occurrence)", self.malformed_count
                )
        for callback in list(self._subscribers):
            callback(event)
        for waiter in list(self._waiters):
            if waiter.future.done():
                continue
            if event.kind == "status" and event.snapshot is None:
                continue
            if waiter.predicate(event):
                waiter.future.set_result(event)


class RuntimeStatusMonitor:
    def __init__(self, watcher: StatusFileWatcher, publisher: EventPublisher) -> None:
        self._watcher = watcher
        self._publisher = publisher
        self._unsubscribe: Callable[[], None] | None = None
        self._tasks: set[asyncio.Task[None]] = set()
        self.last_state: str | None = None
        self.malformed_payloads = 0

    async def start(self) -> None:
        if self._unsubscribe is not None:
            return
        self._unsubscribe = self._watcher.subscribe(self._on_event)
        self._watcher.start()

    async def stop(self) -> None:
        if self._unsubscribe is not None:
            self._unsubscribe()
            self._unsubscribe = None
        for task in list(self._tasks):
            task.cancel()
        self._tasks.clear()

    def _on_event(self, event: WatchEvent) -> None:
        if event.kind != "status":
            return
        task = asyncio.get_running_loop().create_task(self._publish(event.snapshot))
        self._tasks.add(task)
        task.add_done_callback(self._tasks.discard)

    async def _publish(self, snapshot: StatusSnapshot | None) -> None:
        if snapshot is None:
            self.malformed_payloads += 1
            payload: dict[str, object] = {
                "protocolVersion": PROTOCOL_VERSION_V1,
                "available": False,
                "state": "unknown",
                "malformedPayload": True,
            }
        else:
            state = MONITOR_STATE_MAP.get(snapshot.state, "unknown")
            self.last_state = state
            payload = {
                "protocolVersion": PROTOCOL_VERSION_V1,
                "available": state not in ("stopped", "unknown"),
                "state": state,
                "malformedPayload": False,
            }
        await self._publisher.publish(EVENT_RUNTIME_STATUS, payload)

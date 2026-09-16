"""Event-driven runtime status consumption (spec §41).

The native daemon writes two files in the runtime directory:

- `status.json`: versioned JSON status, rewritten atomically on each change;
- `transcript.out`: the final transcript for the current recording (§42).

`StatusFileWatcher` consumes changes via Linux inotify and dispatches typed
internal events. There is deliberately **no timer loop and no filesystem
polling** (§41). `RuntimeStatusMonitor` turns status changes into typed
`runtime_status` events on the EventPublisher port.
"""

from __future__ import annotations

import asyncio
import ctypes
import json
import logging
import os
import struct
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Literal

from backend.domain.contracts import EVENT_RUNTIME_STATUS, PROTOCOL_VERSION_V1, EventPublisher
from backend.domain.errors import TranscriptionFailedError
from backend.infrastructure.process.process_environment import OUTPUT_FILENAME, STATUS_FILENAME

LOGGER = logging.getLogger("speech.runtime")

# inotify constants (linux/inotify.h).
_IN_CLOEXEC = 0o2000000  # 0x80000
_IN_NONBLOCK = 0o4000  # 0x800
_IN_MODIFY = 0x2
_IN_CLOSE_WRITE = 0x8
_IN_MOVED_TO = 0x80
_IN_CREATE = 0x100
_IN_DELETE = 0x200
_IN_Q_OVERFLOW = 0x4000
_WATCH_MASK = _IN_MODIFY | _IN_CLOSE_WRITE | _IN_MOVED_TO | _IN_CREATE | _IN_DELETE

_EVENT_HEADER = struct.Struct("iIII")
_READ_BUFFER_SIZE = 64 * 1024

# Daemon status states (CLI contract documented in bin/README.md).
KNOWN_DAEMON_STATES = frozenset({"idle", "recording", "transcribing", "error", "stopped"})


class WatcherClosedError(OSError):
    """Raised to pending waiters when the watcher is closed."""


@dataclass(frozen=True)
class StatusSnapshot:
    """Parsed daemon status payload."""

    state: str
    backend: str | None
    detail: str | None

    @property
    def is_error(self) -> bool:
        return self.state == "error"


def parse_status_payload(data: bytes | str) -> StatusSnapshot | None:
    """Parse a daemon status payload; None when malformed (§90 coverage)."""
    try:
        raw = json.loads(data.decode("utf-8") if isinstance(data, bytes) else data)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None
    if not isinstance(raw, dict):
        return None
    version = raw.get("protocolVersion")
    if version != PROTOCOL_VERSION_V1:
        return None
    state = raw.get("state")
    if not isinstance(state, str) or state not in KNOWN_DAEMON_STATES:
        return None
    backend = raw.get("backend")
    detail = raw.get("detail")
    return StatusSnapshot(
        state=state,
        backend=backend if isinstance(backend, str) else None,
        detail=detail if isinstance(detail, str) else None,
    )


@dataclass(frozen=True)
class WatchEvent:
    """Typed internal status event (§41)."""

    kind: Literal["status", "output"]
    snapshot: StatusSnapshot | None = None  # status only; None = malformed payload


WatchCallback = Callable[[WatchEvent], None]
WatchPredicate = Callable[[WatchEvent], bool]


class _Waiter:
    def __init__(self, predicate: WatchPredicate, future: asyncio.Future[WatchEvent]) -> None:
        self.predicate = predicate
        self.future = future


class StatusFileWatcher:
    """inotify-based watcher over the runtime directory (§41)."""

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
        """Begin watching; raises OSError when inotify is unavailable."""
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

        # Initial state: current status file only. A leftover transcript file
        # from a previous run is intentionally not announced; the client
        # truncates it before every recording (§42).
        snapshot = self._read_status()
        if snapshot is not None or self._status_file.exists():
            self._dispatch(WatchEvent(kind="status", snapshot=snapshot))

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
        """Await the first (new or current) event satisfying predicate."""
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

    def _read_status(self) -> StatusSnapshot | None:
        try:
            return parse_status_payload(self._status_file.read_bytes())
        except FileNotFoundError:
            return None

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
                self._dispatch(WatchEvent(kind="status", snapshot=self._read_status()))
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
                continue  # malformed payloads never satisfy predicates
            if waiter.predicate(event):
                waiter.future.set_result(event)


class RuntimeStatusMonitor:
    """§41: consumes daemon status changes and emits `runtime_status` events."""

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
        # Subscribe before starting so the watcher's initial-state dispatch
        # (current status file) reaches this monitor.
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
            self.last_state = snapshot.state
            payload = {
                "protocolVersion": PROTOCOL_VERSION_V1,
                "available": not snapshot.is_error,
                "state": snapshot.state,
                "malformedPayload": False,
            }
            if snapshot.backend is not None:
                payload["backend"] = snapshot.backend
            if snapshot.detail is not None:
                payload["detail"] = snapshot.detail
        await self._publisher.publish(EVENT_RUNTIME_STATUS, payload)


def transcription_failed_from_status(snapshot: StatusSnapshot) -> TranscriptionFailedError:
    """Map a daemon error status to a typed transcription failure (§68)."""
    return TranscriptionFailedError(
        "native runtime reported an error",
        detail=snapshot.detail,
    )

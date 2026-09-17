"""Minimal Chrome DevTools Protocol client over a stdlib WebSocket (v0.1.6).

The Steam client exposes a local CEF debugging endpoint on
``127.0.0.1:8080`` (user setting "Allow Remote CEF Debugging", verified on
deck hardware 2026-09-17, ``.tmp/cdp/kb-deep.out``). Shipped plugins reach
foreign Steam UI views exactly through this endpoint — enumerate page
targets, attach over one browser WebSocket with flattened sessions and run
``Runtime.evaluate`` in the target document (CssLoader ``css_browserhook.py``,
decky-loader ``injector.py``; audit ``.tmp/audit/cross-view-injection.md``).

This module is the transport half of that integration:

- a dependency-free RFC6455 WebSocket client (masked client frames, an
  incremental frame parser handling fragmentation plus ping/pong/close) built
  on asyncio streams — the backend is stdlib-only (spec §100/§101: the Decky
  runtime ships no third-party packages);
- a tiny CDP wrapper: ``/json/version`` + ``/json/list`` discovery, browser
  socket, ``Target.getTargets``/``setDiscoverTargets``/``attachToTarget``
  (flatten), per-session ``Runtime.evaluate``,
  ``Page.addScriptToEvaluateOnNewDocument``, ``Runtime.addBinding`` with
  ``Runtime.bindingCalled`` event delivery, and ``Input.insertText``.

Every wait is bounded (spec §71). All failures surface as ``CdpError``
subclasses so the keyboard host can degrade with a stable reason (§105)
instead of crashing. Transcript text never passes through this module's
logging (§73): only methods, session ids and result shapes are logged.
"""

from __future__ import annotations

import asyncio
import base64
import contextlib
import hashlib
import json
import logging
import os
import struct
import urllib.error
import urllib.request
from collections.abc import Callable
from typing import Any
from urllib.parse import urlparse

LOGGER = logging.getLogger("plugin.cdp")

# RFC6455 frame opcodes (§5.2).
OP_CONT = 0x0
OP_TEXT = 0x1
OP_CLOSE = 0x8
OP_PING = 0x9
OP_PONG = 0xA

_WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"
_MAX_FRAME_BYTES = 8 * 1024 * 1024  # responses stay far below this; a bound per §71


class CdpError(ConnectionError):
    """Base class for every CDP transport/protocol failure."""


class CdpUnavailableError(CdpError):
    """The CDP endpoint is unreachable (degrade reason "remote-cdp-disabled")."""


class CdpProtocolError(CdpError):
    """The endpoint answered with a CDP error object or an invalid frame."""


class CdpTimeoutError(CdpError, TimeoutError):
    """A bounded CDP wait expired (spec §71: no wait is unbounded)."""


# ── RFC6455 frame codec ──────────────────────────────────────────────────────


def encode_client_frame(opcode: int, payload: bytes) -> bytes:
    """One masked client frame (RFC6455 §5.1: client frames MUST be masked)."""
    mask = os.urandom(4)
    header = bytearray([0x80 | opcode])
    length = len(payload)
    if length < 126:
        header.append(0x80 | length)
    elif length <= 0xFFFF:
        header.append(0x80 | 126)
        header += struct.pack("!H", length)
    else:
        header.append(0x80 | 127)
        header += struct.pack("!Q", length)
    header += mask
    masked = bytes(byte ^ mask[index % 4] for index, byte in enumerate(payload))
    return bytes(header) + masked


def decode_frame(buffer: bytes | bytearray) -> tuple[int, bytes, int, bool] | None:
    """Parse one complete frame from the front of ``buffer``.

    Returns ``(opcode, payload, consumed, fin)`` or ``None`` when the buffer
    holds an incomplete frame. Server frames are unmasked (RFC6455 §5.1); a
    masked server frame is accepted defensively and unmasked anyway. Raises
    ``CdpProtocolError`` on reserved bits set or frames beyond the size bound.
    """
    buf = bytes(buffer)
    if len(buf) < 2:
        return None
    first, second = buf[0], buf[1]
    if first & 0x70:  # reserved bits RSV1-3 must be zero (no extensions)
        raise CdpProtocolError("websocket frame has reserved bits set")
    fin = bool(first & 0x80)
    opcode = first & 0x0F
    masked = bool(second & 0x80)
    length = second & 0x7F
    offset = 2
    if length == 126:
        if len(buf) < offset + 2:
            return None
        length = struct.unpack_from("!H", buf, offset)[0]
        offset += 2
    elif length == 127:
        if len(buf) < offset + 8:
            return None
        length = struct.unpack_from("!Q", buf, offset)[0]
        offset += 8
    if length > _MAX_FRAME_BYTES:
        raise CdpProtocolError(f"websocket frame too large: {length}")
    mask_key = b""
    if masked:
        if len(buf) < offset + 4:
            return None
        mask_key = buf[offset : offset + 4]
        offset += 4
    if len(buf) < offset + length:
        return None
    payload = buf[offset : offset + length]
    if mask_key:
        payload = bytes(byte ^ mask_key[index % 4] for index, byte in enumerate(payload))
    return opcode, payload, offset + length, fin


# ── WebSocket connection ─────────────────────────────────────────────────────


class WebSocketConnection:
    """One RFC6455 client connection over asyncio streams.

    ``recv_message`` transparently answers pings and reassembles fragmented
    messages, so callers only ever see complete text messages (and close).
    """

    def __init__(self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
        self._reader = reader
        self._writer = writer
        self._closed = False
        # Persistent read buffer: bytes received past the frame currently being
        # parsed MUST survive to the next recv (they are lost otherwise).
        self._buffer = bytearray()
        self._fragments: list[bytes] | None = None  # non-None while a message is fragmented

    @classmethod
    async def connect(
        cls, host: str, port: int, path: str, *, open_timeout: float
    ) -> WebSocketConnection:
        """HTTP/1.1 Upgrade handshake (RFC6455 §4.1) with a bounded wait."""
        key = base64.b64encode(os.urandom(16)).decode("ascii")
        request = (
            f"GET {path} HTTP/1.1\r\n"
            f"Host: {host}:{port}\r\n"
            "Upgrade: websocket\r\n"
            "Connection: Upgrade\r\n"
            f"Sec-WebSocket-Key: {key}\r\n"
            "Sec-WebSocket-Version: 13\r\n\r\n"
        )
        try:
            reader, writer = await asyncio.wait_for(
                asyncio.open_connection(host, port), open_timeout
            )
            writer.write(request.encode("ascii"))
            await asyncio.wait_for(writer.drain(), open_timeout)
            status_line, headers = await asyncio.wait_for(cls._read_handshake(reader), open_timeout)
        except TimeoutError as exc:
            raise CdpTimeoutError("websocket handshake timed out") from exc
        except (OSError, ConnectionError) as exc:
            raise CdpUnavailableError(f"websocket connect failed: {type(exc).__name__}") from exc
        expected = base64.b64encode(hashlib.sha1((key + _WS_GUID).encode("ascii")).digest()).decode(
            "ascii"
        )
        if not status_line.startswith("HTTP/1.1 101"):
            raise CdpUnavailableError(f"websocket upgrade refused: {status_line.split(' ', 1)[-1]}")
        if headers.get("sec-websocket-accept") != expected:
            raise CdpProtocolError("websocket accept key mismatch")
        return cls(reader, writer)

    @staticmethod
    async def _read_handshake(reader: asyncio.StreamReader) -> tuple[str, dict[str, str]]:
        status_line = (await reader.readline()).decode("latin-1").strip()
        if not status_line:
            raise CdpProtocolError("empty websocket handshake response")
        headers: dict[str, str] = {}
        while True:
            line = (await reader.readline()).decode("latin-1").strip()
            if not line:
                break
            name, _, value = line.partition(":")
            headers[name.strip().lower()] = value.strip()
        return status_line, headers

    async def send_text(self, text: str) -> None:
        if self._closed:
            raise CdpUnavailableError("websocket is closed")
        self._writer.write(encode_client_frame(OP_TEXT, text.encode("utf-8")))
        await self._writer.drain()

    async def recv_message(self) -> tuple[int, bytes]:
        """Next complete message: ``(OP_TEXT, payload)`` or ``(OP_CLOSE, _)``.

        Pings are answered in-line (RFC6455 §5.5.2-§5.5.3); pongs are dropped.
        Fragmented data messages are reassembled until the FIN piece arrives.
        """
        while True:
            opcode, payload, fin = await self._recv_frame()
            if opcode == OP_PING:
                await self._send_control(OP_PONG, payload)
                continue
            if opcode == OP_PONG:
                continue
            if opcode == OP_CLOSE:
                self._closed = True
                return (OP_CLOSE, payload)
            if opcode == OP_TEXT:
                if self._fragments is not None:
                    raise CdpProtocolError("new text frame inside a fragmented message")
                if fin:
                    return (OP_TEXT, payload)
                self._fragments = [payload]
                continue
            if opcode == OP_CONT:
                if self._fragments is None:
                    raise CdpProtocolError("continuation frame without a fragmented start")
                self._fragments.append(payload)
                if not fin:
                    continue
                complete = b"".join(self._fragments)
                self._fragments = None
                return (OP_TEXT, complete)
            raise CdpProtocolError(f"unsupported websocket opcode {opcode}")

    async def _recv_frame(self) -> tuple[int, bytes, bool]:
        """One raw frame off the wire: ``(opcode, payload, fin)``."""
        while True:
            parsed = decode_frame(self._buffer)
            if parsed is None:
                chunk = await self._reader.read(65536)
                if not chunk:
                    raise CdpUnavailableError("websocket closed by peer")
                self._buffer += chunk
                continue
            opcode, payload, consumed, fin = parsed
            del self._buffer[:consumed]
            return opcode, payload, fin

    async def _send_control(self, opcode: int, payload: bytes) -> None:
        try:
            self._writer.write(encode_client_frame(opcode, payload))
            await self._writer.drain()
        except (OSError, ConnectionError) as exc:
            raise CdpUnavailableError(
                f"websocket control write failed: {type(exc).__name__}"
            ) from exc

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        try:
            self._writer.write(encode_client_frame(OP_CLOSE, b""))
            await asyncio.wait_for(self._writer.drain(), 1.0)
        except (OSError, ConnectionError, TimeoutError, asyncio.CancelledError):
            pass
        finally:
            self._writer.close()


# ── CDP client ───────────────────────────────────────────────────────────────

CdpEventHandler = Callable[[str, dict[str, Any]], None]


class CdpClient:
    """Browser-level CDP connection with flattened per-session messages.

    Lifecycle: ``start()`` fetches ``/json/version``, opens the browser
    WebSocket and starts the reader task; ``attach()`` returns flattened
    session ids; every session call travels with its ``sessionId``. CDP
    events are delivered to the single ``event_handler`` (the keyboard host
    routes them). ``stop()`` is idempotent.
    """

    def __init__(
        self,
        host: str = "127.0.0.1",
        port: int = 8080,
        *,
        connect_timeout: float = 3.0,
        call_timeout: float = 5.0,
        http_timeout: float = 3.0,
    ) -> None:
        self._host = host
        self._port = port
        self._connect_timeout = connect_timeout
        self._call_timeout = call_timeout
        self._http_timeout = http_timeout
        self._connection: WebSocketConnection | None = None
        self._reader_task: asyncio.Task[None] | None = None
        self._pending: dict[int, asyncio.Future[dict[str, Any]]] = {}
        self._next_id = 0
        self.event_handler: CdpEventHandler | None = None

    @property
    def connected(self) -> bool:
        return self._connection is not None

    # ── lifecycle ──

    async def start(self) -> dict[str, Any]:
        """Connect to the browser socket. Returns the ``/json/version`` info."""
        if self.connected:
            raise CdpError("client is already started")
        version = await self._http_get_json("/json/version")
        if not isinstance(version, dict):
            raise CdpProtocolError("/json/version returned a non-object payload")
        ws_url = version.get("webSocketDebuggerUrl")
        if not isinstance(ws_url, str) or not ws_url.startswith("ws://"):
            raise CdpProtocolError("browser websocket url missing from /json/version")
        path = urlparse(ws_url).path or "/"
        self._connection = await WebSocketConnection.connect(
            self._host, self._port, path, open_timeout=self._connect_timeout
        )
        self._reader_task = asyncio.create_task(self._read_loop(), name="cdp-reader")
        return version

    async def stop(self) -> None:
        """Idempotent teardown: fail all pending calls, close the socket."""
        task = self._reader_task
        self._reader_task = None
        connection = self._connection
        self._connection = None
        if task is not None:
            task.cancel()
            with contextlib.suppress(asyncio.CancelledError, CdpError):
                await task
        if connection is not None:
            await connection.close()
        for future in self._pending.values():
            if not future.done():
                future.set_exception(CdpUnavailableError("cdp client stopped"))
        self._pending.clear()

    # ── discovery ──

    async def list_targets(self) -> list[dict[str, Any]]:
        """``GET /json/list`` page-target inventory (loader ``get_tabs`` shape)."""
        payload = await self._http_get_json("/json/list")
        if not isinstance(payload, list):
            raise CdpProtocolError("/json/list returned a non-list payload")
        return [entry for entry in payload if isinstance(entry, dict)]

    async def discover_targets(self) -> list[dict[str, Any]]:
        """``Target.getTargets`` over the browser session."""
        result = await self._call("Target.getTargets")
        infos = result.get("targetInfos")
        if not isinstance(infos, list):
            raise CdpProtocolError("Target.getTargets returned no targetInfos")
        return [entry for entry in infos if isinstance(entry, dict)]

    async def set_discover_targets(self, discover: bool) -> None:
        await self._call("Target.setDiscoverTargets", {"discover": discover})

    # ── sessions ──

    async def attach(self, target_id: str) -> str:
        """Flatten-attach to a target; returns the session id (CssLoader shape)."""
        result = await self._call("Target.attachToTarget", {"targetId": target_id, "flatten": True})
        session_id = result.get("sessionId")
        if not isinstance(session_id, str):
            raise CdpProtocolError("Target.attachToTarget returned no sessionId")
        return session_id

    async def evaluate(self, session_id: str, expression: str) -> Any:
        """``Runtime.evaluate`` with ``returnByValue``; JS exceptions surface."""
        result = await self._call(
            "Runtime.evaluate",
            {"expression": expression, "returnByValue": True, "userGesture": True},
            session_id=session_id,
        )
        remote = result.get("result")
        if not isinstance(remote, dict):
            raise CdpProtocolError("Runtime.evaluate returned no result object")
        if result.get("exceptionDetails") is not None:
            raise CdpProtocolError("evaluate raised in the target document")
        return remote.get("value")

    async def add_script_to_evaluate_on_new_document(self, session_id: str, source: str) -> str:
        result = await self._call(
            "Page.addScriptToEvaluateOnNewDocument", {"source": source}, session_id=session_id
        )
        identifier = result.get("identifier")
        if not isinstance(identifier, str):
            raise CdpProtocolError("addScriptToEvaluateOnNewDocument returned no identifier")
        return identifier

    async def add_binding(self, session_id: str, name: str) -> None:
        await self._call("Runtime.addBinding", {"name": name}, session_id=session_id)

    async def insert_text(self, session_id: str, text: str) -> None:
        """One bulk insertion op into the session's focused editable.

        ``Input.insertText`` emulates inserting text that does not come from
        key presses — the complete string in a single operation (spec §2.2).
        """
        await self._call("Input.insertText", {"text": text}, session_id=session_id)

    # ── internals ──

    async def _http_get_json(self, path: str) -> Any:
        """Blocking discovery HTTP on a worker thread (spec §100)."""
        url = f"http://{self._host}:{self._port}{path}"

        def fetch() -> Any:
            request = urllib.request.Request(url, headers={"Connection": "close"})
            with urllib.request.urlopen(request, timeout=self._http_timeout) as response:
                return json.loads(response.read().decode("utf-8"))

        try:
            return await asyncio.to_thread(fetch)
        except TimeoutError as exc:
            raise CdpTimeoutError(f"{path} timed out") from exc
        except urllib.error.URLError as exc:
            reason = exc.reason if isinstance(exc.reason, str) else type(exc.reason).__name__
            raise CdpUnavailableError(f"{path} unreachable: {reason}") from exc
        except (OSError, ValueError) as exc:
            raise CdpUnavailableError(f"{path} failed: {type(exc).__name__}") from exc

    async def _call(
        self, method: str, params: dict[str, Any] | None = None, *, session_id: str | None = None
    ) -> dict[str, Any]:
        connection = self._connection
        if connection is None:
            raise CdpUnavailableError("cdp client is not connected")
        self._next_id += 1
        message_id = self._next_id
        message: dict[str, Any] = {"id": message_id, "method": method, "params": params or {}}
        if session_id is not None:
            message["sessionId"] = session_id
        future: asyncio.Future[dict[str, Any]] = asyncio.get_running_loop().create_future()
        self._pending[message_id] = future
        try:
            await connection.send_text(json.dumps(message))
            return await asyncio.wait_for(future, self._call_timeout)
        except TimeoutError as exc:
            raise CdpTimeoutError(f"cdp call timed out: {method}") from exc
        finally:
            self._pending.pop(message_id, None)

    async def _read_loop(self) -> None:
        """Route responses to pending futures, events to the handler."""
        connection = self._connection
        assert connection is not None
        try:
            while True:
                opcode, payload = await connection.recv_message()
                if opcode == OP_CLOSE:
                    raise CdpUnavailableError("browser closed the websocket")
                if opcode != OP_TEXT:
                    continue
                await self._dispatch(payload)
        except asyncio.CancelledError:
            raise
        except CdpError as exc:
            LOGGER.info("cdp reader stopped: %s", exc)
        finally:
            for future in self._pending.values():
                if not future.done():
                    future.set_exception(CdpUnavailableError("cdp connection lost"))
            self._pending.clear()

    async def _dispatch(self, payload: bytes) -> None:
        try:
            message = json.loads(payload.decode("utf-8"))
        except (UnicodeDecodeError, ValueError) as exc:
            raise CdpProtocolError("cdp frame is not valid JSON") from exc
        if not isinstance(message, dict):
            raise CdpProtocolError("cdp frame is not a JSON object")
        message_id = message.get("id")
        if message_id is not None:
            future = self._pending.pop(message_id, None)
            if future is None or future.done():
                return
            if "error" in message:
                future.set_exception(CdpProtocolError(f"cdp error: {message['error']}"))
            else:
                result = message.get("result")
                future.set_result(result if isinstance(result, dict) else {})
            return
        method = message.get("method")
        params = message.get("params")
        if isinstance(method, str) and self.event_handler is not None:
            self.event_handler(method, params if isinstance(params, dict) else {})

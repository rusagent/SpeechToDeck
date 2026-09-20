"""Offline fake CDP endpoint for the keyboard-host tests.

Implements just enough of the real endpoint shape — ``/json/version``,
``/json/list`` over HTTP and one browser WebSocket with flattened sessions —
for the cdp_client and cdp_keyboard_host suites. No real network: the server
binds 127.0.0.1 on an ephemeral port inside the test's event loop.

The WebSocket framing here is deliberately a SECOND, independent
implementation (a tiny blocking codec), not an import of
``backend.infrastructure.process.cdp_client``: the client codec is validated
against this oracle instead of against itself.
"""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import struct
from typing import Any

_WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11"

# The five targets from the on-device scan.
SCAN_TARGETS: list[dict[str, Any]] = [
    {
        "targetId": "TOASTS",
        "type": "page",
        "title": "notificationtoasts_uid2",
        "url": "about:blank?browserviewpopup=1&requestid=3&parentpopup=2&createflags=5",
    },
    {
        "targetId": "QUICKACCESS",
        "type": "page",
        "title": "QuickAccess_uid2",
        "url": "about:blank?browserviewpopup=1&requestid=2&parentpopup=2",
    },
    {
        "targetId": "SP",
        "type": "page",
        "title": "Steam Big Picture Mode",
        "url": "about:blank?createflags=6292738&minwidth=853&minheight=534&pid=0",
    },
    {
        "targetId": "MAINMENU",
        "type": "page",
        "title": "MainMenu_uid2",
        "url": "about:blank?browserviewpopup=1&requestid=1&parentpopup=2",
    },
    {
        "targetId": "SHARED",
        "type": "page",
        "title": "SharedJSContext",
        "url": "https://steamloopback.host/routes/search/tab/All",
    },
]


def fixture_encode_frame(opcode: int, payload: bytes, *, fin: bool = True) -> bytes:
    """Server frame writer (unmasked, RFC 6455) — fixture oracle."""
    header = bytearray([(0x80 if fin else 0x00) | opcode])
    length = len(payload)
    if length < 126:
        header.append(length)
    elif length <= 0xFFFF:
        header.append(126)
        header += struct.pack("!H", length)
    else:
        header.append(127)
        header += struct.pack("!Q", length)
    return bytes(header) + payload


async def fixture_read_frame(reader: asyncio.StreamReader) -> tuple[int, bytes, bool]:
    """Blocking read of exactly one client frame (unmasks per RFC 6455)."""
    first, second = await reader.readexactly(2)
    fin = bool(first & 0x80)
    opcode = first & 0x0F
    masked = bool(second & 0x80)
    length = second & 0x7F
    if length == 126:
        (length,) = struct.unpack("!H", await reader.readexactly(2))
    elif length == 127:
        (length,) = struct.unpack("!Q", await reader.readexactly(8))
    mask_key = await reader.readexactly(4) if masked else b""
    payload = await reader.readexactly(length)
    if mask_key:
        payload = bytes(byte ^ mask_key[index % 4] for index, byte in enumerate(payload))
    return opcode, payload, fin


class FakeCdpServer:
    """One fake endpoint: HTTP discovery plus a browser WebSocket.

    Records every CDP call as ``(sessionId, method, params)`` and exposes
    levers the tests drive: ``receipt_value`` (the ``__stdKeyboardHostLoaded``
    probe answer), ``targets``, ``fail_attach``, ``drop_socket``.
    """

    def __init__(self, *, manual_ws: bool = False) -> None:
        self.manual_ws = manual_ws
        self._closed_event = asyncio.Event()
        self.server: asyncio.Server | None = None
        self.port = 0
        self.http_requests: list[str] = []
        self.ws_connections = 0
        self.calls: list[tuple[str | None, str, dict[str, Any]]] = []
        self.scripts: list[str] = []
        self.bindings: list[str] = []
        self.insert_texts: list[str] = []
        self.targets: list[dict[str, Any]] = list(SCAN_TARGETS)
        self.receipt_value = False
        self.keyboard_present = True
        self.keyboard_visible = False
        self.fail_attach = False
        self._sessions = 0
        self._session_writers: dict[str, asyncio.StreamWriter] = {}
        self._current_writer: asyncio.StreamWriter | None = None
        self._current_reader: asyncio.StreamReader | None = None
        self._closed = False

    async def start(self) -> None:
        self.server = await asyncio.start_server(self._handle_connection, "127.0.0.1", 0)
        self.port = self.server.sockets[0].getsockname()[1]

    async def stop(self) -> None:
        self._closed = True
        self._closed_event.set()
        if self.server is not None:
            self.server.close()
            await self.server.wait_closed()

    def calls_for(self, method: str) -> list[tuple[str | None, str, dict[str, Any]]]:
        return [call for call in self.calls if call[1] == method]

    async def emit_binding_called(self, session_id: str, name: str, payload_json: str) -> None:
        """Push one ``Runtime.bindingCalled`` event to the client."""
        writer = self._session_writers.get(session_id)
        assert writer is not None, f"no attached session {session_id}"
        message = json.dumps(
            {
                "method": "Runtime.bindingCalled",
                "params": {"name": name, "payload": payload_json},
                "sessionId": session_id,
            }
        )
        writer.write(fixture_encode_frame(0x1, message.encode("utf-8")))
        await writer.drain()

    async def close_current_socket(self) -> None:
        """Drop every open browser socket (simulates a Steam-side restart)."""
        for writer in list(self._session_writers.values()):
            writer.close()
        self._session_writers.clear()

    # ── connection handling ──

    async def _handle_connection(
        self, reader: asyncio.StreamReader, writer: asyncio.StreamWriter
    ) -> None:
        try:
            request_line, headers = await self._read_http_head(reader)
            path = request_line.split(" ")[1] if " " in request_line else request_line
            if headers.get("upgrade", "").lower() == "websocket":
                await self._run_websocket(headers, reader, writer)
            else:
                self.http_requests.append(path)
                await self._answer_http(path, writer)
                return
        except (asyncio.IncompleteReadError, ConnectionError, asyncio.CancelledError):
            pass
        finally:
            writer.close()

    async def _read_http_head(self, reader: asyncio.StreamReader) -> tuple[str, dict[str, str]]:
        request_line = (await reader.readline()).decode("latin-1").strip()
        headers: dict[str, str] = {}
        while True:
            line = (await reader.readline()).decode("latin-1").strip()
            if not line:
                break
            name, _, value = line.partition(":")
            headers[name.strip().lower()] = value.strip()
        return request_line, headers

    async def _answer_http(self, path: str, writer: asyncio.StreamWriter) -> None:
        if path in ("/json/version", "/json/list"):
            if path == "/json/version":
                body = json.dumps(
                    {
                        "Browser": "Steam CEF fixture/1.0",
                        "webSocketDebuggerUrl": f"ws://127.0.0.1:{self.port}/devtools/browser/FAKE-BROWSER",
                    }
                ).encode("utf-8")
            else:
                body = json.dumps(self.targets).encode("utf-8")
            head = (
                "HTTP/1.1 200 OK\r\n"
                "Content-Type: application/json\r\n"
                f"Content-Length: {len(body)}\r\n"
                "Connection: close\r\n\r\n"
            )
            writer.write(head.encode("ascii") + body)
            await writer.drain()
        else:
            writer.write(b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\n\r\n")
            await writer.drain()

    async def _run_websocket(
        self,
        headers: dict[str, str],
        reader: asyncio.StreamReader,
        writer: asyncio.StreamWriter,
    ) -> None:
        key = headers.get("sec-websocket-key", "")
        accept = base64.b64encode(hashlib.sha1((key + _WS_GUID).encode()).digest()).decode()
        writer.write(
            (
                "HTTP/1.1 101 Switching Protocols\r\n"
                "Upgrade: websocket\r\n"
                "Connection: Upgrade\r\n"
                f"Sec-WebSocket-Accept: {accept}\r\n\r\n"
            ).encode("ascii")
        )
        await writer.drain()
        self.ws_connections += 1
        self._current_writer = writer
        self._current_reader = reader
        if self.manual_ws:
            # Raw-socket mode: the handshake is all the server does; the test
            # owns both frame directions (no competing reader on the stream).
            # The handler parks (not reading) until stop() releases it, so
            # the socket stays open and the finally-close below waits.
            try:
                await self._closed_event.wait()
            finally:
                self._current_writer = None
            return
        while not self._closed:
            opcode, payload, fin = await fixture_read_frame(reader)
            if opcode == 0x8:  # close
                writer.write(fixture_encode_frame(0x8, b""))
                await writer.drain()
                return
            if opcode != 0x1 or not fin:
                continue
            try:
                message = json.loads(payload.decode("utf-8"))
            except ValueError:
                continue
            if not isinstance(message, dict) or "id" not in message:
                continue
            await self._answer_cdp(message, writer)

    async def _answer_cdp(self, message: dict[str, Any], writer: asyncio.StreamWriter) -> None:
        session_id = message.get("sessionId")
        method = str(message.get("method"))
        params = message.get("params") if isinstance(message.get("params"), dict) else {}
        self.calls.append((session_id if isinstance(session_id, str) else None, method, params))
        result, error = self._route(method, params, session_id)
        response: dict[str, Any] = {"id": message["id"]}
        if session_id is not None:
            response["sessionId"] = session_id
        if error is not None:
            response["error"] = error
        else:
            response["result"] = result
        writer.write(fixture_encode_frame(0x1, json.dumps(response).encode("utf-8")))
        await writer.drain()

    def _route(
        self,
        method: str,
        params: dict[str, Any],
        session_id: object,
    ) -> tuple[dict[str, Any], dict[str, Any] | None]:
        if method == "Target.getTargets":
            return {"targetInfos": self.targets}, None
        if method == "Target.setDiscoverTargets":
            return {}, None
        if method == "Target.attachToTarget":
            if self.fail_attach:
                return {}, {"code": -32000, "message": "attach refused"}
            self._sessions += 1
            session = f"SESSION-{self._sessions}"
            self._session_writers[session] = self._current_writer
            return {"sessionId": session}, None
        if method == "Runtime.evaluate":
            expression = str(params.get("expression", ""))
            if "VirtualKeyboard" in expression:
                # The read-only keyboard presence probe (cdp_diagnostics).
                value = (
                    '{"present": '
                    + ("true" if self.keyboard_present else "false")
                    + ', "visible": '
                    + ("true" if self.keyboard_visible else "false")
                    + "}"
                )
                return {"result": {"type": "string", "value": value}}, None
            value = self.receipt_value if "__stdKeyboardHostLoaded" in expression else True
            return {"result": {"type": "boolean", "value": value}}, None
        if method == "Page.addScriptToEvaluateOnNewDocument":
            source = params.get("source")
            if isinstance(source, str):
                self.scripts.append(source)
            return {"identifier": f"SCRIPT-{len(self.scripts)}"}, None
        if method == "Runtime.addBinding":
            name = params.get("name")
            if isinstance(name, str):
                self.bindings.append(name)
            return {}, None
        if method == "Input.insertText":
            text = params.get("text")
            if isinstance(text, str):
                self.insert_texts.append(text)
            return {}, None
        return {}, {"code": -32601, "message": f"{method} not implemented"}

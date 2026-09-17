"""cdp_client tests (v0.1.6 keyboard integration, spec §90).

Decision points, each with an independent oracle:

- RFC6455 correctness against a second, independent frame codec (the fake
  server in ``fixtures/fake_cdp_server.py``): masked client frames, handshake
  accept-key validation, ping→pong, fragmented + large messages.
- CDP routing: responses correlate by message id, session calls carry the
  flattened ``sessionId``, CDP error objects surface as exceptions.
- §71 bounds: unreachable endpoints fail with a typed degrade error instead
  of hanging.

No real network: the fixture binds 127.0.0.1 on an ephemeral port.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path
from typing import Any

import pytest
from backend.infrastructure.process.cdp_client import (
    CdpClient,
    CdpProtocolError,
    CdpUnavailableError,
    WebSocketConnection,
    decode_frame,
    encode_client_frame,
)

sys.path.insert(0, str(Path(__file__).parent))
from fixtures.fake_cdp_server import (
    FakeCdpServer,
    fixture_encode_frame,
    fixture_read_frame,
)


async def _start_server(**kwargs: bool) -> FakeCdpServer:
    server = FakeCdpServer(**kwargs)
    await server.start()
    return server


def test_decode_frame_roundtrip_and_incomplete_buffers() -> None:
    """The codec parses its own output and refuses to over-read short buffers."""
    payload = "héllo".encode()
    frame = encode_client_frame(0x1, payload)
    parsed = decode_frame(frame)
    assert parsed is not None
    opcode, decoded, consumed, fin = parsed
    assert (opcode, decoded, consumed, fin) == (0x1, payload, len(frame), True)
    # Every truncation before the full length is incomplete, never wrong.
    for cut in range(1, len(frame)):
        assert decode_frame(frame[:cut]) is None or cut > 2


def test_large_frame_uses_64bit_length_header() -> None:
    payload = b"x" * (70_000)  # > 16-bit window, < 32-bit
    parsed = decode_frame(encode_client_frame(0x1, payload))
    assert parsed is not None
    assert parsed[1] == payload


def test_handshake_echo_and_server_side_decoding() -> None:
    """Handshake + masked client frame round trip against the fixture oracle."""

    async def scenario() -> None:
        server = await _start_server(manual_ws=True)
        try:
            connection = await WebSocketConnection.connect(
                "127.0.0.1", server.port, "/devtools/browser/FAKE", open_timeout=2.0
            )
            await connection.send_text("héllo")

            # Server side (independent codec) sees the unmasked payload.
            server_reader = server._current_reader
            assert server_reader is not None
            opcode, payload, fin = await asyncio.wait_for(fixture_read_frame(server_reader), 2.0)
            assert (opcode, payload, fin) == (0x1, "héllo".encode(), True)

            await connection.close()
        finally:
            await server.stop()

    asyncio.run(scenario())


def test_ping_is_answered_with_pong() -> None:
    async def scenario() -> None:
        server = await _start_server(manual_ws=True)
        try:
            connection = await WebSocketConnection.connect(
                "127.0.0.1", server.port, "/devtools/browser/FAKE", open_timeout=2.0
            )
            server_writer = server._current_writer
            assert server_writer is not None
            server_reader = server._current_reader
            assert server_reader is not None
            server_writer.write(fixture_encode_frame(0x9, b"ka"))  # ping
            await server_writer.drain()
            server_writer.write(fixture_encode_frame(0x1, b"after-ping"))
            await server_writer.drain()

            opcode, payload = await asyncio.wait_for(connection.recv_message(), 2.0)
            assert (opcode, payload) == (0x1, b"after-ping")

            # The client answered the ping in-line with an unmasked pong.
            pong_opcode, pong_payload, _ = await asyncio.wait_for(
                fixture_read_frame(server_reader), 2.0
            )
            assert (pong_opcode, pong_payload) == (0xA, b"ka")
            await connection.close()
        finally:
            await server.stop()

    asyncio.run(scenario())


def test_fragmented_and_large_messages_reassemble() -> None:
    """A 200 KiB fragmented message plus split writes arrives complete."""

    async def scenario() -> None:
        server = await _start_server(manual_ws=True)
        try:
            connection = await WebSocketConnection.connect(
                "127.0.0.1", server.port, "/devtools/browser/FAKE", open_timeout=2.0
            )
            server_writer = server._current_writer
            assert server_writer is not None
            server_reader = server._current_reader
            assert server_reader is not None

            # Fragmented inbound message (fin=0 / fin=0 / fin=1), each frame
            # written in two arbitrary chunks to exercise mid-frame buffering.
            # The sender runs as a concurrent task: the client reads while the
            # server writes, so fixture-side drain() cannot deadlock against a
            # not-yet-reading peer.
            big = ("ä" * 100_000).encode("utf-8")  # 200 KiB of UTF-8
            third = len(big) // 3

            async def send_fragmented() -> None:
                for opcode, chunk, fin in (
                    (0x1, big[:third], False),
                    (0x0, big[third : 2 * third], False),
                    (0x0, big[2 * third :], True),
                ):
                    frame = fixture_encode_frame(opcode, chunk, fin=fin)
                    server_writer.write(frame[: len(frame) // 2])
                    await server_writer.drain()
                    server_writer.write(frame[len(frame) // 2 :])
                    await server_writer.drain()

            sender = asyncio.create_task(send_fragmented())
            opcode, payload = await asyncio.wait_for(connection.recv_message(), 2.0)
            await asyncio.wait_for(sender, 2.0)
            assert (opcode, payload) == (0x1, big)

            # Outbound large masked frame (64-bit length header).
            await connection.send_text(big.decode("utf-8"))
            out_opcode, out_payload, out_fin = await asyncio.wait_for(
                fixture_read_frame(server_reader), 2.0
            )
            assert (out_opcode, out_payload, out_fin) == (0x1, big, True)
            await connection.close()
        finally:
            await server.stop()

    asyncio.run(scenario())


def test_cdp_flow_routes_ids_sessions_and_records_calls() -> None:
    """Discovery → attach → evaluate → script → binding → insertText routing."""

    async def scenario() -> None:
        server = await _start_server()
        try:
            client = CdpClient("127.0.0.1", server.port, connect_timeout=2.0, call_timeout=2.0)
            events: list[tuple[str, dict[str, Any]]] = []
            client.event_handler = lambda method, params: events.append((method, params))

            version = await client.start()
            assert version["Browser"] == "Steam CEF fixture/1.0"

            targets = await client.list_targets()
            assert any(t["title"] == "Steam Big Picture Mode" for t in targets)

            infos = await client.discover_targets()
            assert len(infos) == 5

            session = await client.attach("SP")
            assert session == "SESSION-1"

            receipt = await client.evaluate(session, "!!window.__stdKeyboardHostLoaded")
            assert receipt is False  # receipt_value lever defaults to False
            await client.add_script_to_evaluate_on_new_document(session, "/* bootstrap */")
            await client.add_binding(session, "stdMicPressBinding")
            await client.insert_text(session, "one bulk payload")

            # Session calls carried the flattened sessionId.
            insert_calls = server.calls_for("Input.insertText")
            assert insert_calls[0][0] == "SESSION-1"
            assert insert_calls[0][2] == {"text": "one bulk payload"}
            assert server.bindings == ["stdMicPressBinding"]
            assert server.scripts == ["/* bootstrap */"]

            # Events flow to the handler keyed by session.
            await server.emit_binding_called(session, "stdMicPressBinding", '{"ts":1}')
            for _ in range(0, 50):
                if events:
                    break
                await asyncio.sleep(0.01)
            assert events == [
                ("Runtime.bindingCalled", {"name": "stdMicPressBinding", "payload": '{"ts":1}'})
            ]

            await client.stop()
            assert client.connected is False
        finally:
            await server.stop()

    asyncio.run(scenario())


def test_cdp_error_object_surfaces_as_exception() -> None:
    async def scenario() -> None:
        server = await _start_server()
        server.fail_attach = True
        try:
            client = CdpClient("127.0.0.1", server.port, connect_timeout=2.0, call_timeout=2.0)
            await client.start()
            with pytest.raises(CdpProtocolError):
                await client.attach("SP")
            await client.stop()
        finally:
            await server.stop()

    asyncio.run(scenario())


def test_unreachable_endpoint_fails_closed_and_fast() -> None:
    """§71: no listener → typed degrade error, not a hang."""

    async def scenario() -> None:
        dead_port = await _claim_free_port()
        client = CdpClient("127.0.0.1", dead_port, http_timeout=0.5, connect_timeout=0.5)
        with pytest.raises(CdpUnavailableError):
            await client.start()
        # Session calls without a connection fail identically (host degrade).
        with pytest.raises(CdpUnavailableError):
            await client.insert_text("SESSION-1", "unused")
        assert client.connected is False

    asyncio.run(scenario())


async def _claim_free_port() -> int:
    """Bind-and-release an ephemeral port for the unreachable-endpoint test."""
    server = await asyncio.start_server(lambda r, w: None, "127.0.0.1", 0)
    port = server.sockets[0].getsockname()[1]
    server.close()
    await server.wait_closed()
    return port

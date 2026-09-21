from __future__ import annotations

import asyncio
import logging

import pytest
from backend.infrastructure.decky_events import DeckyEventPublisher


class _EmitSpy:

    def __init__(self, error: Exception | None = None) -> None:
        self.calls: list[tuple[str, dict[str, object]]] = []
        self._error = error

    async def __call__(self, event_name: str, payload: dict[str, object]) -> None:
        if self._error is not None:
            raise self._error
        self.calls.append((event_name, payload))


def test_publish_awaits_emit_with_name_and_payload_verbatim() -> None:
    async def scenario() -> None:
        emit = _EmitSpy()
        publisher = DeckyEventPublisher(emit)
        payload: dict[str, object] = {"protocolVersion": 1, "step": 2, "percent": 50}

        await publisher.publish("setup_progress", payload)

        assert emit.calls == [("setup_progress", payload)]

    asyncio.run(scenario())


def test_publish_contained_when_emit_fails_and_never_logs_payload() -> None:
    async def scenario() -> None:
        emit = _EmitSpy(error=RuntimeError("socket closed"))
        publisher = DeckyEventPublisher(emit)

        await publisher.publish(
            "transcript_ready", {"protocolVersion": 1, "text": "secret transcript body"}
        )

        assert emit.calls == []

    asyncio.run(scenario())


def test_emit_failure_log_carries_event_and_class_not_payload(
    caplog: pytest.LogCaptureFixture,
) -> None:
    secret = "secret transcript body"

    async def scenario() -> None:
        publisher = DeckyEventPublisher(_EmitSpy(error=RuntimeError("socket closed")))

        with caplog.at_level(logging.ERROR, logger="plugin.events"):
            await publisher.publish("transcript_ready", {"protocolVersion": 1, "text": secret})

    asyncio.run(scenario())

    text = caplog.text
    assert "transcript_ready" in text
    assert "RuntimeError" in text
    assert secret not in text

"""DeckyEventPublisher unit tests (loader contract audit 2026-09-17, finding 1).

The production defect: the backend had no adapter from the `EventPublisher`
port to the loader's `await decky_plugin.emit(event, payload)` API, so no
backend event ever reached the frontend. These tests pin the adapter's two
decision points: verbatim single-coroutine emission, and §106 containment
(a failing emit is logged without payload text and never propagates).
"""

from __future__ import annotations

import asyncio
import logging

import pytest
from backend.infrastructure.decky_events import DeckyEventPublisher


class _EmitSpy:
    """Loader-shaped emit double recording awaited (event, payload) pairs."""

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

        # The append only runs if publish awaited the coroutine.
        assert emit.calls == [("setup_progress", payload)]

    asyncio.run(scenario())


def test_publish_contained_when_emit_fails_and_never_logs_payload() -> None:
    async def scenario() -> None:
        emit = _EmitSpy(error=RuntimeError("socket closed"))
        publisher = DeckyEventPublisher(emit)

        # §106: the event failure must never crash the caller.
        await publisher.publish(
            "transcript_ready", {"protocolVersion": 1, "text": "secret transcript body"}
        )

        assert emit.calls == []  # nothing recorded: the error surfaced first

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
    assert "transcript_ready" in text  # event name is logged
    assert "RuntimeError" in text  # error class is logged
    assert secret not in text  # payload text (transcript) is never logged

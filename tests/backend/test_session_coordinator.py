"""SpeechSessionCoordinator tests: single-session invariant."""

from __future__ import annotations

import asyncio

import pytest
from backend.domain.errors import SessionConflictError, StaleSessionError
from backend.domain.session import SpeechSessionCoordinator


def test_second_session_conflicts_while_first_active() -> None:
    async def scenario() -> None:
        coordinator = SpeechSessionCoordinator()
        first = await coordinator.begin("session-a", started_monotonic=1.0)
        assert first.session_id == "session-a"
        with pytest.raises(SessionConflictError):
            await coordinator.begin("session-b", started_monotonic=2.0)
        # The active session survived the rejected attempt.
        active = await coordinator.active()
        assert active is not None and active.session_id == "session-a"

    asyncio.run(scenario())


def test_require_enforces_stale_session_protection() -> None:
    async def scenario() -> None:
        coordinator = SpeechSessionCoordinator()

        # No session at all: every id is stale.
        with pytest.raises(StaleSessionError):
            await coordinator.require("session-a")

        await coordinator.begin("session-a", started_monotonic=1.0)
        with pytest.raises(StaleSessionError):
            await coordinator.require("session-b")
        matched = await coordinator.require("session-a")
        assert matched.started_monotonic == 1.0

        await coordinator.clear("session-a")
        with pytest.raises(StaleSessionError):
            await coordinator.require("session-a")

    asyncio.run(scenario())


def test_clear_with_mismatched_id_keeps_active_session() -> None:
    async def scenario() -> None:
        coordinator = SpeechSessionCoordinator()
        await coordinator.begin("session-a", started_monotonic=1.0)
        assert await coordinator.clear("session-b") is None
        active = await coordinator.active()
        assert active is not None and active.session_id == "session-a"
        removed = await coordinator.clear()
        assert removed is not None and removed.session_id == "session-a"
        assert await coordinator.active() is None

    asyncio.run(scenario())


def test_begin_after_clear_is_accepted() -> None:
    async def scenario() -> None:
        coordinator = SpeechSessionCoordinator()
        await coordinator.begin("session-a", started_monotonic=1.0)
        await coordinator.clear("session-a")
        session = await coordinator.begin("session-b", started_monotonic=2.0)
        assert session.session_id == "session-b"

    asyncio.run(scenario())

from __future__ import annotations

import asyncio
from dataclasses import dataclass

from backend.domain.errors import SessionConflictError, StaleSessionError


@dataclass(frozen=True)
class ActiveSpeechSession:
    session_id: str
    started_monotonic: float


class SpeechSessionCoordinator:
    def __init__(self) -> None:
        self._lock = asyncio.Lock()
        self._active_session: ActiveSpeechSession | None = None

    async def begin(self, session_id: str, started_monotonic: float) -> ActiveSpeechSession:
        async with self._lock:
            if self._active_session is not None:
                raise SessionConflictError(
                    "another speech session is active",
                    detail=f"activeSessionId={self._active_session.session_id}",
                    session_id=session_id,
                )
            session = ActiveSpeechSession(
                session_id=session_id,
                started_monotonic=started_monotonic,
            )
            self._active_session = session
            return session

    async def active(self) -> ActiveSpeechSession | None:
        async with self._lock:
            return self._active_session

    async def require(self, session_id: str) -> ActiveSpeechSession:
        async with self._lock:
            if self._active_session is None:
                raise StaleSessionError(
                    "no active speech session",
                    session_id=session_id,
                )
            if self._active_session.session_id != session_id:
                raise StaleSessionError(
                    "session id does not match the active session",
                    detail=f"activeSessionId={self._active_session.session_id}",
                    session_id=session_id,
                )
            return self._active_session

    async def clear(self, session_id: str | None = None) -> ActiveSpeechSession | None:

        async with self._lock:
            session = self._active_session
            if session is None:
                return None
            if session_id is not None and session.session_id != session_id:
                return None
            self._active_session = None
            return session

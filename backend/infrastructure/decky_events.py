from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable

Emitter = Callable[[str, dict[str, object]], Awaitable[None]]


class DeckyEventPublisher:
    def __init__(self, emit: Emitter) -> None:
        self._emit = emit
        self._logger = logging.getLogger("plugin.events")

    async def publish(self, event_name: str, payload: dict[str, object]) -> None:
        try:
            await self._emit(event_name, payload)
        except Exception as exc:
            self._logger.error(
                "decky event emit failed: event=%s error_class=%s",
                event_name,
                type(exc).__name__,
            )

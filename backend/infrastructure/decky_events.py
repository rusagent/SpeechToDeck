"""Decky loader event transport (loader contract audit 2026-09-17, finding 1).

The loader's python→frontend event API is the module-level coroutine
`await decky_plugin.emit(event_name, payload_dict)`: before the plugin module
executes, the loader patches `decky.emit` with a socket writer and aliases the
same module object as `decky_plugin` (.tmp/audit/loader-src/sandboxed_plugin.py
lines 99-110). One emit writes one JSON socket line that the frontend dispatches
to this plugin's listeners as `listener(...args)`; our single-dict payloads
arrive as `args[0]`, matching the frontend `DeckyBackendClient`.
"""

from __future__ import annotations

import logging
from collections.abc import Awaitable, Callable

# §106 containment: a failing emit must never crash the plugin (an event is
# fire-and-forget feedback, not a control-plane operation), so the only
# admissible handler here is deliberately broad.
Emitter = Callable[[str, dict[str, object]], Awaitable[None]]


class DeckyEventPublisher:
    """`EventPublisher` adapter over the loader's `decky_plugin.emit`.

    Constructor takes the async emit callable (pass `decky_plugin.emit`, a
    module-level function under the loader). A failing emit is contained:
    logged with a static message, the event name and the error class — never
    payload text, payloads may carry transcripts (§73) — and swallowed. No
    queuing or retry: emit is a single socket write with loader semantics
    (events sent before the loader connects are dropped, not deferred).
    """

    def __init__(self, emit: Emitter) -> None:
        self._emit = emit
        self._logger = logging.getLogger("plugin.events")

    async def publish(self, event_name: str, payload: dict[str, object]) -> None:
        try:
            await self._emit(event_name, payload)
        except Exception as exc:
            # Static message + event name + error class only; never %s the
            # payload (transcript text, §73) and never the exception body,
            # which could echo payload content.
            self._logger.error(
                "decky event emit failed: event=%s error_class=%s",
                event_name,
                type(exc).__name__,
            )

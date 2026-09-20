"""CDP diagnostics probe — optional, read-only, degraded-friendly.

The production keyboard mount does NOT depend on CDP (see
``src/infrastructure/steam/SteamWindowRegistry`` — the mount enumerates the
SharedJSContext window-store registry instead). This module is the OPTIONAL
diagnostics half: when the user enabled "Allow Remote CEF Debugging", it
reports cross-view facts the plugin frontend cannot observe itself — which
page targets exist and whether the Steam virtual keyboard DOM
(``[class*="VirtualKeyboard"]``) is present/visible in them (verified on
deck hardware).

Every step is bounded and every failure degrades into a stable reason
code instead of an exception: CDP unavailability must never affect the
plugin's functional surface. The probe is read-only: it never evaluates
mutating code and never reads field contents; transcripts never pass
through.
"""

from __future__ import annotations

import json
import logging
from typing import Any

from backend.infrastructure.process.cdp_client import (
    CdpClient,
    CdpError,
)

LOGGER = logging.getLogger("plugin.cdp")

# The stable exact title of the main gamepadui target (verified on deck
# hardware), plus the URL pattern fallback: the SP window is the
# only page target whose URL carries "createflags=" without a
# "browserviewpopup=" marker.
SP_TITLE = "Steam Big Picture Mode"

KEYBOARD_PROBE_EXPRESSION = (
    "(() => { const k = document.querySelector('[class*=\"VirtualKeyboard\"]');"
    " if (k === null) return JSON.stringify({present: false});"
    " return JSON.stringify({present: true,"
    " visible: k.classList.contains('VirtualKeyboardVisible')}); })()"
)


def find_sp_target(targets: list[dict[str, Any]]) -> dict[str, Any] | None:
    """Exact title first, then the unique createflags URL pattern."""
    for target in targets:
        if target.get("type") == "page" and target.get("title") == SP_TITLE:
            return target
    for target in targets:
        url = target.get("url")
        if (
            target.get("type") == "page"
            and isinstance(url, str)
            and "createflags=" in url
            and "browserviewpopup=" not in url
        ):
            return target
    return None


class CdpDiagnostics:
    """One bounded probe run over the optional CDP endpoint."""

    def __init__(self, client: CdpClient) -> None:
        self._client = client

    async def probe(self) -> dict[str, object]:
        """Cross-view keyboard facts, or a typed degrade report.

        Payload shape (additive optional field of ``get_status``):
        ``{cdpAvailable, spTargetSeen, keyboardSeen, keyboardVisible, reason}``.
        ``reason`` is a stable lowercase code or None:
        ``remote-cdp-disabled`` | ``sp-target-not-found`` | ``probe-failed``.
        """
        try:
            await self._client.start()
            targets = await self._client.list_targets()
        except CdpError as exc:
            await self._client.stop()
            LOGGER.info("cdp diagnostics unavailable: %s", exc)
            return _report(reason="remote-cdp-disabled")

        sp = find_sp_target(targets)
        if sp is None or not isinstance(sp.get("targetId"), str):
            await self._client.stop()
            return _report(reason="sp-target-not-found")

        keyboard_seen = False
        keyboard_visible = False
        try:
            session_id = await self._client.attach(sp["targetId"])
            # The keyboard container is permanent in the SP document; presence
            # plus the visibility class is the whole observation (read-only).
            value = await self._client.evaluate(session_id, KEYBOARD_PROBE_EXPRESSION)
            if isinstance(value, str):
                parsed = json.loads(value)
                if isinstance(parsed, dict):
                    keyboard_seen = parsed.get("present") is True
                    keyboard_visible = parsed.get("visible") is True
        except CdpError as exc:
            LOGGER.info("cdp keyboard probe failed: %s", exc)
        finally:
            await self._client.stop()
        return _report(
            reason=None,
            sp_target_seen=True,
            keyboard_seen=keyboard_seen,
            keyboard_visible=keyboard_visible,
        )


def _report(
    *,
    reason: str | None,
    sp_target_seen: bool = False,
    keyboard_seen: bool = False,
    keyboard_visible: bool = False,
) -> dict[str, object]:
    return {
        "cdpAvailable": reason is None,
        "spTargetSeen": sp_target_seen,
        "keyboardSeen": keyboard_seen,
        "keyboardVisible": keyboard_visible,
        "reason": reason,
    }

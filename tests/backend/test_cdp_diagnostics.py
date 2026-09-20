"""CdpDiagnostics tests and composition degrade wiring.

Decision points:

- the probe reports the verified cross-view keyboard facts when the optional
  CDP endpoint is up (SP target found by exact title, keyboard presence +
  visibility class via a read-only evaluate);
- every unavailable/degraded condition resolves to a stable lowercase reason
  with ``cdpAvailable: false`` — never an exception escaping the probe;
- composition: a CDP-unavailable device keeps the plugin fully functional
  and ``get_status`` carries the additive ``cdpDiagnostics`` report.

No real network: the fake CDP server binds 127.0.0.1 on an ephemeral port.
"""

from __future__ import annotations

import asyncio
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
from backend.composition import compose
from backend.infrastructure.process.cdp_client import CdpClient
from backend.infrastructure.process.cdp_diagnostics import CdpDiagnostics
from conftest import REAL_MODELS_MANIFEST, wait_until
from fixtures.fake_cdp_server import FakeCdpServer

UNPINNED_RUNTIME_MANIFEST = '{"schemaVersion": 1, "artifacts": []}'


async def _probe_against(server: FakeCdpServer) -> dict[str, object]:
    client = CdpClient("127.0.0.1", server.port, connect_timeout=2.0, call_timeout=2.0)
    return await CdpDiagnostics(client).probe()


def test_probe_reports_keyboard_facts_when_cdp_endpoint_up() -> None:
    async def scenario() -> None:
        server = FakeCdpServer()
        await server.start()
        try:
            report = await _probe_against(server)
            assert report == {
                "cdpAvailable": True,
                "spTargetSeen": True,
                "keyboardSeen": True,
                "keyboardVisible": False,  # scan fixture models the hidden state
                "reason": None,
            }
            # Read-only probe: exactly one evaluate against the SP session.
            evaluates = server.calls_for("Runtime.evaluate")
            assert len(evaluates) == 1
            assert evaluates[0][0] == "SESSION-1"
        finally:
            await server.stop()

    asyncio.run(scenario())


def test_probe_reports_visible_keyboard_when_class_present() -> None:
    async def scenario() -> None:
        server = FakeCdpServer()
        server.keyboard_visible = True
        await server.start()
        try:
            report = await _probe_against(server)
            assert report["keyboardSeen"] is True
            assert report["keyboardVisible"] is True
        finally:
            await server.stop()

    asyncio.run(scenario())


def test_probe_degrades_when_sp_target_missing() -> None:
    async def scenario() -> None:
        server = FakeCdpServer()
        server.targets = [t for t in server.targets if t["title"] != "Steam Big Picture Mode"]
        await server.start()
        try:
            report = await _probe_against(server)
            assert report["cdpAvailable"] is False
            assert report["reason"] == "sp-target-not-found"
        finally:
            await server.stop()

    asyncio.run(scenario())


def test_probe_degrades_when_endpoint_unreachable() -> None:
    async def scenario() -> None:
        dead = await asyncio.start_server(lambda r, w: None, "127.0.0.1", 0)
        port = dead.sockets[0].getsockname()[1]
        dead.close()
        await dead.wait_closed()

        client = CdpClient("127.0.0.1", port, http_timeout=0.5, connect_timeout=0.5)
        report = await CdpDiagnostics(client).probe()
        assert report["cdpAvailable"] is False
        assert report["reason"] == "remote-cdp-disabled"

    asyncio.run(scenario())


def test_composition_degrades_cleanly_without_cdp_and_reports_status(
    tmp_path: Path,
) -> None:
    """No CDP endpoint: app.start() completes, status carries the reason."""

    async def scenario() -> None:
        root = tmp_path / "plugin-root"
        (root / "defaults").mkdir(parents=True)
        (root / "defaults" / "models.json").write_text(
            REAL_MODELS_MANIFEST.read_text(encoding="utf-8"), encoding="utf-8"
        )
        # Unpinned runtime manifest → startup fails fast at verify; the CDP
        # probe must still complete and the surface must stay usable.
        (root / "defaults" / "runtime-manifest.json").write_text(
            UNPINNED_RUNTIME_MANIFEST, encoding="utf-8"
        )
        data_dir = tmp_path / "data"
        app = compose(plugin_root=root, data_dir=data_dir)
        try:
            await app.start()

            async def probed() -> bool:
                report = (await app.get_status())["cdpDiagnostics"]
                return isinstance(report, dict) and report.get("reason") != "not-probed"

            assert await wait_until(probed, timeout=5.0)
            report = (await app.get_status())["cdpDiagnostics"]
            assert report["cdpAvailable"] is False
            assert report["reason"] == "remote-cdp-disabled"
            # The functional surface is unaffected.
            settings = await app.get_settings()
            assert settings["enabled"] is True
        finally:
            await app.dispose()

    asyncio.run(scenario())

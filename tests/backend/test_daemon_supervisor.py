"""SpeechDaemonSupervisor tests (spec §37-§39, §70-§71).

Every happy-path test runs the real fixture daemon as a child process: real
spawns, real signals, real process groups, real exit codes — no STT hardware.
"""

from __future__ import annotations

import asyncio
import os
import signal
import time
from pathlib import Path

import pytest
from backend.domain.contracts import DEFAULT_SETTINGS
from backend.domain.errors import RuntimeStartError
from backend.infrastructure.process.daemon_supervisor import SpeechDaemonSupervisor
from backend.infrastructure.process.process_environment import PluginPaths
from conftest import (
    REAL_RUNTIME_MANIFEST,
    FakeEventPublisher,
    build_fixture_binary,
    make_paths,
    wait_until,
    write_pinned_runtime_manifest,
)


def daemon_log_lines(paths: PluginPaths) -> list[str]:
    try:
        return paths.daemon_log.read_text(encoding="utf-8").splitlines()
    except FileNotFoundError:
        return []


def spawn_count(paths: PluginPaths) -> int:
    return sum(1 for line in daemon_log_lines(paths) if "daemon starting" in line)


def make_supervisor(
    paths: PluginPaths,
    publisher: FakeEventPublisher,
    **kwargs: object,
) -> SpeechDaemonSupervisor:
    kwargs.setdefault("restart_base_delay", 0.05)
    kwargs.setdefault("restart_max_delay", 0.2)
    return SpeechDaemonSupervisor(paths, publisher, **kwargs)  # type: ignore[arg-type]


async def prepare_pinned(
    tmp_path: Path,
    *,
    extra_daemon_args: list[str] | None = None,
) -> PluginPaths:
    paths = make_paths(tmp_path)  # type: ignore[arg-type]
    binary = build_fixture_binary(paths.plugin_root, extra_daemon_args=extra_daemon_args)
    write_pinned_runtime_manifest(paths.plugin_root, binary)
    return paths


def test_unpinned_manifest_fails_closed_with_runtime_start_failed(tmp_path: Path) -> None:
    async def scenario() -> None:
        paths = make_paths(tmp_path)
        # The repository's committed manifest is intentionally unpinned.
        defaults = paths.plugin_root / "defaults"
        defaults.mkdir(parents=True, exist_ok=True)
        (defaults / "runtime-manifest.json").write_bytes(REAL_RUNTIME_MANIFEST.read_bytes())

        publisher = FakeEventPublisher()
        supervisor = make_supervisor(paths, publisher)
        with pytest.raises(RuntimeStartError) as excinfo:
            await supervisor.start(DEFAULT_SETTINGS)
        assert str(excinfo.value.code) == "RUNTIME_START_FAILED"
        assert "pinned" in excinfo.value.message
        assert not supervisor.is_running()
        assert not paths.status_file.exists()  # nothing was ever spawned

    asyncio.run(scenario())


def test_missing_binary_fails_closed(tmp_path: Path) -> None:
    async def scenario() -> None:
        paths = make_paths(tmp_path)
        # Pin data for a binary that does not exist: pin validation passes,
        # the missing executable must still fail closed.
        write_pinned_runtime_manifest(paths.plugin_root, digest="ab" * 32)
        supervisor = make_supervisor(paths, FakeEventPublisher())
        with pytest.raises(RuntimeStartError):
            await supervisor.start(DEFAULT_SETTINGS)
        assert not supervisor.is_running()

    asyncio.run(scenario())


def test_digest_mismatch_fails_closed(tmp_path: Path) -> None:
    async def scenario() -> None:
        paths = make_paths(tmp_path)
        build_fixture_binary(paths.plugin_root)  # real bin/voxtype present
        other = paths.plugin_root / "other.bin"
        other.write_bytes(b"different bytes than the real binary")
        write_pinned_runtime_manifest(paths.plugin_root, other)
        supervisor = make_supervisor(paths, FakeEventPublisher())
        with pytest.raises(RuntimeStartError) as excinfo:
            await supervisor.start(DEFAULT_SETTINGS)
        assert "digest" in excinfo.value.message
        assert not supervisor.is_running()

    asyncio.run(scenario())


def test_start_run_stop_clean_with_log_drain(tmp_path: Path) -> None:
    async def scenario() -> None:
        paths = await prepare_pinned(tmp_path)
        publisher = FakeEventPublisher()
        supervisor = make_supervisor(paths, publisher)
        await supervisor.start(DEFAULT_SETTINGS)
        assert supervisor.is_running()
        assert supervisor.pid is not None

        # The daemon writes its status file; stdout is drained into the log.
        assert await wait_until(lambda: paths.status_file.exists(), timeout=3.0)
        assert await wait_until(
            lambda: any("daemon starting" in line for line in daemon_log_lines(paths)),
            timeout=3.0,
        )

        await supervisor.stop()
        assert not supervisor.is_running()
        assert supervisor.last_exit_code == 0  # §38: clean SIGTERM exit
        states = [p["state"] for p in publisher.payloads("runtime_status")]
        assert states[0] == "starting"
        assert states[-1] == "stopped"
        assert paths.daemon_log.is_file()  # §39: log file under the data dir

    asyncio.run(scenario())


def test_sigkill_escalation_when_sigterm_ignored(tmp_path: Path) -> None:
    async def scenario() -> None:
        paths = await prepare_pinned(tmp_path, extra_daemon_args=["--ignore-term"])
        publisher = FakeEventPublisher()
        supervisor = make_supervisor(paths, publisher, shutdown_timeout=0.4)
        await supervisor.start(DEFAULT_SETTINGS)
        assert await wait_until(supervisor.is_running, timeout=3.0)
        # Wait until the daemon finished booting (signal handlers installed)
        # so the fixture really ignores SIGTERM instead of dying from it.
        assert await wait_until(lambda: paths.control_socket.exists(), timeout=3.0)

        started = time.monotonic()
        await supervisor.stop()
        elapsed = time.monotonic() - started

        # §38: SIGTERM (ignored by the fixture) → bounded wait → SIGKILL.
        assert elapsed < 3.0
        assert not supervisor.is_running()
        assert supervisor.last_exit_code == -int(signal.SIGKILL)

    asyncio.run(scenario())


def test_restart_policy_is_bounded(tmp_path: Path) -> None:
    async def scenario() -> None:
        paths = await prepare_pinned(tmp_path, extra_daemon_args=["--crash-after", "0.15"])
        publisher = FakeEventPublisher()
        supervisor = make_supervisor(
            paths,
            publisher,
            max_restart_attempts=2,
            stability_window=3600.0,  # no budget reset mid-test
        )
        await supervisor.start(DEFAULT_SETTINGS)

        deadline = time.monotonic() + 8.0
        exhausted = False
        while time.monotonic() < deadline:
            if any(
                "exhausted" in str(p.get("detail", ""))
                for p in publisher.payloads("runtime_status")
            ):
                exhausted = True
                break
            await asyncio.sleep(0.05)
        assert exhausted, "restart policy never reported exhaustion"

        # §70: initial spawn + exactly 2 restart attempts, then give up.
        assert supervisor.restart_attempts == 2
        assert spawn_count(paths) == 3
        assert not supervisor.is_running()

        await asyncio.sleep(0.4)  # no further attempts after exhaustion
        assert spawn_count(paths) == 3

    asyncio.run(scenario())


def test_restart_skipped_while_session_pending(tmp_path: Path) -> None:
    async def scenario() -> None:
        paths = await prepare_pinned(tmp_path, extra_daemon_args=["--crash-after", "0.15"])
        publisher = FakeEventPublisher()
        idle = {"value": False}  # §70: transcript insertion pending
        supervisor = make_supervisor(
            paths,
            publisher,
            max_restart_attempts=3,
            is_idle=lambda: idle["value"],
        )
        await supervisor.start(DEFAULT_SETTINGS)
        assert await wait_until(lambda: paths.status_file.exists(), timeout=3.0)

        assert await wait_until(
            lambda: any(
                "restart skipped" in str(p.get("detail", ""))
                for p in publisher.payloads("runtime_status")
            ),
            timeout=5.0,
        )
        assert supervisor.restart_attempts == 0
        assert spawn_count(paths) == 1
        assert not supervisor.is_running()

    asyncio.run(scenario())


def test_unexpected_exit_reported_to_application(tmp_path: Path) -> None:
    async def scenario() -> None:
        paths = await prepare_pinned(tmp_path, extra_daemon_args=["--crash-after", "0.1"])
        exit_codes: list[int | None] = []

        async def on_exit(code: int | None) -> None:
            exit_codes.append(code)

        supervisor = make_supervisor(
            paths,
            FakeEventPublisher(),
            max_restart_attempts=0,
            on_unexpected_exit=on_exit,
        )
        await supervisor.start(DEFAULT_SETTINGS)
        deadline = time.monotonic() + 5.0
        while time.monotonic() < deadline and not exit_codes:
            await asyncio.sleep(0.02)
        assert exit_codes == [3]  # the fixture's crash exit code

    asyncio.run(scenario())


def test_orphan_prevention_via_process_group_kill(tmp_path: Path) -> None:
    async def scenario() -> None:
        sentinel = tmp_path / "grandchild-sentinel"
        paths = await prepare_pinned(
            tmp_path,
            extra_daemon_args=["--grandchild-sentinel", str(sentinel)],
        )
        # The fixture spawns a grandchild inside its own process group; the
        # supervisor's §38 stop must reap both.
        supervisor = make_supervisor(paths, FakeEventPublisher())
        await supervisor.start(DEFAULT_SETTINGS)
        assert await wait_until(supervisor.is_running, timeout=3.0)
        # The grandchild touches the sentinel once its handler is installed;
        # killing the group before that would prove nothing.
        assert await wait_until(lambda: sentinel.exists(), timeout=5.0), (
            "fixture grandchild never became ready"
        )
        assert supervisor.pid is not None
        pgid = supervisor.pid

        await supervisor.stop()

        assert await wait_until(
            lambda: sentinel.read_text(encoding="utf-8") == "terminated", timeout=3.0
        ), "grandchild was not terminated by the group kill"
        try:
            os.killpg(pgid, 0)
            await asyncio.sleep(0.2)
            os.killpg(pgid, 0)
            raise AssertionError("process group still alive after supervisor stop")
        except ProcessLookupError:
            pass

    asyncio.run(scenario())


def test_stop_is_idempotent(tmp_path: Path) -> None:
    async def scenario() -> None:
        paths = await prepare_pinned(tmp_path)
        supervisor = make_supervisor(paths, FakeEventPublisher())
        await supervisor.stop()  # never started
        await supervisor.start(DEFAULT_SETTINGS)
        await supervisor.stop()
        await supervisor.stop()  # already stopped
        assert not supervisor.is_running()

    asyncio.run(scenario())

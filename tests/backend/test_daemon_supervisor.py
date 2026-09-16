"""SpeechDaemonSupervisor tests (spec §37-§39, §70-§71).

Every happy-path test runs the real fixture daemon as a child process: real
spawns, real signals, real process groups, real exit codes — no STT hardware.
The supervisor starts the variant binary selected from the settings backend
through the injected §47 probe (see test_runtime_variant.py for the
selection/probe decision points themselves).
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
from backend.infrastructure.process.daemon_supervisor import daemon_config_toml
from backend.infrastructure.process.process_environment import PluginPaths
from conftest import (
    FakeEventPublisher,
    build_fixture_binary,
    make_paths,
    make_resolver,
    make_supervisor,
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


async def prepare_pinned(
    tmp_path: Path,
    *,
    extra_daemon_args: list[str] | None = None,
) -> PluginPaths:
    paths = make_paths(tmp_path)  # type: ignore[arg-type]
    binary = build_fixture_binary(paths.plugin_root, extra_daemon_args=extra_daemon_args)
    write_pinned_runtime_manifest(paths.plugin_root, binary)
    return paths


def write_unpinned_manifest(plugin_root: Path) -> None:
    """The pre-pin manifest state: present schema, empty provenance."""
    defaults = plugin_root / "defaults"
    defaults.mkdir(parents=True, exist_ok=True)
    (defaults / "runtime-manifest.json").write_text(
        '{"schemaVersion": 1, "artifacts": [{"id": "voxtype-avx2",'
        ' "engine": "whisper", "arch": "x86_64", "variant": "cpu",'
        ' "version": "", "source": "", "sha256": "", "license": ""}]}',
        encoding="utf-8",
    )


def test_unpinned_manifest_fails_closed_with_runtime_start_failed(tmp_path: Path) -> None:
    async def scenario() -> None:
        paths = make_paths(tmp_path)
        write_unpinned_manifest(paths.plugin_root)

        publisher = FakeEventPublisher()
        supervisor = make_supervisor(paths, publisher)
        with pytest.raises(RuntimeStartError) as excinfo:
            await supervisor.start(DEFAULT_SETTINGS)
        assert str(excinfo.value.code) == "RUNTIME_START_FAILED"
        assert "pinned" in excinfo.value.message
        assert not supervisor.is_running()
        assert not paths.status_file.exists()  # nothing was ever spawned

    asyncio.run(scenario())


def test_committed_manifest_loads_with_both_variants_pinned(tmp_path: Path) -> None:
    """The repository's real manifest is fully pinned for both variants."""
    from backend.infrastructure.process.runtime_variant import load_pinned_runtime_artifacts

    artifacts = load_pinned_runtime_artifacts(
        Path(__file__).resolve().parents[2] / "defaults" / "runtime-manifest.json"
    )
    assert set(artifacts) == {"cpu", "vulkan"}
    assert artifacts["cpu"].artifact_id == "voxtype-avx2"
    assert artifacts["vulkan"].artifact_id == "voxtype-vulkan"
    assert artifacts["cpu"].version == artifacts["vulkan"].version == "1.0.1"
    assert all(a.sha256 and a.source.startswith("https://") for a in artifacts.values())


def test_missing_binary_fails_closed(tmp_path: Path) -> None:
    async def scenario() -> None:
        paths = make_paths(tmp_path)
        # Pin data for binaries that do not exist: pin validation passes,
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
        build_fixture_binary(paths.plugin_root)  # real variant binaries present
        other = paths.plugin_root / "other.bin"
        other.write_bytes(b"different bytes than the real binary")
        write_pinned_runtime_manifest(paths.plugin_root, other)
        supervisor = make_supervisor(paths, FakeEventPublisher())
        with pytest.raises(RuntimeStartError) as excinfo:
            await supervisor.start(DEFAULT_SETTINGS)
        assert "digest" in excinfo.value.message
        assert not supervisor.is_running()

    asyncio.run(scenario())


def test_generated_daemon_config_carries_upstream_keys(tmp_path: Path) -> None:
    """The generator maps settings onto the verified upstream TOML keys."""
    import tomllib

    async def scenario() -> None:
        paths = await prepare_pinned(tmp_path)
        publisher = FakeEventPublisher()
        supervisor = make_supervisor(paths, publisher)
        await supervisor.start(DEFAULT_SETTINGS)
        assert supervisor.is_running()

        config = tomllib.loads(paths.daemon_config.read_text(encoding="utf-8"))
        assert config["engine"] == "whisper"
        assert config["state_file"] == str(paths.status_file)
        assert config["hotkey"]["enabled"] is False
        assert config["audio"]["max_duration_secs"] == DEFAULT_SETTINGS.max_recording_seconds
        assert config["whisper"]["model"] == str(paths.models_dir / "ggml-base.bin")
        assert config["whisper"]["language"] == "auto"  # "system" → auto mapping
        assert config["whisper"]["on_demand_loading"] is False
        assert config["whisper"]["eager_processing"] is False
        assert config["vad"]["enabled"] is True
        assert config["output"]["mode"] == "file"
        assert config["output"]["file_path"] == str(paths.output_file)
        assert config["output"]["file_mode"] == "overwrite"
        assert config["output"]["notification"] == {
            "on_recording_start": False,
            "on_recording_stop": False,
            "on_transcription": False,
        }
        assert config["osd"]["enabled"] is False
        assert "streaming" not in config  # section omitted: streaming disabled

        await supervisor.stop()

    asyncio.run(scenario())


def test_generated_daemon_config_maps_language_and_vad(tmp_path: Path) -> None:
    import tomllib

    from backend.domain.contracts import Settings

    settings = Settings(
        schema_version=1,
        enabled=True,
        compute_backend="cpu",
        model_id="tiny",
        language="de",
        max_recording_seconds=90,
        vad_enabled=False,
        output_mode="direct-insert",
    )
    toml = daemon_config_toml(
        settings,
        state_file=Path("/rt/state"),
        output_file=Path("/rt/transcript.out"),
        model_path=Path("/models/ggml-tiny.bin"),
    )
    config = tomllib.loads(toml)
    assert config["whisper"]["language"] == "de"  # explicit codes pass through
    assert config["whisper"]["model"] == "/models/ggml-tiny.bin"
    assert config["audio"]["max_duration_secs"] == 90
    assert config["vad"]["enabled"] is False


def test_start_run_stop_clean_with_log_drain(tmp_path: Path) -> None:
    async def scenario() -> None:
        paths = await prepare_pinned(tmp_path)
        publisher = FakeEventPublisher()
        supervisor = make_supervisor(paths, publisher)
        await supervisor.start(DEFAULT_SETTINGS)
        assert supervisor.is_running()
        assert supervisor.pid is not None
        # §47/§53: the probe decision is visible for §67 metrics reporting.
        assert supervisor.selected_backend == "vulkan"

        # The daemon writes its state file; stdout is drained into the log.
        assert await wait_until(lambda: paths.status_file.exists(), timeout=3.0)
        assert paths.status_file.read_text(encoding="utf-8").strip() == "idle"
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
        # Wait until the daemon finished booting (pid file written after the
        # signal handlers were installed) so the fixture really ignores
        # SIGTERM instead of dying from it.
        pid_file = paths.native_runtime_dir / "pid"
        assert await wait_until(pid_file.exists, timeout=3.0)
        await asyncio.sleep(0.1)

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


def test_start_with_explicit_cpu_backend_runs_avx2_binary(tmp_path: Path) -> None:
    """cpu → avx2 variant selection; the log shows which binary ran."""
    from backend.domain.contracts import Settings

    async def scenario() -> None:
        paths = await prepare_pinned(tmp_path)
        probe_calls: list[int] = []
        resolver = make_resolver(paths, probe_calls=probe_calls)
        supervisor = make_supervisor(paths, FakeEventPublisher(), resolver=resolver)
        settings = Settings(
            schema_version=1,
            enabled=True,
            compute_backend="cpu",
            model_id="base",
            language="system",
            max_recording_seconds=60,
            vad_enabled=True,
            output_mode="direct-insert",
        )
        await supervisor.start(settings)
        assert supervisor.selected_backend == "cpu"
        assert probe_calls == []  # explicit backend: deterministic, no probe
        assert await wait_until(lambda: paths.status_file.exists(), timeout=3.0)
        await supervisor.stop()

    asyncio.run(scenario())

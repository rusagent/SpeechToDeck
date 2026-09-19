"""SpeechDaemonSupervisor tests (spec §37-§39, §70-§71).

Every happy-path test runs the real fixture daemon as a child process: real
spawns, real signals, real process groups, real exit codes — no STT hardware.
The supervisor starts the variant binary selected from the settings backend
through the injected §47 probe (see test_runtime_variant.py for the
selection/probe decision points themselves).
"""

from __future__ import annotations

import asyncio
import contextlib
import os
import signal
import sys
import time
from pathlib import Path

import pytest
from backend.domain.contracts import DEFAULT_MAX_RECORDING_SECONDS, DEFAULT_SETTINGS
from backend.domain.errors import RuntimeStartError
from backend.infrastructure.process import daemon_supervisor as daemon_supervisor_module
from backend.infrastructure.process.daemon_supervisor import daemon_config_toml
from backend.infrastructure.process.executable_copy import (
    EXEC_COPY_DIRNAME,
)
from backend.infrastructure.process.process_environment import PluginPaths
from backend.infrastructure.process.runtime_variant import hash_binary
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
        # v0.2.10 (ADR-012): the §44 bound is the 24 h runaway valve — the
        # literal is the owner-agreed oracle, not the module constant.
        # v0.2.6: VAD fixed off (silero model not bundled, voxtype continues
        # without it).
        assert config["audio"]["max_duration_secs"] == 86400
        assert config["audio"]["max_duration_secs"] == DEFAULT_MAX_RECORDING_SECONDS
        assert config["vad"]["enabled"] is False
        assert config["whisper"]["model"] == str(paths.models_dir / "ggml-base.bin")
        assert config["whisper"]["language"] == "auto"  # "system" → auto mapping
        assert config["whisper"]["on_demand_loading"] is False
        assert config["whisper"]["eager_processing"] is False
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


def test_generated_daemon_config_maps_language_and_model(tmp_path: Path) -> None:
    """v0.2.5: the removed max-duration/VAD settings no longer reach the
    config; the audio/vad lines carry the fixed constants (60 s / disabled
    since v0.2.6 — the silero VAD model is not bundled) regardless of what
    was persisted."""
    import tomllib

    from backend.domain.contracts import Settings

    settings = Settings(
        schema_version=1,
        enabled=True,
        compute_backend="cpu",
        model_id="tiny",
        language="de",
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
    assert config["audio"]["max_duration_secs"] == DEFAULT_MAX_RECORDING_SECONDS
    assert config["vad"]["enabled"] is False


def test_daemon_config_effective_language_matrix() -> None:
    """ADR-012 effective-language derivation, all branches: a model that
    declares exactly ONE language gets it REGARDLESS of settings.language —
    a stale persisted override (german model + "en") must never reach the
    daemon, which would transcribe with the wrong language. Multilingual
    general models keep the legacy mapping ("system" → "auto", explicit
    codes pass through). English-only models are covered by the same rule
    (distil-en declares ["en"]); the ADR-011 multilingual=false fallback
    stays for admissible entries without declared languages."""
    import tomllib

    from backend.domain.contracts import ModelInfo, Settings

    def model(*, multilingual: bool, languages: tuple[str, ...] | None) -> ModelInfo:
        return ModelInfo(
            id="m",
            engine="whisper",
            multilingual=multilingual,
            filename="ggml-m.bin",
            download_url="https://example.test/m.bin",
            sha256="0" * 64,
            size_bytes=1,
            languages=languages,
        )

    german = model(multilingual=True, languages=("de",))  # catalog Primeline shape
    base = model(multilingual=True, languages=None)  # catalog tiny/base/small shape
    distil_en = model(multilingual=False, languages=("en",))  # catalog distil shape
    en_undeclared = model(multilingual=False, languages=None)  # ADR-011 fallback
    multi = model(multilingual=True, languages=("en", "de"))  # serves several

    cases = [
        # (model_info, settings language, expected daemon language)
        (german, "en", "de"),  # stale override ignored: the model decides
        (german, "system", "de"),
        (german, "fr", "de"),
        (base, "fr", "fr"),  # legacy mapping: explicit codes pass through
        (base, "system", "auto"),
        (distil_en, "de", "en"),  # en-only: explicit code cannot be honored
        (distil_en, "system", "en"),
        (en_undeclared, "system", "en"),  # ADR-011 fallback, unchanged
        (multi, "system", "auto"),  # several languages: settings.language honored
        (multi, "de", "de"),
        (None, "system", "auto"),  # unwired/unknown model: legacy mapping
        (None, "de", "de"),
    ]
    for model_info, language, expected in cases:
        settings = Settings(
            schema_version=1,
            enabled=True,
            compute_backend="cpu",
            model_id="m",
            language=language,
            output_mode="direct-insert",
        )
        toml = daemon_config_toml(
            settings,
            state_file=Path("/rt/state"),
            output_file=Path("/rt/transcript.out"),
            model_path=Path("/models/m.bin"),
            model_info=model_info,
        )
        config = tomllib.loads(toml)
        assert config["whisper"]["language"] == expected, (model_info, language)


def test_supervisor_passes_model_languages_to_config(tmp_path: Path) -> None:
    """The supervisor feeds the selected model's manifest info (declared
    languages) into the config build (composition wires
    model_info_for=manifest.by_id): the german catalog model forces "de"
    even though the settings still carry the "system" sentinel."""
    import tomllib

    from backend.domain.contracts import ModelInfo

    async def scenario() -> None:
        paths = await prepare_pinned(tmp_path)
        publisher = FakeEventPublisher()

        def model_info_for(model_id: str) -> ModelInfo:
            return ModelInfo(
                id=model_id,
                engine="whisper",
                multilingual=True,
                filename=f"ggml-{model_id}.bin",
                download_url="https://example.test/m.bin",
                sha256="0" * 64,
                size_bytes=1,
                languages=("de",),
            )

        supervisor = make_supervisor(paths, publisher, model_info_for=model_info_for)
        await supervisor.start(DEFAULT_SETTINGS)  # language="system"
        assert supervisor.is_running()
        config = tomllib.loads(paths.daemon_config.read_text(encoding="utf-8"))
        assert config["whisper"]["language"] == "de"  # declared language wins
        await supervisor.stop()

    asyncio.run(scenario())


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


@pytest.mark.skipif(sys.platform != "linux", reason="PR_SET_PDEATHSIG is Linux-only")
def test_pdeathsig_ends_daemon_when_backend_process_is_sigkilled(tmp_path: Path) -> None:
    """Loader dispose hole (mature-plugin adopt; audit 2026-09-17): the
    loader kills only the plugin process (KillMode=process; SIGKILL after the
    5 s dispose window), so graceful `_unload` teardown never runs. A backend
    stand-in starts the REAL supervisor (production `_spawn` wiring) and is
    SIGKILLed; the kernel-level PDEATHSIG from `daemon_preexec` must end the
    daemon — the fixture's SIGTERM handler (§38 semantics) deleted its state
    file."""

    async def scenario() -> None:
        paths = await prepare_pinned(tmp_path)
        pid_file = tmp_path / "standin-child-pid"
        script = tmp_path / "backend_standin.py"
        script.write_text(
            "import asyncio\n"
            "import sys\n"
            "from pathlib import Path\n"
            "\n"
            f"sys.path.insert(0, {str(Path(__file__).resolve().parents[2])!r})\n"
            "from backend.domain.contracts import DEFAULT_MAX_RECORDING_SECONDS, DEFAULT_SETTINGS\n"
            "from backend.infrastructure.process.daemon_supervisor import SpeechDaemonSupervisor\n"
            "from backend.infrastructure.process.process_environment import (\n"
            "    PluginPaths,\n"
            "    ensure_directories,\n"
            ")\n"
            "from backend.infrastructure.process.runtime_variant import RuntimeVariantResolver\n"
            "\n"
            "\n"
            "class Publisher:\n"
            "    async def publish(self, name, payload):\n"
            "        pass\n"
            "\n"
            "\n"
            "async def main() -> None:\n"
            "    plugin_root, data_dir, pid_file = sys.argv[1:4]\n"
            "    paths = PluginPaths(plugin_root=Path(plugin_root), data_dir=Path(data_dir))\n"
            "    ensure_directories(paths)\n"
            "\n"
            "    async def probe(resolver, config_path):  # §47 decision, deterministic\n"
            "        return False  # cpu\n"
            "\n"
            "    supervisor = SpeechDaemonSupervisor(\n"
            "        paths,\n"
            "        Publisher(),\n"
            "        RuntimeVariantResolver(paths, probe=probe),\n"
            "        model_path_for=lambda model_id: paths.models_dir / 'ggml-base.bin',\n"
            "    )\n"
            "    await supervisor.start(DEFAULT_SETTINGS)\n"
            "    Path(pid_file).write_text(str(supervisor.pid), encoding='utf-8')\n"
            "    await asyncio.Event().wait()  # held until the test SIGKILLs us\n"
            "\n"
            "asyncio.run(main())\n",
            encoding="utf-8",
        )
        standin = await asyncio.create_subprocess_exec(
            sys.executable,
            str(script),
            str(paths.plugin_root),
            str(paths.data_dir),
            str(pid_file),
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            stdin=asyncio.subprocess.DEVNULL,
        )
        daemon_pid: int | None = None
        try:
            assert await wait_until(pid_file.exists, timeout=5.0), (
                "backend stand-in never reported the daemon pid"
            )
            daemon_pid = int(pid_file.read_text(encoding="utf-8").strip())
            assert daemon_pid is not None
            assert await wait_until(lambda: paths.status_file.exists(), timeout=5.0), (
                "fixture daemon never became ready"
            )

            # The loader dispose hole: the parent is SIGKILLed with no chance
            # to run any graceful teardown. The kernel must signal the child.
            os.kill(standin.pid, signal.SIGKILL)
            await standin.wait()

            assert await wait_until(lambda: not paths.status_file.exists(), timeout=5.0), (
                "daemon survived the backend SIGKILL (PDEATHSIG hardening missing)"
            )
            # The fixture's SIGTERM handler removed the state file: the child
            # died through the PDEATHSIG SIGTERM path, §38 semantics intact.
            assert await wait_until(lambda: _pid_gone(daemon_pid), timeout=3.0), (
                "daemon process still present after the PDEATHSIG SIGTERM"
            )
        finally:
            if standin.returncode is None:
                with contextlib.suppress(ProcessLookupError):
                    os.kill(standin.pid, signal.SIGKILL)
                await standin.wait()
            if daemon_pid is not None and not _pid_gone(daemon_pid):
                with contextlib.suppress(ProcessLookupError):
                    os.kill(daemon_pid, signal.SIGKILL)

    asyncio.run(scenario())


def _pid_gone(pid: int) -> bool:
    try:
        os.kill(pid, 0)
    except ProcessLookupError:
        return True
    return False


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
            output_mode="direct-insert",
        )
        await supervisor.start(settings)
        assert supervisor.selected_backend == "cpu"
        assert probe_calls == []  # explicit backend: deterministic, no probe
        assert await wait_until(lambda: paths.status_file.exists(), timeout=3.0)
        await supervisor.stop()

    asyncio.run(scenario())


# ── private executable copy (on-device ETXTBSY fix, deck 2026-09-18) ────────


def exec_copy_dir(paths: PluginPaths) -> Path:
    return paths.runtime_dir / EXEC_COPY_DIRNAME


def test_spawn_argv_uses_digest_verified_private_copy_not_bin(tmp_path: Path) -> None:
    """The supervisor spawns the private copy under the data dir, never bin/.

    Installing a zip over the RUNNING plugin rewrites bin/ in place and the
    direct-executing daemon made that abort with `[Errno 26] Text file busy`.
    The argv seam is observed with a pass-through spy (the real spawn still
    happens and must keep the daemon alive) — the executed path is the
    decisive fact, not a mocked subprocess.
    """

    async def scenario() -> None:
        paths = await prepare_pinned(tmp_path)
        recorded: list[list[str]] = []
        real_exec = asyncio.create_subprocess_exec

        async def spy(*argv: object, **kwargs: object) -> object:
            recorded.append([str(a) for a in argv])
            return await real_exec(*argv, **kwargs)  # type: ignore[arg-type]

        original = daemon_supervisor_module.asyncio.create_subprocess_exec
        daemon_supervisor_module.asyncio.create_subprocess_exec = spy
        try:
            supervisor = make_supervisor(paths, FakeEventPublisher())
            await supervisor.start(DEFAULT_SETTINGS)
        finally:
            daemon_supervisor_module.asyncio.create_subprocess_exec = original

        assert await wait_until(lambda: paths.status_file.exists(), timeout=3.0)
        assert recorded, "the supervisor never spawned the daemon"
        source = paths.plugin_root / "bin" / "voxtype-vulkan"
        copy = exec_copy_dir(paths) / "voxtype-vulkan"
        assert recorded[0][0] == str(copy)
        assert recorded[0][0] != str(source)
        assert recorded[0][1:3] == ["--config", str(paths.daemon_config)]
        assert recorded[0][3] == "daemon"
        # §53 second half: the executed copy matches the pinned source digest.
        assert hash_binary(copy) == hash_binary(source)
        await supervisor.stop()

    asyncio.run(scenario())


def test_copy_refreshed_when_source_digest_changes(tmp_path: Path) -> None:
    """A changed source (simulated store update) refreshes the cache copy.

    The cache is digest-keyed: after the source bytes change and the manifest
    is re-pinned, the OLD supervisor (manifest cached for its process
    lifetime) fails closed against the drifted source; the post-update
    restart — a fresh supervisor over the same data dir — refreshes the copy
    atomically (new inode) and the daemon runs the new bytes.
    """

    async def scenario() -> None:
        paths = await prepare_pinned(tmp_path)
        supervisor = make_supervisor(paths, FakeEventPublisher())
        await supervisor.start(DEFAULT_SETTINGS)
        assert await wait_until(lambda: paths.status_file.exists(), timeout=3.0)
        await supervisor.stop()

        copy = exec_copy_dir(paths) / "voxtype-vulkan"
        source = paths.plugin_root / "bin" / "voxtype-vulkan"
        first_inode = copy.stat().st_ino

        for name in ("voxtype-avx2", "voxtype-vulkan"):
            binary = paths.plugin_root / "bin" / name
            binary.write_text(
                binary.read_text(encoding="utf-8") + "# store update v2\n", encoding="utf-8"
            )
        write_pinned_runtime_manifest(paths.plugin_root, paths.plugin_root / "bin" / "voxtype-avx2")

        # Same process (stale manifest cache): the drift fails closed.
        with pytest.raises(RuntimeStartError) as excinfo:
            await supervisor.start(DEFAULT_SETTINGS)
        assert "digest" in excinfo.value.message
        assert copy.stat().st_ino == first_inode  # cache untouched by the refusal

        # Post-update restart: fresh process, fresh manifest load.
        restarted = make_supervisor(paths, FakeEventPublisher())
        await restarted.start(DEFAULT_SETTINGS)
        assert await wait_until(lambda: paths.status_file.exists(), timeout=3.0)
        assert copy.read_bytes() == source.read_bytes()
        assert hash_binary(copy) == hash_binary(source)
        assert copy.stat().st_ino != first_inode  # atomic replace, never in-place
        await restarted.stop()

    asyncio.run(scenario())


def test_stale_tmp_copy_is_cleaned_on_cache_hit(tmp_path: Path) -> None:
    """A stale `<name>.tmp` from an interrupted write never survives a spawn."""

    async def scenario() -> None:
        paths = await prepare_pinned(tmp_path)
        supervisor = make_supervisor(paths, FakeEventPublisher())
        await supervisor.start(DEFAULT_SETTINGS)
        assert await wait_until(lambda: paths.status_file.exists(), timeout=3.0)
        await supervisor.stop()

        # Interrupted-write leftover in the cache dir (wrong bytes, never run).
        stale = exec_copy_dir(paths) / "voxtype-vulkan.tmp"
        stale.write_bytes(b"partial write from a crashed run")

        await supervisor.start(DEFAULT_SETTINGS)
        assert await wait_until(lambda: paths.status_file.exists(), timeout=3.0)
        assert not stale.exists()
        await supervisor.stop()

    asyncio.run(scenario())


@pytest.mark.skipif(
    sys.platform != "linux" or os.geteuid() == 0,
    reason="permission denial needs Linux and a non-root user",
)
def test_copy_failure_fails_closed_without_spawn(tmp_path: Path) -> None:
    """An unwritable cache dir (disk-full class) fails closed: stable
    RuntimeStartError, no daemon spawn, no leftover tmp file."""

    async def scenario() -> None:
        paths = await prepare_pinned(tmp_path)
        exec_dir = exec_copy_dir(paths)
        exec_dir.mkdir(parents=True, exist_ok=True)
        os.chmod(exec_dir, 0o555)
        try:
            supervisor = make_supervisor(paths, FakeEventPublisher())
            with pytest.raises(RuntimeStartError) as excinfo:
                await supervisor.start(DEFAULT_SETTINGS)
            assert str(excinfo.value.code) == "RUNTIME_START_FAILED"
            assert not supervisor.is_running()
            assert not paths.status_file.exists()  # nothing unverified was spawned
            assert not (exec_dir / "voxtype-vulkan.tmp").exists()
        finally:
            os.chmod(exec_dir, 0o755)

    asyncio.run(scenario())

"""Shared backend test infrastructure (spec §90-§91).

Sync tests drive async scenarios with `asyncio.run` so the suite runs under
plain pytest (CI installs only pytest); no plugin-specific asyncio mode is
required. Every scenario creates and closes its own event loop and watchers.
"""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import inspect
import json
import os
import signal
import sys
import time
from pathlib import Path
from typing import Any

import pytest

ROOT = Path(__file__).resolve().parents[2]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

from backend.domain.contracts import (  # noqa: E402
    TranscriptResult,
)
from backend.domain.errors import SpeechError  # noqa: E402
from backend.infrastructure.process.daemon_supervisor import (  # noqa: E402
    SpeechDaemonSupervisor,
    write_daemon_config,
)
from backend.infrastructure.process.process_environment import (  # noqa: E402
    PluginPaths,
    child_environment,
    ensure_directories,
)
from backend.infrastructure.process.runtime_variant import (  # noqa: E402
    RuntimeVariantResolver,
)

FIXTURE_SOURCE = Path(__file__).parent / "fixtures" / "fake_voxtype_daemon.py"

REPO_ROOT = ROOT
REAL_MODELS_MANIFEST = REPO_ROOT / "defaults" / "models.json"
REAL_RUNTIME_MANIFEST = REPO_ROOT / "defaults" / "runtime-manifest.json"

# Variant binary names the Decky loader remote_binary entries produce.
VARIANT_BINARIES = ("voxtype-avx2", "voxtype-vulkan")


async def wait_until(predicate: Any, timeout: float = 2.0, interval: float = 0.01) -> bool:
    """Poll a test-side predicate; test-side polling is not production code.

    Awaitable predicates are awaited (a bare `predicate()` on an async
    predicate function would create a never-awaited truthy coroutine and
    make the whole wait vacuous).
    """
    deadline = time.monotonic() + timeout
    while True:
        result = predicate()
        if inspect.isawaitable(result):
            result = await result
        if result:
            return True
        if time.monotonic() >= deadline:
            return False
        await asyncio.sleep(interval)


class FakeEventPublisher:
    """Records every published (event, payload) pair for assertions."""

    def __init__(self) -> None:
        self.events: list[tuple[str, dict[str, object]]] = []

    async def publish(self, event_name: str, payload: dict[str, object]) -> None:
        self.events.append((event_name, payload))

    def payloads(self, event_name: str) -> list[dict[str, object]]:
        return [payload for name, payload in self.events if name == event_name]

    def codes(self, event_name: str) -> list[str]:
        return [str(p.get("code")) for p in self.payloads(event_name) if "code" in p]


class FakeSpeechRuntime:
    """Deterministic fake per spec §91 — no microphone, no subprocess."""

    def __init__(self) -> None:
        self.calls: list[str] = []
        self.sink: Any = None
        self.start_error: SpeechError | None = None
        self.stop_hangs = False

    async def start(self) -> None:
        self.calls.append("start")

    async def stop(self) -> None:
        self.calls.append("stop")

    async def start_recording(self) -> None:
        if self.start_error is not None:
            raise self.start_error
        self.calls.append("start_recording")

    async def stop_recording(self) -> None:
        if self.stop_hangs:
            await asyncio.Event().wait()  # never resolves; ack timeout path
        self.calls.append("stop_recording")

    async def cancel_recording(self) -> None:
        self.calls.append("cancel_recording")

    async def emit_transcript(self, text: str) -> None:
        assert self.sink is not None, "wire sink before emitting"
        await self.sink.on_transcript(
            TranscriptResult(
                text=text,
                backend="cpu",
                audio_duration_ms=1234.0,
                transcription_duration_ms=42.0,
            )
        )

    async def emit_error(self, error: SpeechError) -> None:
        assert self.sink is not None, "wire sink before emitting"
        await self.sink.on_transcript_error(error)


class SinkCollector:
    """TranscriptSink double that records delivery outcomes (§42)."""

    def __init__(self) -> None:
        self.results: list[TranscriptResult] = []
        self.errors: list[SpeechError] = []
        self.delivered = asyncio.Event()

    async def on_transcript(self, result: TranscriptResult) -> None:
        self.results.append(result)
        self.delivered.set()

    async def on_transcript_error(self, error: SpeechError) -> None:
        self.errors.append(error)
        self.delivered.set()

    async def wait_delivery(self, timeout: float = 3.0) -> bool:
        try:
            await asyncio.wait_for(self.delivered.wait(), timeout)
        except TimeoutError:
            return False
        return True


def build_fixture_binary(
    plugin_root: Path,
    *,
    extra_daemon_args: list[str] | None = None,
    extra_record_args: list[str] | None = None,
) -> Path:
    """Write executable `bin/<variant>` launchers for the fixture daemon.

    One launcher per pinned variant name (the loader remote_binary layout);
    both exec the same fixture script. `extra_daemon_args` are appended to
    every `daemon` invocation (crash loops, SIGTERM-ignoring, grandchild),
    `extra_record_args` to every `record` invocation (slow acknowledgements)
    while the supervisor still hashes and runs exactly `bin/<variant>`.
    """
    bin_dir = plugin_root / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    real = bin_dir / ".voxtype-fake.py"
    # execv needs a real executable: shebang + exec bit.
    real.write_text(
        f"#!{sys.executable}\n{FIXTURE_SOURCE.read_text(encoding='utf-8')}",
        encoding="utf-8",
    )
    real.chmod(0o755)
    daemon_extra = repr(extra_daemon_args or [])
    record_extra = repr(extra_record_args or [])
    for name in VARIANT_BINARIES:
        binary = bin_dir / name
        launcher = (
            f"#!{sys.executable}\n"
            "import os, sys\n"
            f"REAL = {str(real)!r}\n"
            "args = sys.argv[1:]\n"
            "# The real surface is [binary, --config CFG, daemon]: the global\n"
            "# --config precedes the subcommand, so match on membership.\n"
            "if 'daemon' in args:\n"
            f"    args += {daemon_extra}\n"
            "if 'record' in args:\n"
            f"    args += {record_extra}\n"
            "os.execv(REAL, [REAL] + args)\n"
        )
        binary.write_text(launcher, encoding="utf-8")
        binary.chmod(0o755)
    return bin_dir / VARIANT_BINARIES[0]


def pinned_manifest_json(digest: str) -> str:
    """Two pinned artifacts (v1.0.1 schema) sharing the fixture digest."""
    artifacts = []
    for artifact_id, variant in (
        ("voxtype-avx2", "cpu"),
        ("voxtype-vulkan", "vulkan"),
    ):
        artifacts.append(
            {
                "id": artifact_id,
                "engine": "whisper",
                "arch": "x86_64",
                "variant": variant,
                "version": "v9.9.9-test",
                "source": f"https://example.test/voxtype/releases/v9.9.9/{artifact_id}",
                "sha256": digest,
                "license": "MIT",
            }
        )
    return json.dumps({"schemaVersion": 1, "artifacts": artifacts}, indent=2) + "\n"


def write_pinned_runtime_manifest(
    plugin_root: Path,
    binary: Path | None = None,
    *,
    digest: str | None = None,
) -> Path:
    """Pin defaults/runtime-manifest.json to the exact fixture binary bytes.

    `digest` overrides hashing (used when the binaries are deliberately
    absent).
    """
    if digest is None:
        assert binary is not None
        digest = hashlib.sha256(binary.read_bytes()).hexdigest()
    defaults = plugin_root / "defaults"
    defaults.mkdir(parents=True, exist_ok=True)
    path = defaults / "runtime-manifest.json"
    path.write_text(pinned_manifest_json(digest), encoding="utf-8")
    return path


def make_resolver(
    paths: PluginPaths,
    *,
    probe_decision: str = "vulkan",
    probe_calls: list[int] | None = None,
) -> RuntimeVariantResolver:
    """Resolver with an injected §47 probe decision (no subprocess)."""

    async def fake_probe(resolver: RuntimeVariantResolver, config_path: Path) -> bool:
        if probe_calls is not None:
            probe_calls.append(1)
        return probe_decision == "vulkan"

    return RuntimeVariantResolver(paths, probe=fake_probe)


def make_supervisor(
    paths: PluginPaths,
    publisher: FakeEventPublisher,
    *,
    resolver: RuntimeVariantResolver | None = None,
    model_path_for: Any = None,
    **kwargs: object,
) -> SpeechDaemonSupervisor:
    """Supervisor over the fixture binaries with an injected probe."""
    kwargs.setdefault("restart_base_delay", 0.05)
    kwargs.setdefault("restart_max_delay", 0.2)
    if resolver is None:
        resolver = make_resolver(paths)
    if model_path_for is None:
        model_path_for = lambda model_id: paths.models_dir / f"ggml-{model_id}.bin"  # noqa: E731
    return SpeechDaemonSupervisor(  # type: ignore[arg-type]
        paths,
        publisher,
        resolver,
        model_path_for=model_path_for,
        **kwargs,
    )


def write_test_daemon_config(paths: PluginPaths, model_id: str = "base") -> Path:
    """Generate a daemon config through the production generator."""
    from backend.domain.contracts import DEFAULT_SETTINGS

    return write_daemon_config(
        paths,
        DEFAULT_SETTINGS,
        paths.models_dir / f"ggml-{model_id}.bin",
    )


async def spawn_fixture_daemon(
    paths: PluginPaths, binary: Path, **extra_daemon_args: str
) -> asyncio.subprocess.Process:
    """Start the fixture daemon directly (client-level tests).

    The daemon is started exactly like the supervisor starts it: via the
    generated TOML config and the real global-flag surface.
    """
    config_path = write_test_daemon_config(paths)
    argv = [str(binary), "--config", str(config_path), "daemon"]
    for name, value in extra_daemon_args.items():
        flag = f"--{name.replace('_', '-')}"
        if value is True:
            argv.append(flag)  # boolean store_true flag
        else:
            argv.extend([flag, str(value)])
    proc = await asyncio.create_subprocess_exec(
        *argv,
        stdout=asyncio.subprocess.DEVNULL,
        stderr=asyncio.subprocess.DEVNULL,
        stdin=asyncio.subprocess.DEVNULL,
        env=child_environment(paths.data_dir),
        start_new_session=True,
    )
    if not await wait_until(lambda: paths.status_file.exists(), timeout=3.0):
        proc.kill()
        await proc.wait()
        pytest.fail("fixture daemon never wrote its state file")
    return proc


async def stop_process_group(proc: asyncio.subprocess.Process) -> None:
    if proc.returncode is None:
        with contextlib.suppress(ProcessLookupError):
            os.killpg(proc.pid, signal.SIGTERM)
        try:
            await asyncio.wait_for(proc.wait(), 3.0)
        except TimeoutError:
            os.killpg(proc.pid, signal.SIGKILL)
            await proc.wait()


def make_paths(tmp_path: Path, *, name: str = "root") -> PluginPaths:
    paths = PluginPaths(plugin_root=tmp_path / name, data_dir=tmp_path / f"{name}-data")
    ensure_directories(paths)
    return paths

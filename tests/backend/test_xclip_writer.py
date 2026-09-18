"""XclipClipboardWriter tests (v0.2 clipboard leg): status mapping, env
resolution, §73/§109 hygiene. The real xclip is substituted by a scripted
stand-in binary so spawn/exit/timeout paths run for real (no X server).
"""

from __future__ import annotations

import asyncio
import os
import stat
import sys
from pathlib import Path

from backend.infrastructure.clipboard.xclip_writer import XclipClipboardWriter
from backend.infrastructure.process.process_environment import (
    PluginPaths,
    ensure_directories,
)


def make_paths(tmp_path: Path) -> PluginPaths:
    paths = PluginPaths(plugin_root=tmp_path / "root", data_dir=tmp_path / "data")
    ensure_directories(paths)
    return paths


def write_stub_xclip(paths: PluginPaths, body: str) -> Path:
    bin_dir = paths.plugin_root / "bin"
    bin_dir.mkdir(parents=True, exist_ok=True)
    binary = bin_dir / "xclip"
    binary.write_text(f"#!{sys.executable}\n{body}", encoding="utf-8")
    binary.chmod(stat.S_IRUSR | stat.S_IWUSR | stat.S_IXUSR)
    return binary


def gamescope_env(tmp_path: Path, display: str) -> Path:
    env_file = tmp_path / "gamescope-environment"
    env_file.write_text(f"FOO=bar\nDISPLAY={display}\n", encoding="utf-8")
    return env_file


def test_missing_binary_reports_skipped(tmp_path: Path) -> None:
    paths = make_paths(tmp_path)
    writer = XclipClipboardWriter(
        paths.plugin_root / "bin" / "xclip", staging_dir=paths.runtime_dir
    )
    # v0.2.0 pin decision: no binary shipped → the backend leg reports
    # "skipped" and the transcription flow is otherwise untouched.
    assert writer.is_available() is False
    assert asyncio.run(writer.write_text("hello")) == "skipped"


def test_successful_copy_reports_ok_and_keeps_text_out_of_pipes(tmp_path: Path) -> None:
    async def scenario() -> None:
        paths = make_paths(tmp_path)
        received: list[str] = []

        body = (
            "import sys\n"
            "data = open(sys.argv[-1], encoding='utf-8').read()\n"
            f"open({str(tmp_path / 'captured.txt')!r}, 'w').write(data)\n"
            "sys.exit(0)\n"
        )
        write_stub_xclip(paths, body)
        writer = XclipClipboardWriter(
            paths.plugin_root / "bin" / "xclip",
            staging_dir=paths.runtime_dir,
            gamescope_environment_file=gamescope_env(tmp_path, ":1"),
            xauthority_file=tmp_path / "absent-Xauthority",
        )
        status = await writer.write_text("hello world")
        assert status == "ok"
        captured = (tmp_path / "captured.txt").read_text(encoding="utf-8")
        received.append(captured)
        # The transcript reached the binary byte-exact via the staging file.
        assert received == ["hello world"]
        # §109: staging files are transient — none remain afterwards.
        assert list(paths.runtime_dir.glob(".clipboard-*")) == []

    asyncio.run(scenario())


def test_nonzero_exit_and_spawn_failure_map_to_failed(tmp_path: Path) -> None:
    async def scenario() -> None:
        paths = make_paths(tmp_path)
        write_stub_xclip(paths, "import sys\nsys.exit(1)\n")
        writer = XclipClipboardWriter(
            paths.plugin_root / "bin" / "xclip",
            staging_dir=paths.runtime_dir,
            gamescope_environment_file=gamescope_env(tmp_path, ":0"),
        )
        assert await writer.write_text("text") == "failed"

        # Binary present but not executable → spawn OSError → "failed".
        broken = paths.plugin_root / "bin" / "xclip"
        broken.chmod(stat.S_IRUSR | stat.S_IWUSR)
        assert await writer.write_text("text") == "failed"

    asyncio.run(scenario())


def test_timeout_kills_the_child_and_maps_to_failed(tmp_path: Path) -> None:
    async def scenario() -> None:
        paths = make_paths(tmp_path)
        write_stub_xclip(paths, "import time\ntime.sleep(30)\n")
        writer = XclipClipboardWriter(
            paths.plugin_root / "bin" / "xclip",
            staging_dir=paths.runtime_dir,
            timeout_s=0.1,
            gamescope_environment_file=gamescope_env(tmp_path, ":0"),
        )
        import time as time_module

        started = time_module.monotonic()
        assert await writer.write_text("text") == "failed"
        assert time_module.monotonic() - started < 5.0  # bounded, not 30 s
        assert list(paths.runtime_dir.glob(".clipboard-*")) == []

    asyncio.run(scenario())


def test_display_and_xauthority_resolution(tmp_path: Path) -> None:
    async def scenario() -> None:
        paths = make_paths(tmp_path)
        seen_env: dict[str, str] = {}

        body = (
            "import json, os, sys\n"
            f"open({str(tmp_path / 'env.json')!r}, 'w').write("
            "json.dumps({k: os.environ.get(k) for k in ('DISPLAY', 'XAUTHORITY', 'HOME')}))\n"
            "sys.exit(0)\n"
        )
        write_stub_xclip(paths, body)
        xauthority = tmp_path / "xauthority"
        xauthority.write_text("xauth-bytes", encoding="utf-8")

        writer = XclipClipboardWriter(
            paths.plugin_root / "bin" / "xclip",
            staging_dir=paths.runtime_dir,
            gamescope_environment_file=gamescope_env(tmp_path, ":63"),
            xauthority_file=xauthority,
        )
        assert await writer.write_text("text") == "ok"
        seen_env = dict(
            __import__("json").loads((tmp_path / "env.json").read_text(encoding="utf-8"))
        )
        # DISPLAY from the gamescope environment file; XAUTHORITY only when
        # the file exists (DeckyClipboard pattern).
        assert seen_env["DISPLAY"] == ":63"
        assert seen_env["XAUTHORITY"] == str(xauthority)

        # Missing gamescope file → documented ":0" fallback.
        writer_fallback = XclipClipboardWriter(
            paths.plugin_root / "bin" / "xclip",
            staging_dir=paths.runtime_dir,
            gamescope_environment_file=tmp_path / "absent-gamescope-env",
            xauthority_file=tmp_path / "absent-Xauthority",
        )
        assert await writer_fallback.write_text("text") == "ok"
        seen_env = dict(
            __import__("json").loads((tmp_path / "env.json").read_text(encoding="utf-8"))
        )
        assert seen_env["DISPLAY"] == ":0"
        assert seen_env["XAUTHORITY"] is None

    asyncio.run(scenario())


def test_unwritable_staging_dir_maps_to_failed_not_crash(tmp_path: Path) -> None:
    paths = make_paths(tmp_path)
    write_stub_xclip(paths, "sys.exit(0)\n")
    writer = XclipClipboardWriter(
        paths.plugin_root / "bin" / "xclip",
        staging_dir=paths.plugin_root / "settings-file-is-not-a-dir",
        gamescope_environment_file=gamescope_env(tmp_path, ":0"),
    )
    # Force an unwritable staging location: a FILE where the dir would be.
    blocker = paths.plugin_root / "settings-file-is-not-a-dir"
    blocker.parent.mkdir(parents=True, exist_ok=True)
    blocker.write_text("not a directory", encoding="utf-8")
    os.chmod(blocker.parent, 0o500)  # read-only parent for extra safety
    try:
        assert asyncio.run(writer.write_text("text")) == "failed"
    finally:
        os.chmod(blocker.parent, 0o700)

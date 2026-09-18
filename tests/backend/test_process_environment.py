"""Unit tests for the child-process environment policy (§40, §109).

On-device defect (deck 2026-09-18, daemon.log): with `XDG_RUNTIME_DIR`
overridden to the plugin runtime dir, ALSA's pipewire PCM plugin could not
find the session audio server — every `record start` failed with
`snd_pcm_open: Host is down (112)`, no level frames were ever broadcast and
no transcript was ever produced (3 recordings started, 0 transcribed).
`child_environment` must re-expose the REAL session runtime dir under
`PIPEWIRE_RUNTIME_DIR` (which libpipewire resolves before `XDG_RUNTIME_DIR`)
while keeping the voxtype-state override intact.
"""

from pathlib import Path

import pytest
from backend.infrastructure.process.process_environment import child_environment


def test_child_environment_reexposes_session_runtime_dir_for_audio(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """The real session runtime dir travels as PIPEWIRE_RUNTIME_DIR; the
    voxtype state override of XDG_RUNTIME_DIR stays untouched."""
    monkeypatch.setenv("XDG_RUNTIME_DIR", "/run/user/1000")

    env = child_environment(tmp_path)

    assert env["XDG_RUNTIME_DIR"] == str(tmp_path / "runtime")
    assert env["PIPEWIRE_RUNTIME_DIR"] == "/run/user/1000"
    assert env["HOME"] == str(tmp_path)
    assert env["LANG"] == "C.UTF-8"
    assert env["LC_ALL"] == "C.UTF-8"
    assert "PATH" in env


def test_child_environment_omits_audio_dir_without_a_session(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """No invented paths: without a session runtime dir in the plugin process
    (tests, CI) the audio key is simply absent — deterministic env either way."""
    monkeypatch.delenv("XDG_RUNTIME_DIR", raising=False)

    env = child_environment(tmp_path)

    assert "PIPEWIRE_RUNTIME_DIR" not in env
    assert env["XDG_RUNTIME_DIR"] == str(tmp_path / "runtime")
    assert set(env) == {"PATH", "HOME", "XDG_RUNTIME_DIR", "LANG", "LC_ALL"}

"""Unit tests for the child-process environment policy.

On-device defect (from the daemon log): with `XDG_RUNTIME_DIR`
overridden to the plugin runtime dir, ALSA's pipewire PCM plugin could not
find the session audio server — every `record start` failed with
`snd_pcm_open: Host is down (112)`, no level frames were ever broadcast and
no transcript was ever produced (3 recordings started, 0 transcribed).
`child_environment` must re-expose the REAL session runtime dir under
`PIPEWIRE_RUNTIME_DIR` (which libpipewire resolves before `XDG_RUNTIME_DIR`)
while keeping the voxtype-state override intact.

Second on-device pass: the installed first fix never
reached the daemon — the Decky-loader-spawned plugin process itself carries
NO `XDG_RUNTIME_DIR` (daemon env proved it: the key was absent while the new
code was running). The session dir therefore falls back to the XDG-standard
`/run/user/<uid>`, forwarded only when that directory really exists.

Third on-device pass (cold boot): the backend process was
spawned as ROOT, so its own `os.getuid()` resolved `/run/user/0` (missing)
and the key was omitted again. The uid now comes from the plugin data
directory's OWNER (`os.stat(data_dir).st_uid`, injectable as
`uid_resolver`): the daemon always runs as that user, whatever uid the
backend process happens to carry.
"""

from pathlib import Path

import pytest
from backend.infrastructure.process.process_environment import (
    child_environment,
    session_runtime_dir,
)


def test_env_value_wins_for_audio_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """The plugin process's real session runtime dir travels as
    PIPEWIRE_RUNTIME_DIR; the voxtype state override stays untouched."""
    monkeypatch.setenv("XDG_RUNTIME_DIR", "/run/user/1000")

    assert session_runtime_dir(tmp_path) == "/run/user/1000"
    env = child_environment(tmp_path)
    assert env["XDG_RUNTIME_DIR"] == str(tmp_path / "runtime")
    assert env["PIPEWIRE_RUNTIME_DIR"] == "/run/user/1000"
    assert env["HOME"] == str(tmp_path)
    assert env["LANG"] == "C.UTF-8"
    assert env["LC_ALL"] == "C.UTF-8"
    assert "PATH" in env


def test_data_dir_owner_uid_wins_over_process_uid(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """Cold-boot defect: the backend ran as ROOT while the
    daemon runs as the data dir's owner (deck, 1000). The session dir must
    resolve from the OWNER's uid, never the backend process's own."""
    monkeypatch.delenv("XDG_RUNTIME_DIR", raising=False)
    monkeypatch.setattr("os.getuid", lambda: 0)  # root backend, the defect condition
    base = tmp_path / "run" / "user"
    (base / "1000").mkdir(parents=True)

    resolved = session_runtime_dir(tmp_path, session_base=base, uid_resolver=lambda _data_dir: 1000)
    assert resolved == str(base / "1000")


def test_no_invented_session_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    """A nonexistent /run/user/<owner-uid> yields nothing: the audio key is
    absent rather than pointing children at a path that does not exist."""
    monkeypatch.delenv("XDG_RUNTIME_DIR", raising=False)
    monkeypatch.setattr("os.getuid", lambda: 4242)
    base = tmp_path / "run" / "user"
    base.mkdir(parents=True)

    assert (
        session_runtime_dir(tmp_path, session_base=base, uid_resolver=lambda _data_dir: 4242)
        is None
    )
    # Real wiring: child_environment uses the stat-based owner resolution by
    # default; the empty session base contains no <uid> entry for tmp_path's
    # owner, so the key must be absent.
    env = child_environment(tmp_path, session_base=base)
    assert "PIPEWIRE_RUNTIME_DIR" not in env
    assert env["XDG_RUNTIME_DIR"] == str(tmp_path / "runtime")
    assert set(env) == {"PATH", "HOME", "XDG_RUNTIME_DIR", "LANG", "LC_ALL"}


def test_empty_environment_variable_is_not_forwarded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """An empty XDG_RUNTIME_DIR (the loader's empty-string global pattern)
    must not become an empty audio path; the owner-uid fallback decides."""
    monkeypatch.setenv("XDG_RUNTIME_DIR", "")
    monkeypatch.setattr("os.getuid", lambda: 4242)
    base = tmp_path / "run" / "user"
    base.mkdir(parents=True)

    assert (
        session_runtime_dir(tmp_path, session_base=base, uid_resolver=lambda _data_dir: 4242)
        is None
    )

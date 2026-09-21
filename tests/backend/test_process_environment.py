from pathlib import Path

import pytest
from backend.infrastructure.process.process_environment import (
    child_environment,
    session_runtime_dir,
)


def test_env_value_wins_for_audio_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
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
    monkeypatch.delenv("XDG_RUNTIME_DIR", raising=False)
    monkeypatch.setattr("os.getuid", lambda: 0)
    base = tmp_path / "run" / "user"
    (base / "1000").mkdir(parents=True)

    resolved = session_runtime_dir(tmp_path, session_base=base, uid_resolver=lambda _data_dir: 1000)
    assert resolved == str(base / "1000")


def test_no_invented_session_dir(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.delenv("XDG_RUNTIME_DIR", raising=False)
    monkeypatch.setattr("os.getuid", lambda: 4242)
    base = tmp_path / "run" / "user"
    base.mkdir(parents=True)

    assert (
        session_runtime_dir(tmp_path, session_base=base, uid_resolver=lambda _data_dir: 4242)
        is None
    )
    env = child_environment(tmp_path, session_base=base)
    assert "PIPEWIRE_RUNTIME_DIR" not in env
    assert env["XDG_RUNTIME_DIR"] == str(tmp_path / "runtime")
    assert set(env) == {"PATH", "HOME", "XDG_RUNTIME_DIR", "LANG", "LC_ALL"}


def test_empty_environment_variable_is_not_forwarded(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("XDG_RUNTIME_DIR", "")
    monkeypatch.setattr("os.getuid", lambda: 4242)
    base = tmp_path / "run" / "user"
    base.mkdir(parents=True)

    assert (
        session_runtime_dir(tmp_path, session_base=base, uid_resolver=lambda _data_dir: 4242)
        is None
    )

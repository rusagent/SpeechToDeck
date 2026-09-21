from __future__ import annotations

import contextlib
import os
from collections.abc import Callable
from pathlib import Path

from backend.domain.errors import ManifestInvalidError

DIR_MODE = 0o700
PRIVATE_FILE_MODE = 0o600

VARIANT_BINARY_NAMES = {"cpu": "voxtype-avx2", "vulkan": "voxtype-vulkan"}

NATIVE_DIRNAME = "voxtype"
STATUS_FILENAME = "state"
OUTPUT_FILENAME = "transcript.out"
OUTPUT_SIDECAR_SUFFIX = ".done"
DAEMON_CONFIG_NAME = "daemon.toml"
DAEMON_LOG_NAME = "daemon.log"
SETTINGS_FILENAME = "settings.json"
AUDIO_SOCKET_FILENAME = "audio.sock"

DEFAULTS_DIRNAME = "defaults"


def resolve_defaults_file(plugin_root: Path, filename: str) -> Path:

    root = plugin_root.resolve()
    flattened = plugin_root / filename
    nested = plugin_root / DEFAULTS_DIRNAME / filename
    if flattened.is_file():
        candidate = flattened
    elif nested.is_file():
        candidate = nested
    else:
        candidate = flattened
    resolved = candidate.resolve()
    if not resolved.is_relative_to(root):
        raise ManifestInvalidError(
            "defaults file resolves outside the plugin root",
            detail=f"filename={filename!r}",
        )
    return candidate


class PluginPaths:
    def __init__(self, plugin_root: Path, data_dir: Path) -> None:
        self.plugin_root = plugin_root
        self.data_dir = data_dir

    @property
    def bin_dir(self) -> Path:
        return self.plugin_root / "bin"

    @property
    def defaults_dir(self) -> Path:
        return self.plugin_root / DEFAULTS_DIRNAME

    def runtime_binary(self, variant: str) -> Path:

        return self.bin_dir / VARIANT_BINARY_NAMES[variant]

    @property
    def models_manifest(self) -> Path:
        return resolve_defaults_file(self.plugin_root, "models.json")

    @property
    def runtime_manifest(self) -> Path:
        return resolve_defaults_file(self.plugin_root, "runtime-manifest.json")

    @property
    def models_dir(self) -> Path:
        return self.data_dir / "models"

    @property
    def runtime_dir(self) -> Path:
        return self.data_dir / "runtime"

    @property
    def native_runtime_dir(self) -> Path:

        return self.runtime_dir / NATIVE_DIRNAME

    @property
    def status_file(self) -> Path:
        return self.native_runtime_dir / STATUS_FILENAME

    @property
    def output_file(self) -> Path:
        return self.native_runtime_dir / OUTPUT_FILENAME

    @property
    def output_sidecar_file(self) -> Path:
        return self.native_runtime_dir / (OUTPUT_FILENAME + OUTPUT_SIDECAR_SUFFIX)

    @property
    def audio_socket(self) -> Path:

        return self.native_runtime_dir / AUDIO_SOCKET_FILENAME

    @property
    def daemon_config(self) -> Path:
        return self.runtime_dir / DAEMON_CONFIG_NAME

    @property
    def daemon_log(self) -> Path:
        return self.runtime_dir / DAEMON_LOG_NAME

    @property
    def settings_file(self) -> Path:
        return self.data_dir / SETTINGS_FILENAME


def ensure_directories(paths: PluginPaths) -> None:

    for directory in (
        paths.data_dir,
        paths.models_dir,
        paths.runtime_dir,
        paths.native_runtime_dir,
    ):
        directory.mkdir(parents=True, exist_ok=True)
        os.chmod(directory, DIR_MODE)


def _data_dir_owner_uid(data_dir: Path) -> int:
    return os.stat(data_dir).st_uid


def session_runtime_dir(
    data_dir: Path,
    *,
    session_base: Path | None = None,
    uid_resolver: Callable[[Path], int] | None = None,
) -> str | None:

    from_env = os.environ.get("XDG_RUNTIME_DIR")
    if from_env:
        return from_env
    resolver = uid_resolver or _data_dir_owner_uid
    candidate = (session_base or Path("/run/user")) / str(resolver(data_dir))
    if candidate.is_dir():
        return str(candidate)
    return None


def child_environment(data_dir: Path, *, session_base: Path | None = None) -> dict[str, str]:

    path_value = os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin")
    env = {
        "PATH": path_value,
        "HOME": str(data_dir),
        "XDG_RUNTIME_DIR": str(data_dir / "runtime"),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
    }
    session_dir = session_runtime_dir(data_dir, session_base=session_base)
    if session_dir is not None:
        env["PIPEWIRE_RUNTIME_DIR"] = session_dir
    return env


def apply_private_file_mode(path: Path) -> None:

    with contextlib.suppress(OSError):
        os.chmod(path, PRIVATE_FILE_MODE)

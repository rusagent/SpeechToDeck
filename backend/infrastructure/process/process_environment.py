"""Child-process environment and plugin path policy (§39, §40, §109, §110).

All writable paths live under the Decky plugin data directory (§109); the
native runtime binary is read from the plugin install directory. Child
processes receive a minimal, deterministic environment so no untrusted
variable leaks into native execution.
"""

from __future__ import annotations

import contextlib
import os
from pathlib import Path

from backend.domain.errors import ManifestInvalidError

DIR_MODE = 0o700
PRIVATE_FILE_MODE = 0o600

RUNTIME_BINARY_NAME = "voxtype"
STATUS_FILENAME = "status.json"
OUTPUT_FILENAME = "transcript.out"
CONTROL_SOCKET_NAME = "control.sock"
DAEMON_LOG_NAME = "daemon.log"
SETTINGS_FILENAME = "settings.json"

DEFAULTS_DIRNAME = "defaults"


def resolve_defaults_file(plugin_root: Path, filename: str) -> Path:
    """The single resolver for shipped defaults files across both layouts.

    Two layouts exist for the same files:

    - Installed package (Decky loader): the packager **flattens**
      `defaults/` into the plugin root, so the files sit at
      `<plugin_root>/<filename>` next to `main.py`.
    - Repository checkout (development): the files are committed under
      `<plugin_root>/defaults/<filename>`.

    The packaged (flattened) location wins when both exist because the
    shipped artifact is what users run. When neither exists, the flattened
    path is returned so fail-closed loaders report a stable location.
    Read-only existence probes only; no filesystem effects.

    §109 traversal hardening: after resolution the candidate must stay
    inside the plugin root (both sanctioned layouts live there); any
    resolved path that escapes it is rejected with the stable §68
    `MANIFEST_INVALID` code instead of being returned.
    """
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
    """Resolved plugin locations.

    Writable paths are pure descriptions with no filesystem effects; the
    defaults properties additionally probe (read-only) which shipped layout
    is present via `resolve_defaults_file`.
    """

    def __init__(self, plugin_root: Path, data_dir: Path) -> None:
        self.plugin_root = plugin_root
        self.data_dir = data_dir

    @property
    def bin_dir(self) -> Path:
        # bin/ is NOT flattened by the packager: the shipped layout keeps it.
        return self.plugin_root / "bin"

    @property
    def defaults_dir(self) -> Path:
        """Development layout location; installed packages flatten this away."""
        return self.plugin_root / DEFAULTS_DIRNAME

    @property
    def runtime_binary(self) -> Path:
        return self.bin_dir / RUNTIME_BINARY_NAME

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
    def status_file(self) -> Path:
        return self.runtime_dir / STATUS_FILENAME

    @property
    def output_file(self) -> Path:
        return self.runtime_dir / OUTPUT_FILENAME

    @property
    def control_socket(self) -> Path:
        return self.runtime_dir / CONTROL_SOCKET_NAME

    @property
    def daemon_log(self) -> Path:
        return self.runtime_dir / DAEMON_LOG_NAME

    @property
    def settings_file(self) -> Path:
        return self.data_dir / SETTINGS_FILENAME


def ensure_directories(paths: PluginPaths) -> None:
    """Create writable directories with user-only permissions (§109, §110)."""
    for directory in (paths.data_dir, paths.models_dir, paths.runtime_dir):
        directory.mkdir(parents=True, exist_ok=True)
        os.chmod(directory, DIR_MODE)


def child_environment(data_dir: Path) -> dict[str, str]:
    """Minimal environment for native children (§40, §109).

    Only deterministic variables are forwarded; HOME points into the plugin
    data dir so naive child writes cannot escape it (§109).
    """
    path_value = os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin")
    return {
        "PATH": path_value,
        "HOME": str(data_dir),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
    }


def apply_private_file_mode(path: Path) -> None:
    """Best-effort user-only file permissions (§110).

    Permission enforcement is defense in depth; the data dir is already 0o700,
    so failure here never blocks the operation.
    """
    with contextlib.suppress(OSError):
        os.chmod(path, PRIVATE_FILE_MODE)

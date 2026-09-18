"""Child-process environment and plugin path policy (§39, §40, §109, §110).

All writable paths live under the Decky plugin data directory (§109); the
native runtime binaries are read from the plugin install directory (the Decky
loader places each `remote_binary` entry at `<plugin_dir>/bin/<name>`).

The Voxtype v1.0.1 runtime derives its control sentinels (state file, pid
file, cancel trigger, per-recording overrides) from `$XDG_RUNTIME_DIR/voxtype`
(upstream `Config::runtime_dir`), so child processes receive `XDG_RUNTIME_DIR`
pointed at the plugin runtime directory: every native write stays inside the
plugin data dir and cannot collide with a system-wide voxtype install. The
session audio server is the one sanctioned exception: libpipewire must reach
the REAL session socket, so `child_environment` forwards it under
`PIPEWIRE_RUNTIME_DIR` (see there for the on-device failure this fixed).
"""

from __future__ import annotations

import contextlib
import os
from pathlib import Path

from backend.domain.errors import ManifestInvalidError

DIR_MODE = 0o700
PRIVATE_FILE_MODE = 0o600

# Binary file names shipped by the Decky loader `remote_binary` entries
# (package.json). The variant selects which one runs; names are pinned by
# defaults/runtime-manifest.json artifact ids.
VARIANT_BINARY_NAMES = {"cpu": "voxtype-avx2", "vulkan": "voxtype-vulkan"}

# Native runtime files, all inside NATIVE_DIRNAME under the runtime dir
# (upstream writes state/pid/cancel/overrides next to the state file there).
NATIVE_DIRNAME = "voxtype"
STATUS_FILENAME = "state"
OUTPUT_FILENAME = "transcript.out"
OUTPUT_SIDECAR_SUFFIX = ".done"
DAEMON_CONFIG_NAME = "daemon.toml"
DAEMON_LOG_NAME = "daemon.log"
SETTINGS_FILENAME = "settings.json"
# Live audio-level broadcast socket of the pinned runtime (upstream
# levels.rs `default_socket_path`: `$XDG_RUNTIME_DIR/voxtype/audio.sock`).
AUDIO_SOCKET_FILENAME = "audio.sock"

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

    def runtime_binary(self, variant: str) -> Path:
        """Pinned binary for a compute variant (§53: resolved, never guessed).

        `variant` is a settings-facing backend (`cpu`/`vulkan`) mapped to the
        exact loader-installed binary name. Unknown variants fail closed via
        the KeyError upstream — callers only pass validated settings values.
        """
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
        """Directory the native daemon uses for state/pid/cancel/overrides.

        Mirrors the upstream `$XDG_RUNTIME_DIR/voxtype` layout with
        `XDG_RUNTIME_DIR` pointed at the plugin runtime directory.
        """
        return self.runtime_dir / NATIVE_DIRNAME

    @property
    def status_file(self) -> Path:
        """Bare-word daemon state file (upstream `state_file` config key)."""
        return self.native_runtime_dir / STATUS_FILENAME

    @property
    def output_file(self) -> Path:
        """Final transcript for the current recording (file output mode)."""
        return self.native_runtime_dir / OUTPUT_FILENAME

    @property
    def output_sidecar_file(self) -> Path:
        """Completion sidecar the daemon writes after the transcript itself."""
        return self.native_runtime_dir / (OUTPUT_FILENAME + OUTPUT_SIDECAR_SUFFIX)

    @property
    def audio_socket(self) -> Path:
        """Daemon's audio-level broadcast socket (upstream levels.rs).

        `Config::runtime_dir()` is `$XDG_RUNTIME_DIR/voxtype` and children get
        `XDG_RUNTIME_DIR` pointed at the plugin runtime dir, so this mirrors
        the upstream `default_socket_path()` exactly.
        """
        return self.native_runtime_dir / AUDIO_SOCKET_FILENAME

    @property
    def daemon_config(self) -> Path:
        """Generated TOML config handed to the daemon via `--config`."""
        return self.runtime_dir / DAEMON_CONFIG_NAME

    @property
    def daemon_log(self) -> Path:
        return self.runtime_dir / DAEMON_LOG_NAME

    @property
    def settings_file(self) -> Path:
        return self.data_dir / SETTINGS_FILENAME


def ensure_directories(paths: PluginPaths) -> None:
    """Create writable directories with user-only permissions (§109, §110).

    The native runtime directory must exist before any child starts: the
    inotify watcher binds to it and the daemon derives it from
    `XDG_RUNTIME_DIR` (it creates the directory itself if missing, but the
    watcher has no such fallback).
    """
    for directory in (
        paths.data_dir,
        paths.models_dir,
        paths.runtime_dir,
        paths.native_runtime_dir,
    ):
        directory.mkdir(parents=True, exist_ok=True)
        os.chmod(directory, DIR_MODE)


def child_environment(data_dir: Path) -> dict[str, str]:
    """Minimal environment for native children (§40, §109).

    Only deterministic variables are forwarded; HOME points into the plugin
    data dir and XDG_RUNTIME_DIR into the plugin runtime dir so naive child
    writes cannot escape the plugin data directory (§109). Both directories
    must exist (see `ensure_directories`) before children are spawned.

    Audio-server exception (deck defect 2026-09-18): the daemon captures
    through ALSA's pipewire PCM plugin, and libpipewire resolves the session
    server socket (`pipewire-0`) from PIPEWIRE_RUNTIME_DIR, falling back to
    XDG_RUNTIME_DIR. With only the override below the plugin had no reachable
    server at all — every recording failed with `snd_pcm_open: Host is down
    (112)` before any level frame or transcript could exist. The plugin
    process's REAL session runtime dir (systemd user units always provide it)
    is therefore re-exposed under the audio-specific name; the voxtype state
    override stays authoritative. Without one (tests, CI) the key is simply
    absent — no invented paths.
    """
    path_value = os.environ.get("PATH", "/usr/local/bin:/usr/bin:/bin")
    env = {
        "PATH": path_value,
        "HOME": str(data_dir),
        "XDG_RUNTIME_DIR": str(data_dir / "runtime"),
        "LANG": "C.UTF-8",
        "LC_ALL": "C.UTF-8",
    }
    session_runtime_dir = os.environ.get("XDG_RUNTIME_DIR")
    if session_runtime_dir:
        env["PIPEWIRE_RUNTIME_DIR"] = session_runtime_dir
    return env


def apply_private_file_mode(path: Path) -> None:
    """Best-effort user-only file permissions (§110).

    Permission enforcement is defense in depth; the data dir is already 0o700,
    so failure here never blocks the operation.
    """
    with contextlib.suppress(OSError):
        os.chmod(path, PRIVATE_FILE_MODE)

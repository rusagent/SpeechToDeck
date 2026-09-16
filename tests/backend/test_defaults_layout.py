"""Defaults file resolution across the two shipped layouts (store contract).

The Decky packager flattens `defaults/` into the plugin root of an installed
package, while a repository checkout keeps the files under `defaults/`. These
tests pin the single resolver (`resolve_defaults_file`, consumed by
`PluginPaths.models_manifest` / `PluginPaths.runtime_manifest`) for both
layouts, the conflict rule, and that `compose()` loads the installed layout.
"""

from __future__ import annotations

import json
import shutil
from pathlib import Path

import pytest
from backend.composition import compose
from backend.domain.errors import ManifestInvalidError
from backend.infrastructure.process.process_environment import (
    PluginPaths,
    resolve_defaults_file,
)

REPO_ROOT = Path(__file__).resolve().parents[2]
REAL_MODELS_MANIFEST = REPO_ROOT / "defaults" / "models.json"


def _stage_flattened(plugin_root: Path) -> None:
    """Temp-dir fixture shaped like an installed package: flattened defaults."""
    plugin_root.mkdir(parents=True)
    shutil.copy(REAL_MODELS_MANIFEST, plugin_root / "models.json")


def _stage_dev(plugin_root: Path) -> None:
    """Temp-dir fixture shaped like the repository checkout."""
    defaults = plugin_root / "defaults"
    defaults.mkdir(parents=True)
    shutil.copy(REAL_MODELS_MANIFEST, defaults / "models.json")


def test_dev_layout_resolves_into_defaults_dir(tmp_path: Path) -> None:
    root = tmp_path / "checkout"
    _stage_dev(root)
    paths = PluginPaths(plugin_root=root, data_dir=tmp_path / "data")
    assert paths.models_manifest == root / "defaults" / "models.json"
    assert paths.models_manifest.is_file()


def test_installed_layout_resolves_flattened_files(tmp_path: Path) -> None:
    # The packaged top-level dir is named exactly plugin.json "name".
    root = tmp_path / "SpeechToDeck"
    _stage_flattened(root)
    paths = PluginPaths(plugin_root=root, data_dir=tmp_path / "data")
    assert paths.models_manifest == root / "models.json"
    assert paths.models_manifest.is_file()
    # Missing file: the flattened path is the stable fail-closed location.
    assert paths.runtime_manifest == root / "runtime-manifest.json"


def test_packaged_layout_wins_when_both_exist(tmp_path: Path) -> None:
    root = tmp_path / "plugin"
    _stage_dev(root)
    (root / "models.json").write_text('{"marker": "packaged"}\n', encoding="utf-8")
    assert resolve_defaults_file(root, "models.json") == root / "models.json"


def test_resolver_rejects_paths_outside_plugin_root(tmp_path: Path) -> None:
    """§109 traversal hardening: a filename that resolves outside the plugin
    root is never returned — the resolver fails closed with the stable §68
    `MANIFEST_INVALID` code, in both layouts and for existing targets."""
    root = tmp_path / "checkout"
    _stage_dev(root)
    # An existing file OUTSIDE the root that a traversal filename resolves to.
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "models.json").write_text("{}", encoding="utf-8")
    # Existing traversal target (flattened candidate exists, outside root).
    with pytest.raises(ManifestInvalidError):
        resolve_defaults_file(root, "../outside/models.json")
    # Missing traversal target (neither candidate exists, path escapes).
    with pytest.raises(ManifestInvalidError):
        resolve_defaults_file(root, "../../etc/models.json")


def test_composition_loads_manifest_from_installed_layout(tmp_path: Path) -> None:
    root = tmp_path / "SpeechToDeck"
    _stage_flattened(root)
    app = compose(plugin_root=root, data_dir=tmp_path / "data")
    assert {model.id for model in app.manifest.models} == {"tiny", "base", "small"}


def test_remote_binary_entries_match_pinned_runtime_manifest() -> None:
    """§53 integrity: the loader `remote_binary` entries (what the Decky
    loader downloads at install time, verified by sha256hash) must be exactly
    the artifacts pinned in defaults/runtime-manifest.json (what the backend
    verifies at startup) — one pin, two consumers, zero drift."""
    package = json.loads((REPO_ROOT / "package.json").read_text(encoding="utf-8"))
    manifest = json.loads(
        (REPO_ROOT / "defaults" / "runtime-manifest.json").read_text(encoding="utf-8")
    )
    loader_entries = {
        entry["name"]: (entry["url"], entry["sha256hash"]) for entry in package["remote_binary"]
    }
    pinned_artifacts = {
        artifact["id"]: (artifact["source"], artifact["sha256"])
        for artifact in manifest["artifacts"]
    }
    assert set(loader_entries) == {"voxtype-avx2", "voxtype-vulkan"}
    assert loader_entries == pinned_artifacts

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
    plugin_root.mkdir(parents=True)
    shutil.copy(REAL_MODELS_MANIFEST, plugin_root / "models.json")


def _stage_dev(plugin_root: Path) -> None:
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
    root = tmp_path / "SpeechToDeck"
    _stage_flattened(root)
    paths = PluginPaths(plugin_root=root, data_dir=tmp_path / "data")
    assert paths.models_manifest == root / "models.json"
    assert paths.models_manifest.is_file()
    assert paths.runtime_manifest == root / "runtime-manifest.json"


def test_packaged_layout_wins_when_both_exist(tmp_path: Path) -> None:
    root = tmp_path / "plugin"
    _stage_dev(root)
    (root / "models.json").write_text('{"marker": "packaged"}\n', encoding="utf-8")
    assert resolve_defaults_file(root, "models.json") == root / "models.json"


def test_resolver_rejects_paths_outside_plugin_root(tmp_path: Path) -> None:
    root = tmp_path / "checkout"
    _stage_dev(root)
    outside = tmp_path / "outside"
    outside.mkdir()
    (outside / "models.json").write_text("{}", encoding="utf-8")
    with pytest.raises(ManifestInvalidError):
        resolve_defaults_file(root, "../outside/models.json")
    with pytest.raises(ManifestInvalidError):
        resolve_defaults_file(root, "../../etc/models.json")


def test_composition_loads_manifest_from_installed_layout(tmp_path: Path) -> None:
    root = tmp_path / "SpeechToDeck"
    _stage_flattened(root)
    app = compose(plugin_root=root, data_dir=tmp_path / "data")
    assert {model.id for model in app.manifest.models} == {
        "tiny",
        "base",
        "small",
        "whisper-large-v3-turbo-q5_0",
        "whisper-large-v3-turbo",
        "distil-small-en",
        "distil-medium-en",
        "whisper-large-v3-turbo-german-q5_0",
        "whisper-large-v3-turbo-german-f16",
        "whisper-large-v3-french-q5_0",
        "kotoba-whisper-v2.0-q5_0",
        "kotoba-whisper-v2.0-f16",
    }


def test_remote_binary_entries_match_pinned_runtime_manifest() -> None:
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

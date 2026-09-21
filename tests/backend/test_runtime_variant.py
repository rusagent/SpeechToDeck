from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest
from backend.domain.errors import RuntimeStartError
from backend.infrastructure.process.runtime_variant import (
    RuntimeVariantResolver,
    load_pinned_runtime_artifacts,
)
from conftest import (
    build_fixture_binary,
    make_paths,
    make_resolver,
    pinned_manifest_json,
    write_test_daemon_config,
)


def pin_manifest(plugin_root: Path) -> None:
    defaults = plugin_root / "defaults"
    defaults.mkdir(parents=True, exist_ok=True)
    (defaults / "runtime-manifest.json").write_text(
        pinned_manifest_json("ab" * 32), encoding="utf-8"
    )


def test_explicit_backends_map_to_variants_without_probe(tmp_path: Path) -> None:
    async def scenario() -> None:
        paths = make_paths(tmp_path)
        pin_manifest(paths.plugin_root)
        probe_calls: list[int] = []
        resolver = make_resolver(paths, probe_calls=probe_calls)
        config_path = write_test_daemon_config(paths)

        cpu = await resolver.resolve("cpu", config_path=config_path)
        assert cpu.variant == "cpu" and cpu.backend == "cpu"
        assert cpu.binary == paths.bin_dir / "voxtype-avx2"
        assert cpu.artifact.artifact_id == "voxtype-avx2"

        vulkan = await resolver.resolve("vulkan", config_path=config_path)
        assert vulkan.variant == "vulkan"
        assert vulkan.binary == paths.bin_dir / "voxtype-vulkan"
        assert probe_calls == []

    asyncio.run(scenario())


def test_auto_policy_probes_vulkan_and_caches_the_decision(tmp_path: Path) -> None:
    async def scenario() -> None:
        paths = make_paths(tmp_path)
        pin_manifest(paths.plugin_root)
        probe_calls: list[int] = []
        resolver = make_resolver(paths, probe_decision="vulkan", probe_calls=probe_calls)
        config_path = write_test_daemon_config(paths)

        first = await resolver.resolve("auto", config_path=config_path)
        assert first.variant == "vulkan"
        second = await resolver.resolve("auto", config_path=config_path)
        assert second.variant == "vulkan"
        assert resolver.selected_backend == "vulkan"
        assert resolver.selected_binary_path == paths.bin_dir / "voxtype-vulkan"
        assert len(probe_calls) == 1

    asyncio.run(scenario())


def test_auto_policy_falls_back_to_avx2_when_probe_fails(tmp_path: Path) -> None:
    async def scenario() -> None:
        paths = make_paths(tmp_path)
        pin_manifest(paths.plugin_root)
        resolver = make_resolver(paths, probe_decision="cpu")
        resolved = await resolver.resolve("auto", config_path=write_test_daemon_config(paths))
        assert resolved.variant == "cpu"
        assert resolver.selected_backend == "cpu"

    asyncio.run(scenario())


def test_real_probe_runs_the_fixture_inventory(tmp_path: Path) -> None:
    from backend.infrastructure.process.runtime_variant import DEFAULT_PROBE_TIMEOUT_S

    async def scenario() -> None:
        paths = make_paths(tmp_path)
        build_fixture_binary(paths.plugin_root)
        pin_manifest(paths.plugin_root)
        resolver = RuntimeVariantResolver(paths, probe_timeout=DEFAULT_PROBE_TIMEOUT_S)
        resolved = await resolver.resolve("auto", config_path=write_test_daemon_config(paths))
        assert resolved.variant == "vulkan"

    asyncio.run(scenario())


def test_unknown_backend_fails_closed(tmp_path: Path) -> None:
    async def scenario() -> None:
        paths = make_paths(tmp_path)
        pin_manifest(paths.plugin_root)
        resolver = make_resolver(paths)
        with pytest.raises(RuntimeStartError):
            await resolver.resolve("quantum", config_path=write_test_daemon_config(paths))

    asyncio.run(scenario())


def test_manifest_missing_a_variant_fails_closed(tmp_path: Path) -> None:
    async def scenario() -> None:
        paths = make_paths(tmp_path)
        defaults = paths.plugin_root / "defaults"
        defaults.mkdir(parents=True, exist_ok=True)
        artifact = json.loads(pinned_manifest_json("ab" * 32))["artifacts"][0]
        (defaults / "runtime-manifest.json").write_text(
            json.dumps({"schemaVersion": 1, "artifacts": [artifact]}), encoding="utf-8"
        )
        resolver = make_resolver(paths)
        with pytest.raises(RuntimeStartError) as excinfo:
            await resolver.resolve("vulkan", config_path=write_test_daemon_config(paths))
        assert "variant" in excinfo.value.message

    asyncio.run(scenario())


def test_manifest_loader_rejects_duplicates_and_bad_digests(tmp_path: Path) -> None:
    paths = make_paths(tmp_path)
    manifest = paths.plugin_root / "defaults" / "runtime-manifest.json"
    manifest.parent.mkdir(parents=True, exist_ok=True)

    manifest.write_text(pinned_manifest_json("ab" * 32), encoding="utf-8")
    artifacts = load_pinned_runtime_artifacts(manifest)
    assert set(artifacts) == {"cpu", "vulkan"}

    duplicated = json.loads(pinned_manifest_json("ab" * 32))
    duplicated["artifacts"][1]["variant"] = "cpu"
    manifest.write_text(json.dumps(duplicated), encoding="utf-8")
    with pytest.raises(RuntimeStartError):
        load_pinned_runtime_artifacts(manifest)

    bad_digest = json.loads(pinned_manifest_json("ab" * 32))
    bad_digest["artifacts"][0]["sha256"] = "ZZ" * 32
    manifest.write_text(json.dumps(bad_digest), encoding="utf-8")
    with pytest.raises(RuntimeStartError):
        load_pinned_runtime_artifacts(manifest)

    empty = json.loads(pinned_manifest_json("ab" * 32))
    for artifact in empty["artifacts"]:
        artifact["sha256"] = ""
    manifest.write_text(json.dumps(empty), encoding="utf-8")
    with pytest.raises(RuntimeStartError) as excinfo:
        load_pinned_runtime_artifacts(manifest)
    assert "pinned" in excinfo.value.message

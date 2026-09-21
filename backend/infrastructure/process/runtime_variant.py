from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import logging
import re
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import Path

from backend.domain.errors import RuntimeStartError
from backend.infrastructure.process.process_environment import (
    PluginPaths,
    child_environment,
)

LOGGER = logging.getLogger("speech.runtime")

BACKEND_VARIANTS = {"cpu": "cpu", "vulkan": "vulkan"}
VALID_VARIANTS = frozenset({"cpu", "vulkan"})

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

DEFAULT_PROBE_TIMEOUT_S = 10.0


@dataclass(frozen=True)
class PinnedArtifact:
    artifact_id: str
    variant: str
    engine: str
    arch: str
    version: str
    source: str
    sha256: str
    license: str


def load_pinned_runtime_artifacts(manifest_path: Path) -> dict[str, PinnedArtifact]:

    try:
        raw = json.loads(manifest_path.read_bytes().decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise RuntimeStartError(
            "runtime manifest cannot be read",
            detail=f"{manifest_path.name}: {type(exc).__name__}",
        ) from exc

    problems: list[str] = []
    artifacts_raw: list[object] = []
    if not isinstance(raw, dict) or raw.get("schemaVersion") != 1:
        problems.append("schemaVersion must be 1")
    else:
        artifacts = raw.get("artifacts")
        if not isinstance(artifacts, list) or len(artifacts) == 0:
            problems.append("artifacts must be a non-empty array")
        else:
            artifacts_raw = artifacts

    by_variant: dict[str, PinnedArtifact] = {}
    seen_ids: set[str] = set()
    for index, artifact_raw in enumerate(artifacts_raw):
        label = f"artifacts[{index}]"
        if not isinstance(artifact_raw, dict):
            problems.append(f"{label} must be an object")
            continue

        fields = ("id", "engine", "arch", "version", "source", "sha256", "license")
        values: dict[str, str] = {}
        for field in fields:
            value = artifact_raw.get(field)
            if not isinstance(value, str) or len(value) == 0:
                problems.append(f"{label}.{field} is not pinned (empty)")
            else:
                values[field] = value

        variant = artifact_raw.get("variant")
        if not isinstance(variant, str) or variant not in VALID_VARIANTS:
            problems.append(f"{label}.variant must be one of {sorted(VALID_VARIANTS)}")
        elif variant in by_variant:
            problems.append(f"{label}.variant {variant!r} appears more than once")

        artifact_id = values.get("id", "")
        if artifact_id:
            if artifact_id in seen_ids:
                problems.append(f"{label}.id {artifact_id!r} appears more than once")
            seen_ids.add(artifact_id)

        sha = values.get("sha256", "")
        if sha and _SHA256_RE.fullmatch(sha) is None:
            problems.append(f"{label}.sha256 must be 64 lowercase hex characters")
        source = values.get("source", "")
        if source and not source.startswith("https://"):
            problems.append(
                f"{label}.source must be a version-pinned https URL; "
                "downloading a latest release is rejected"
            )

        if not problems and variant in VALID_VARIANTS and variant not in by_variant:
            by_variant[variant] = PinnedArtifact(
                artifact_id=artifact_id,
                variant=variant,
                engine=values["engine"],
                arch=values["arch"],
                version=values["version"],
                source=source,
                sha256=sha,
                license=values["license"],
            )

    if problems:
        raise RuntimeStartError(
            "native runtime artifact is not pinned",
            detail="; ".join(problems[:4]),
        )
    return by_variant


@dataclass(frozen=True)
class ResolvedRuntime:
    variant: str
    artifact: PinnedArtifact
    binary: Path

    @property
    def backend(self) -> str:
        return self.variant


class RuntimeVariantResolver:
    def __init__(
        self,
        paths: PluginPaths,
        *,
        probe_timeout: float = DEFAULT_PROBE_TIMEOUT_S,
        probe: Callable[[RuntimeVariantResolver, Path], Awaitable[bool]] | None = None,
    ) -> None:
        self._paths = paths
        self._probe_timeout = probe_timeout
        self._probe = probe if probe is not None else self._probe_vulkan_binary
        self._artifacts: dict[str, PinnedArtifact] | None = None
        self._auto_decision: str | None = None
        self._selected: ResolvedRuntime | None = None

    @property
    def selected_backend(self) -> str | None:
        return self._selected.backend if self._selected is not None else None

    @property
    def selected_binary_path(self) -> Path | None:
        return self._selected.binary if self._selected is not None else None

    async def resolve(self, compute_backend: str, *, config_path: Path) -> ResolvedRuntime:

        variant = BACKEND_VARIANTS.get(compute_backend)
        if variant is None:
            if compute_backend != "auto":
                raise RuntimeStartError(
                    "unknown compute backend", detail=f"backend={compute_backend!r}"
                )
            if self._auto_decision is None:
                self._auto_decision = await self._auto_variant(config_path)
            variant = self._auto_decision
        artifact = self._artifact(variant)
        self._selected = ResolvedRuntime(
            variant=variant, artifact=artifact, binary=self._paths.runtime_binary(variant)
        )
        LOGGER.info("runtime variant selected: %s (backend setting: %s)", variant, compute_backend)
        return self._selected

    async def _auto_variant(self, config_path: Path) -> str:
        if await self._probe(self, config_path):
            return "vulkan"
        LOGGER.info("vulkan probe failed; auto policy falls back to the avx2 binary")
        return "cpu"

    def _artifact(self, variant: str) -> PinnedArtifact:
        if self._artifacts is None:
            self._artifacts = load_pinned_runtime_artifacts(self._paths.runtime_manifest)
        artifact = self._artifacts.get(variant)
        if artifact is None:
            raise RuntimeStartError(
                "pinned runtime manifest has no artifact for the selected variant",
                detail=f"variant={variant!r}",
            )
        return artifact

    async def _probe_vulkan_binary(self, _resolver: object, config_path: Path) -> bool:

        binary = self._paths.runtime_binary("vulkan")
        argv = [str(binary), "--config", str(config_path), "info", "variants", "--json"]
        try:
            proc = await asyncio.create_subprocess_exec(
                *argv,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
                stdin=asyncio.subprocess.DEVNULL,
                env=child_environment(self._paths.data_dir),
            )
        except OSError as exc:
            LOGGER.info("vulkan probe could not be executed: %s", type(exc).__name__)
            return False
        try:
            await asyncio.wait_for(proc.wait(), self._probe_timeout)
        except TimeoutError:
            proc.kill()
            with contextlib.suppress(ProcessLookupError):
                await proc.wait()
            LOGGER.info("vulkan probe timed out after %gs", self._probe_timeout)
            return False
        return proc.returncode == 0


def hash_binary(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()

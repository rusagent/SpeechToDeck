"""Pinned runtime artifact resolution per compute variant.

Upstream Voxtype v1.0.1 ships one binary per compute backend: the compute
path is decided by WHICH binary runs, not by a CLI flag. This module owns:

- loading `defaults/runtime-manifest.json` with one pinned artifact per
  variant (validation mirrors `scripts/validate-manifests.mjs`; anything
  unpinned or malformed is a hard RUNTIME_START_FAILED — never a fallback,
  never a download);
- mapping the settings compute backend onto a variant: `cpu` runs the avx2
  build, `vulkan` runs the vulkan build, and `auto` applies the explicit
  probe policy — the vulkan binary is executed once with a cheap
  non-recording invocation (`voxtype info variants --json`, verified
  upstream: read-only inventory, no daemon, no model, no capture) and a
  failure falls back to avx2. The fallback is the documented auto policy,
  and the decision is logged (variant name only — never transcript or
  audio content) and cached for the session.
"""

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

# Settings-facing backend → manifest artifact variant.
BACKEND_VARIANTS = {"cpu": "cpu", "vulkan": "vulkan"}
VALID_VARIANTS = frozenset({"cpu", "vulkan"})

_SHA256_RE = re.compile(r"^[0-9a-f]{64}$")

# Auto-backend probe: bounded, non-recording, read-only inventory invocation.
DEFAULT_PROBE_TIMEOUT_S = 10.0


@dataclass(frozen=True)
class PinnedArtifact:
    """One pinned native runtime artifact."""

    artifact_id: str
    variant: str
    engine: str
    arch: str
    version: str
    source: str
    sha256: str
    license: str


def load_pinned_runtime_artifacts(manifest_path: Path) -> dict[str, PinnedArtifact]:
    """Load defaults/runtime-manifest.json keyed by compute variant.

    Fails closed unless every artifact is fully pinned: empty or malformed
    digests, missing provenance, unknown or duplicated variants are hard
    `RUNTIME_START_FAILED` errors — never a fallback or a download.
    """
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
            problems.append(f"{label}.source must be an https URL (§53: never download latest)")

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
    """The selected variant's pinned artifact and its binary location."""

    variant: str
    artifact: PinnedArtifact
    binary: Path

    @property
    def backend(self) -> str:
        """Settings-facing backend name (metrics vocabulary)."""
        return self.variant


class RuntimeVariantResolver:
    """Selects the pinned runtime binary for a settings compute backend.

    Explicit backends resolve deterministically (no probe). The `auto`
    decision is probed at most once per session and cached, so the
    client and the supervisor always address the same binary. An explicit
    backend change (settings-driven restart) takes effect immediately;
    `auto` keeps its session decision.
    """

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
        """The backend of the last resolve, or None before the first one."""
        return self._selected.backend if self._selected is not None else None

    @property
    def selected_binary_path(self) -> Path | None:
        """Binary of the last resolve, or None before the first one."""
        return self._selected.binary if self._selected is not None else None

    async def resolve(self, compute_backend: str, *, config_path: Path) -> ResolvedRuntime:
        """Resolve the pinned artifact for a validated settings backend.

        `config_path` is the generated daemon config handed to the probe
        invocation so the probe exercises the exact runtime configuration.
        """
        variant = BACKEND_VARIANTS.get(compute_backend)
        if variant is None:
            if compute_backend != "auto":  # defensive: settings validation owns this
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
        """Explicit auto policy: probe vulkan, fall back to avx2."""
        if await self._probe(self, config_path):
            return "vulkan"
        LOGGER.info("vulkan probe failed; auto policy falls back to the avx2 binary (§47)")
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
        """Run the vulkan binary's read-only inventory once, bounded.

        `voxtype info variants --json` (verified upstream, `src/cli/info.rs`)
        performs no recording, needs no daemon and loads no model; a non-zero
        exit, a crash or a timeout means this system cannot run the vulkan
        build and the auto fallback applies.
        """
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
    """SHA-256 of the exact artifact bytes (pinned-artifact verification)."""
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()

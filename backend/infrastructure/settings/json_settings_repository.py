"""Settings persistence: atomic writes and the schema migration chain.

The backend owns persistence; the frontend never writes settings files
directly. Writes are atomic (serialize → tmp file → flush → fsync →
rename). Unknown fields are rejected deliberately; removed legacy fields
(`maxRecordingSeconds`, `vadEnabled`, `outputMode`) are tolerated on load
and dropped on the next save. Schema versions migrate upward through an
explicit chain and fail closed on gaps.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
from collections.abc import Callable
from pathlib import Path

from backend.domain.contracts import Settings
from backend.domain.errors import SettingsInvalidError

CURRENT_SCHEMA_VERSION = 1

# Migration chain: key = source schemaVersion, value = migrator producing
# version + 1.
# v1 is the current format, so the chain is empty today. When v2 is designed,
# register `1: migrate_v1_to_v2` here; `load` walks the chain upward and fails
# closed on any missing step.
MIGRATIONS: dict[int, Callable[[dict[str, object]], dict[str, object]]] = {}

_SETTINGS_FILENAME = "settings.json"

_WIRE_FIELDS = (
    "schemaVersion",
    "enabled",
    "computeBackend",
    "modelId",
    "language",
)
_KNOWN_FIELDS = frozenset(_WIRE_FIELDS)

# `maxRecordingSeconds` and `vadEnabled` left the settings document.
# Devices updated from earlier releases carry both keys in
# their persisted settings.json (e.g. maxRecordingSeconds 110 / vadEnabled
# true), so load TOLERATES them — stripped before validation, never
# rejected, and never written back (the wire snapshot no longer carries
# them). The same applies to `outputMode`: the output is clipboard-only
# since the in-keyboard insertion feature was removed, and v0.2.2 device
# files carry "outputMode": "direct-insert".
_LEGACY_FIELDS = frozenset({"maxRecordingSeconds", "vadEnabled", "outputMode"})

_COMPUTE_BACKENDS = frozenset({"auto", "vulkan", "cpu"})

_MODEL_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]{0,63}$")
# "system" | "auto" | explicit language code (e.g. "en", "pt-BR").
_LANGUAGE_RE = re.compile(r"^(system|auto|[a-zA-Z]{2,8}(-[a-zA-Z0-9]{1,8})*)$")


def _require_dict(value: object) -> dict[str, object]:
    if not isinstance(value, dict):
        raise SettingsInvalidError("settings payload must be a JSON object")
    for key in value:
        if not isinstance(key, str):
            raise SettingsInvalidError("settings field names must be strings")
    return value


def _require_bool(raw: dict[str, object], key: str) -> bool:
    value = raw.get(key)
    if not isinstance(value, bool):
        raise SettingsInvalidError(f"{key} must be a boolean")
    return value


def _require_str(raw: dict[str, object], key: str) -> str:
    value = raw.get(key)
    if not isinstance(value, str):
        raise SettingsInvalidError(f"{key} must be a string")
    return value


def _validate_fields(raw: dict[str, object]) -> Settings:
    """Validate a v{CURRENT_SCHEMA_VERSION} payload into a Settings snapshot."""
    schema_version = raw.get("schemaVersion")
    if schema_version != CURRENT_SCHEMA_VERSION:
        raise SettingsInvalidError(
            f"schemaVersion must be {CURRENT_SCHEMA_VERSION}",
            detail=f"got {schema_version!r}",
        )

    compute_backend = _require_str(raw, "computeBackend")
    if compute_backend not in _COMPUTE_BACKENDS:
        raise SettingsInvalidError(
            "computeBackend must be auto, vulkan or cpu",
            detail=f"got {compute_backend!r}",
        )

    model_id = _require_str(raw, "modelId")
    if _MODEL_ID_RE.fullmatch(model_id) is None:
        raise SettingsInvalidError("modelId has an invalid format", detail=f"got {model_id!r}")

    language = _require_str(raw, "language")
    if _LANGUAGE_RE.fullmatch(language) is None:
        raise SettingsInvalidError("language has an invalid format", detail=f"got {language!r}")

    return Settings(
        schema_version=CURRENT_SCHEMA_VERSION,
        enabled=_require_bool(raw, "enabled"),
        compute_backend=compute_backend,  # type: ignore[arg-type]  # validated above
        model_id=model_id,
        language=language,
    )


def _apply_migrations(raw: dict[str, object]) -> dict[str, object]:
    """Walk the migration chain upward; fail closed on gaps."""
    version = raw.get("schemaVersion")
    if not isinstance(version, int) or isinstance(version, bool):
        raise SettingsInvalidError("schemaVersion must be an integer")

    if version > CURRENT_SCHEMA_VERSION:
        raise SettingsInvalidError(
            "settings were written by a newer plugin version",
            detail=f"file schemaVersion={version}, supported={CURRENT_SCHEMA_VERSION}",
        )

    data = raw
    while version < CURRENT_SCHEMA_VERSION:
        migrator = MIGRATIONS.get(version)
        if migrator is None:
            raise SettingsInvalidError(
                f"no migration registered for schemaVersion {version}",
                detail=f"supported={CURRENT_SCHEMA_VERSION}",
            )
        data = _require_dict(migrator(data))
        next_version = data.get("schemaVersion")
        if not isinstance(next_version, int) or next_version != version + 1:
            raise SettingsInvalidError(
                f"migration from schemaVersion {version} did not produce version {version + 1}",
            )
        version = next_version
    return data


def settings_from_payload(raw: object) -> Settings:
    """Validate a wire payload (post-migration shape) into Settings.

    Legacy keys (`maxRecordingSeconds`, `vadEnabled`, `outputMode`) are
    tolerated on load: they are stripped before the unknown-field check, so
    a settings file from an older release loads unchanged instead of being
    rejected — and since the
    resulting wire snapshot omits them, the next save drops them (never
    written back).
    """
    data = _require_dict(raw)
    data = {key: value for key, value in data.items() if key not in _LEGACY_FIELDS}
    unknown = sorted(set(data) - _KNOWN_FIELDS)
    if unknown:
        raise SettingsInvalidError(
            "settings contain unknown fields",
            detail="unknown=" + ",".join(unknown),
        )
    missing = sorted(name for name in _WIRE_FIELDS if name not in data)
    if missing:
        raise SettingsInvalidError(
            "settings are missing required fields",
            detail="missing=" + ",".join(missing),
        )
    return _validate_fields(data)


class JsonSettingsRepository:
    """Atomic JSON settings persistence under the plugin data dir."""

    def __init__(self, path: Path) -> None:
        self._path = path
        self._lock = asyncio.Lock()

    async def load(self) -> Settings:
        async with self._lock:
            return await asyncio.to_thread(self._load_sync)

    async def save(self, settings: Settings) -> None:
        async with self._lock:
            await asyncio.to_thread(self._save_sync, settings)

    def _load_sync(self) -> Settings:
        try:
            raw_bytes = self._path.read_bytes()
        except FileNotFoundError:
            # First run: the shipped defaults, never persisted implicitly.
            return Settings(
                schema_version=CURRENT_SCHEMA_VERSION,
                enabled=True,
                compute_backend="auto",
                model_id="base",
                language="system",
            )
        except OSError as exc:
            raise SettingsInvalidError(
                "settings file cannot be read", detail=type(exc).__name__
            ) from exc

        try:
            raw = json.loads(raw_bytes.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError) as exc:
            raise SettingsInvalidError(
                "settings file is not valid JSON", detail=type(exc).__name__
            ) from exc

        migrated = _apply_migrations(_require_dict(raw))
        return settings_from_payload(migrated)

    def _save_sync(self, settings: Settings) -> None:
        payload = settings.to_payload()
        payload["schemaVersion"] = CURRENT_SCHEMA_VERSION
        serialized = json.dumps(payload, indent=2, ensure_ascii=False) + "\n"

        self._path.parent.mkdir(parents=True, exist_ok=True)
        tmp_path = self._path.with_name(self._path.name + ".tmp")
        try:
            # Serialize → write temporary file → flush → rename.
            fd = os.open(tmp_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
            with os.fdopen(fd, "w", encoding="utf-8") as handle:
                handle.write(serialized)
                handle.flush()
                os.fsync(handle.fileno())
            os.chmod(tmp_path, 0o600)
            os.replace(tmp_path, self._path)
            # Make the rename itself durable.
            dir_fd = os.open(self._path.parent, os.O_RDONLY)
            try:
                os.fsync(dir_fd)
            finally:
                os.close(dir_fd)
        except OSError as exc:
            tmp_path.unlink(missing_ok=True)
            raise SettingsInvalidError(
                "settings file could not be written", detail=type(exc).__name__
            ) from exc

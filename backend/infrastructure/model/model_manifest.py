"""Model manifest loader with strict validation.

Validation rules mirror `scripts/validate-manifests.mjs` exactly: a manifest
that the CI gate would reject must also fail closed at runtime. Digests are
never guessed; an empty or malformed sha256 is a hard error.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from backend.domain.contracts import ModelInfo
from backend.domain.errors import ManifestInvalidError

SHA256_RE = re.compile(r"^[0-9a-f]{64}$")
MODEL_ID_RE = re.compile(r"^[a-z0-9][a-z0-9._-]*$")

# Curated-catalog rules, mirrored exactly by
# scripts/validate-manifests.mjs: lowercase BCP-47-ish language codes, a
# short English description, a hard 2 GiB size cap and per-model filenames
# unique across the catalog.
LANGUAGE_CODE_RE = re.compile(r"^[a-z]{2,8}(-[a-z0-9]{1,8})*$")
MAX_DESCRIPTION_CHARS = 200
MAX_MODEL_SIZE_BYTES = 2147483648

# Curated model set that must always ship.
REQUIRED_MODEL_IDS = ("tiny", "base", "small")
ALLOWED_ENGINES = frozenset({"whisper"})


class ModelManifest:
    """Immutable loaded manifest."""

    def __init__(self, models: tuple[ModelInfo, ...]) -> None:
        self._models = models
        self._by_id = {model.id: model for model in models}

    @property
    def models(self) -> tuple[ModelInfo, ...]:
        return self._models

    def by_id(self, model_id: str) -> ModelInfo | None:
        return self._by_id.get(model_id)


def _is_plain_object(value: object) -> bool:
    return isinstance(value, dict)


def _validate(models_raw: object) -> tuple[ModelInfo, ...]:
    errors: list[str] = []

    if not isinstance(models_raw, list) or len(models_raw) == 0:
        raise ManifestInvalidError('model manifest "models" must be a non-empty array')

    seen_ids: set[str] = set()
    seen_filenames: set[str] = set()
    models: list[ModelInfo] = []

    for index, entry in enumerate(models_raw):
        label = f"models[{index}]"
        if not _is_plain_object(entry):
            errors.append(f"{label}: must be an object")
            continue
        # Field names are strings by JSON construction.

        model_id = entry.get("id")
        if not isinstance(model_id, str) or MODEL_ID_RE.fullmatch(model_id) is None:
            errors.append(f"{label}.id: invalid model id {model_id!r}")
        elif model_id in seen_ids:
            errors.append(f"{label}.id: duplicate model id {model_id!r}")
        else:
            seen_ids.add(model_id)

        engine = entry.get("engine")
        if engine not in ALLOWED_ENGINES:
            errors.append(f"{label}.engine: must be one of whisper, got {engine!r}")

        multilingual = entry.get("multilingual")
        if not isinstance(multilingual, bool):
            errors.append(f"{label}.multilingual: must be a boolean")

        filename = entry.get("filename")
        if not isinstance(filename, str) or len(filename) == 0:
            errors.append(f"{label}.filename: must be a non-empty string")
        elif "/" in filename or "\\" in filename or ".." in filename:
            # Reject path traversal; model files live in the data dir only.
            errors.append(f"{label}.filename: must be a plain file name, got {filename!r}")
        elif filename in seen_filenames:
            # The filename is the local store name; two models sharing
            # it would overwrite each other's artifact.
            errors.append(f"{label}.filename: duplicate filename {filename!r}")
        else:
            seen_filenames.add(filename)

        download_url = entry.get("downloadUrl")
        if not isinstance(download_url, str) or len(download_url) == 0:
            errors.append(f"{label}.downloadUrl: must be a non-empty string")
        else:
            if re.search(r"\s", download_url):
                errors.append(f"{label}.downloadUrl: contains whitespace")
            elif not download_url.startswith("https://"):
                # Same https-only rule as the mjs gate (parsed protocol check).
                errors.append(f"{label}.downloadUrl: must use https, got {download_url!r}")

        sha256 = entry.get("sha256")
        if not isinstance(sha256, str):
            errors.append(f"{label}.sha256: must be a string")
        elif len(sha256) == 0:
            errors.append(
                f"{label}.sha256 is empty: model artifacts must ship with a real SHA-256 digest"
            )
        elif SHA256_RE.fullmatch(sha256) is None:
            errors.append(f"{label}.sha256: must be 64 lowercase hex characters")

        size_bytes: int | None = None
        if "sizeBytes" not in entry:
            # Required so the picker can show a human-readable size
            # before download without network probes.
            errors.append(f"{label}.sizeBytes: is required")
        else:
            raw_size = entry.get("sizeBytes")
            if not isinstance(raw_size, int) or isinstance(raw_size, bool) or raw_size <= 0:
                errors.append(f"{label}.sizeBytes: must be a positive integer")
            elif raw_size > MAX_MODEL_SIZE_BYTES:
                errors.append(f"{label}.sizeBytes: exceeds the {MAX_MODEL_SIZE_BYTES} byte cap")
            else:
                size_bytes = raw_size

        languages: tuple[str, ...] | None = None
        if "languages" in entry:
            raw_languages = entry["languages"]
            if (
                not isinstance(raw_languages, list)
                or len(raw_languages) == 0
                or not all(
                    isinstance(code, str) and LANGUAGE_CODE_RE.fullmatch(code) is not None
                    for code in raw_languages
                )
            ):
                errors.append(
                    f"{label}.languages: must be a non-empty array of lowercase "
                    "language codes when present"
                )
            else:
                languages = tuple(raw_languages)

        description: str | None = None
        if "description" in entry:
            raw_description = entry["description"]
            if not isinstance(raw_description, str) or len(raw_description) == 0:
                errors.append(f"{label}.description: must be a non-empty string when present")
            elif len(raw_description) > MAX_DESCRIPTION_CHARS:
                errors.append(f"{label}.description: exceeds {MAX_DESCRIPTION_CHARS} characters")
            else:
                description = raw_description

        unknown = set(entry) - {
            "id",
            "engine",
            "multilingual",
            "filename",
            "downloadUrl",
            "sha256",
            "sizeBytes",
            "languages",
            "description",
        }
        if unknown:
            errors.append(f"{label}: unknown fields {sorted(unknown)!r}")

        if errors:
            continue
        models.append(
            ModelInfo(
                id=str(model_id),
                engine=str(engine),
                multilingual=bool(multilingual),
                filename=str(filename),
                download_url=str(download_url),
                sha256=str(sha256),
                size_bytes=size_bytes,
                languages=languages,
                description=description,
            )
        )

    for required_id in REQUIRED_MODEL_IDS:
        if required_id not in seen_ids:
            errors.append(f"curated v1 model set is missing {required_id!r}")

    if errors:
        raise ManifestInvalidError(
            "model manifest validation failed",
            detail="; ".join(errors[:8]),
        )
    return tuple(models)


def load_model_manifest(path: Path) -> ModelManifest:
    """Load and strictly validate defaults/models.json; fail closed."""
    try:
        raw_bytes = path.read_bytes()
    except OSError as exc:
        raise ManifestInvalidError(
            "model manifest cannot be read", detail=f"{path.name}: {type(exc).__name__}"
        ) from exc

    try:
        raw = json.loads(raw_bytes.decode("utf-8"))
    except (UnicodeDecodeError, json.JSONDecodeError) as exc:
        raise ManifestInvalidError(
            "model manifest is not valid JSON", detail=type(exc).__name__
        ) from exc

    if not _is_plain_object(raw):
        raise ManifestInvalidError("model manifest top level must be an object")
    if raw.get("schemaVersion") != 1:
        raise ManifestInvalidError(
            "model manifest schemaVersion must be 1",
            detail=f"got {raw.get('schemaVersion')!r}",
        )
    return ModelManifest(_validate(raw.get("models")))

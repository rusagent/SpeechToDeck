from __future__ import annotations

import contextlib
import os
import shutil
from pathlib import Path

from backend.domain.errors import RuntimeStartError
from backend.infrastructure.process.runtime_variant import hash_binary

EXEC_COPY_DIRNAME = "exec"

EXECUTABLE_FILE_MODE = 0o755


def ensure_executable_copy(source: Path, target_dir: Path, *, source_digest: str) -> Path:

    target = target_dir / source.name
    tmp = target.with_name(target.name + ".tmp")
    try:
        if target.is_file() and hash_binary(target) == source_digest:
            tmp.unlink(missing_ok=True)
            return target

        target_dir.mkdir(parents=True, exist_ok=True)
        with source.open("rb") as src, tmp.open("wb") as dst:
            shutil.copyfileobj(src, dst)
            dst.flush()
            os.fsync(dst.fileno())
        os.chmod(tmp, EXECUTABLE_FILE_MODE)
        copied = hash_binary(tmp)
        if copied != source_digest:
            with contextlib.suppress(OSError):
                tmp.unlink(missing_ok=True)
            raise RuntimeStartError(
                "executable copy does not match the verified source digest",
                detail=f"expected {source_digest[:12]}… got {copied[:12]}…",
            )
        os.replace(tmp, target)
    except OSError as exc:
        with contextlib.suppress(OSError):
            tmp.unlink(missing_ok=True)
        raise RuntimeStartError(
            "executable copy could not be refreshed",
            detail=type(exc).__name__,
        ) from exc
    return target

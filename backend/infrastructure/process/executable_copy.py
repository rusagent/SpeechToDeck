"""Digest-verified private executable copy for daemon spawns (§53).

The supervisor never executes `bin/<name>` directly. Installing an update
over the RUNNING plugin rewrites `bin/` in place, and a direct write to the
file a daemon is executing fails with `[Errno 26] Text file busy`
(deck 2026-09-18, install-over-running-plugin). Linux allows
rename-over-a-running-executable, so executing a private copy under the
plugin data dir removes the hazard structurally: refreshing the cache below
never touches the inode a running daemon still executes.

Invariant — the copy is a digest-keyed CACHE, refreshed on every daemon spawn
verification: `ensure_executable_copy` returns `target_dir/<source.name>` with
bytes hashing to `source_digest` (the digest the caller already verified
against the pinned manifest). When the copy is missing or its digest drifted
(store update, interrupted write), it is rebuilt atomically: write
`<name>.tmp` in the same directory, fsync, chmod 0755, `os.replace`. A stale
`.tmp` left behind by an interrupted write is removed on every call. A running
daemon keeps executing the previous inode unaffected. Any I/O failure (or a
re-hash mismatch, i.e. the source changed mid-copy) raises the stable
`RuntimeStartError` — the caller must never fall back to spawning anything
unverified (§53).
"""

from __future__ import annotations

import contextlib
import os
import shutil
from pathlib import Path

from backend.domain.errors import RuntimeStartError
from backend.infrastructure.process.runtime_variant import hash_binary

#: Subdirectory of the plugin runtime dir holding the executable cache.
EXEC_COPY_DIRNAME = "exec"

#: The copy must be executable by the owner; the 0o700 data dir gates access.
EXECUTABLE_FILE_MODE = 0o755


def ensure_executable_copy(source: Path, target_dir: Path, *, source_digest: str) -> Path:
    """Return the digest-verified private copy of `source`, refreshing it when
    the cache is missing or drifted (see module docstring for the invariant).

    `source_digest` is the caller's §53-verified source hash; the copy is
    verified against the same digest (source AND copy against the pinned
    manifest digest).
    """
    target = target_dir / source.name
    tmp = target.with_name(target.name + ".tmp")
    try:
        if target.is_file() and hash_binary(target) == source_digest:
            # Cache hit: only an interrupted earlier write can have left a
            # `.tmp` behind; the cache itself is already verified.
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
            # The source changed between the caller's verification and this
            # copy (TOCTOU): never cache or execute an unverified blend.
            with contextlib.suppress(OSError):
                tmp.unlink(missing_ok=True)
            raise RuntimeStartError(
                "executable copy does not match the verified source digest (§53)",
                detail=f"expected {source_digest[:12]}… got {copied[:12]}…",
            )
        # Atomic publish: a daemon executing the previous target inode keeps
        # running it; the rename swaps the directory entry atomically.
        os.replace(tmp, target)
    except OSError as exc:
        with contextlib.suppress(OSError):
            tmp.unlink(missing_ok=True)
        raise RuntimeStartError(
            "executable copy could not be refreshed",
            detail=type(exc).__name__,
        ) from exc
    return target

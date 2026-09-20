"""System-clipboard writer for finished transcripts.

Writes the transcript into the X11 CLIPBOARD of the Game Mode XWayland
server so the Steam virtual keyboard's own Paste key (STEAM+X on-screen
keyboard) can insert it into any text field. Mechanism per the shipped
DeckyClipboard precedent (`py_modules/clipboard.py:32-147, 369-400`):

- the `xclip` binary is resolved at `<plugin_root>/bin/xclip` (the Decky
  loader places `remote_binary` entries there);
- `DISPLAY` is read from `/run/user/1000/gamescope-environment` with the
  `:0` fallback;
- `XAUTHORITY` points at `/home/deck/.Xauthority` when that file exists.

Our backend already runs as the host user (the loader setuid/setgids the
plugin process), so — unlike DeckyClipboard — no sudo/runuser wrapper is
needed. xclip is invoked as a strict argument array with a bounded timeout;
stdout/stderr are DEVNULL so the daemonized child that owns the CLIPBOARD
selection cannot hold our pipes and stall the wait, and no transcript text
is ever logged. The staging file lives inside the plugin data dir
with user-only permissions.

Pin decision: upstream xclip
(astrand/xclip) publishes no prebuilt release binaries, and the only bundled
binary in the audited ecosystem is an unofficial third-party build behind a
raw repository URL — not a trustworthy pinned source for an executed
artifact. The `remote_binary` pin is therefore SKIPPED. This writer is fully
implemented and activates automatically when `bin/xclip` exists (a future
pin or a manual install); until then it reports "skipped" and the frontend
execCommand copy is the primary clipboard path.
"""

from __future__ import annotations

import asyncio
import contextlib
import logging
import os
import tempfile
from pathlib import Path

from backend.domain.contracts import ClipboardStatus
from backend.infrastructure.process.process_environment import child_environment

LOGGER = logging.getLogger("speech.clipboard")

#: Bounded clipboard write; the application layer applies its own outer
#: bound on top of this so a hung child can never delay the transcript.
XCLIP_TIMEOUT_S = 5.0

GAMESCOPE_ENVIRONMENT_FILE = Path("/run/user/1000/gamescope-environment")
DECK_XAUTHORITY_FILE = Path("/home/deck/.Xauthority")
DEFAULT_DISPLAY = ":0"


class XclipClipboardWriter:
    """`ClipboardWriter` over the bundled/installed `bin/xclip`."""

    def __init__(
        self,
        binary_path: Path,
        *,
        staging_dir: Path,
        timeout_s: float = XCLIP_TIMEOUT_S,
        gamescope_environment_file: Path = GAMESCOPE_ENVIRONMENT_FILE,
        xauthority_file: Path = DECK_XAUTHORITY_FILE,
    ) -> None:
        self._binary_path = binary_path
        self._staging_dir = staging_dir
        self._timeout = timeout_s
        self._gamescope_environment_file = gamescope_environment_file
        self._xauthority_file = xauthority_file

    def is_available(self) -> bool:
        """Read-only probe for the diagnostics report (no side effects)."""
        return self._binary_path.is_file()

    async def write_text(self, text: str) -> ClipboardStatus:
        """Copy `text` into the X11 CLIPBOARD; never raises.

        Expected failure modes map to a `ClipboardStatus`: "skipped" when no
        xclip binary exists (no pin installed), "failed" for spawn/timeout/
        nonzero outcomes, "ok" only after a zero exit.
        """
        if not self.is_available():
            return "skipped"
        staging = self._stage_text(text)
        if staging is None:
            return "failed"
        try:
            return await self._run_xclip(staging)
        finally:
            # xclip reads the file fully before forking the selection owner;
            # by the time the parent exits the content is consumed.
            staging.unlink(missing_ok=True)

    # ── internals ────────────────────────────────────────────────────────────

    def _stage_text(self, text: str) -> Path | None:
        """Write the text into a private file under the runtime dir.

        The staging file follows the app-level transient-state policy
        (`<data_dir>/runtime`, 0o700 dir) and gets user-only file mode.
        """
        try:
            self._staging_dir.mkdir(parents=True, exist_ok=True)
            with tempfile.NamedTemporaryFile(
                mode="w",
                encoding="utf-8",
                prefix=".clipboard-",
                suffix=".txt",
                dir=self._staging_dir,
                delete=False,
            ) as handle:
                handle.write(text)
                staging = Path(handle.name)
            os.chmod(staging, 0o600)
            return staging
        except OSError:
            LOGGER.warning("clipboard staging file could not be written")
            return None

    def _child_environment(self) -> dict[str, str]:
        env = child_environment(self._staging_dir.parent)
        env["DISPLAY"] = self._resolve_display()
        if self._xauthority_file.is_file():
            env["XAUTHORITY"] = str(self._xauthority_file)
        return env

    def _resolve_display(self) -> str:
        """DISPLAY from the gamescope environment (DeckyClipboard:55-67)."""
        try:
            with self._gamescope_environment_file.open("r", encoding="utf-8") as handle:
                for line in handle:
                    if line.startswith("DISPLAY="):
                        return line.strip().split("=", 1)[1]
        except OSError:
            pass
        return DEFAULT_DISPLAY

    async def _run_xclip(self, staging: Path) -> ClipboardStatus:
        argv = [
            str(self._binary_path),
            "-selection",
            "clipboard",
            "-t",
            "text/plain",
            "-i",
            str(staging),
        ]
        try:
            proc = await asyncio.create_subprocess_exec(
                *argv,
                stdout=asyncio.subprocess.DEVNULL,
                stderr=asyncio.subprocess.DEVNULL,
                stdin=asyncio.subprocess.DEVNULL,
                env=self._child_environment(),
            )
        except OSError:
            LOGGER.warning("xclip could not be executed")
            return "failed"
        try:
            await asyncio.wait_for(proc.communicate(), self._timeout)
        except TimeoutError:
            proc.kill()
            with contextlib.suppress(ProcessLookupError):
                await proc.communicate()
            LOGGER.warning("xclip did not exit within the clipboard budget")
            return "failed"
        return "ok" if proc.returncode == 0 else "failed"

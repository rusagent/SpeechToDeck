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

XCLIP_TIMEOUT_S = 5.0

GAMESCOPE_ENVIRONMENT_FILE = Path("/run/user/1000/gamescope-environment")
DECK_XAUTHORITY_FILE = Path("/home/deck/.Xauthority")
DEFAULT_DISPLAY = ":0"


class XclipClipboardWriter:
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
        return self._binary_path.is_file()

    async def write_text(self, text: str) -> ClipboardStatus:

        if not self.is_available():
            return "skipped"
        staging = self._stage_text(text)
        if staging is None:
            return "failed"
        try:
            return await self._run_xclip(staging)
        finally:
            staging.unlink(missing_ok=True)

    def _stage_text(self, text: str) -> Path | None:

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

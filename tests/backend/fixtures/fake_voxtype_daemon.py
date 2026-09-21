from __future__ import annotations

import argparse
import contextlib
import json
import os
import signal
import subprocess
import sys
import threading
import time
import tomllib
from pathlib import Path

POLL_S = 0.02
CANCEL_POLL_S = 0.1


def runtime_dir() -> Path:
    base = os.environ.get("XDG_RUNTIME_DIR") or "/tmp"
    return Path(base) / "voxtype"


def write_state(path: str, state: str) -> None:
    target = Path(path)
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(state, encoding="utf-8")


def write_sidecar(output: str, status: str, *, message: str | None = None) -> None:
    payload: dict[str, object] = {"status": status, "chars": 0}
    if message is not None:
        payload["message"] = message
    sidecar = Path(output + ".done")
    tmp = sidecar.with_name(sidecar.name + f".{os.getpid()}.tmp")
    tmp.write_text(json.dumps(payload) + "\n", encoding="utf-8")
    os.replace(tmp, sidecar)


def write_output(output: str, text: str) -> None:
    if not text.endswith("\n"):
        text += "\n"
    tmp = Path(output + f".{os.getpid()}.tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, output)


def cleanup_output_override() -> None:
    with contextlib.suppress(OSError):
        (runtime_dir() / "output_mode_override").unlink()


def publish_result(state: str, output: str, text: str, *, mode: str) -> None:
    if mode == "empty":
        write_sidecar(output, "empty")
    elif mode == "error":
        write_sidecar(output, "error", message="fixture transcription failure")
    else:
        write_output(output, text)
        write_sidecar(output, "ok")
    write_state(state, "idle")
    cleanup_output_override()


class Daemon:
    def __init__(self, args: argparse.Namespace) -> None:
        with open(args.config, "rb") as handle:
            config = tomllib.load(handle)
        self.state_file = str(config["state_file"])
        self.output_file = str(config["output"]["file_path"])
        self.model = str(config.get("whisper", {}).get("model", "unknown"))
        self.args = args
        self.current_output = self.output_file

    def handle_start(self) -> None:
        override = runtime_dir() / "output_mode_override"
        try:
            value = override.read_text(encoding="utf-8").strip()
            if value.startswith("file:"):
                self.current_output = value[5:] or self.output_file
        except OSError:
            pass
        write_state(self.state_file, "recording")

    def handle_stop(self) -> None:
        write_state(self.state_file, "transcribing")
        if self.args.hang_transcription:
            return
        worker = threading.Timer(
            self.args.transcribe_delay,
            publish_result,
            args=(self.state_file, self.current_output, self.args.transcript_text),
            kwargs={
                "mode": (
                    "empty"
                    if self.args.empty_transcription
                    else "error"
                    if self.args.error_transcription
                    else "ok"
                )
            },
        )
        worker.daemon = True
        worker.start()

    def run(self) -> None:
        def handle_term(signum: int, frame: object) -> None:
            if self.args.ignore_term:
                return
            with contextlib.suppress(OSError):
                os.unlink(self.state_file)
            with contextlib.suppress(OSError):
                (runtime_dir() / "pid").unlink()
            os._exit(0)

        signal.signal(signal.SIGTERM, handle_term)
        signal.signal(signal.SIGUSR1, lambda signum, frame: self.handle_start())
        signal.signal(signal.SIGUSR2, lambda signum, frame: self.handle_stop())

        write_state(self.state_file, "idle")
        print(f"voxtype-fake daemon starting model={self.model}", flush=True)
        pid_path = runtime_dir() / "pid"
        pid_path.parent.mkdir(parents=True, exist_ok=True)
        pid_path.write_text(str(os.getpid()), encoding="utf-8")

        if self.args.crash_after is not None:
            crash = threading.Timer(self.args.crash_after, lambda: os._exit(3))
            crash.daemon = True
            crash.start()

        if self.args.grandchild_sentinel:
            subprocess.Popen(
                [
                    sys.executable,
                    os.path.abspath(__file__),
                    "grandchild",
                    "--sentinel",
                    self.args.grandchild_sentinel,
                ]
            )

        while True:
            cancel_file = runtime_dir() / "cancel"
            if cancel_file.exists():
                with contextlib.suppress(OSError):
                    cancel_file.unlink()
                self.cancel_if_active()
            time.sleep(CANCEL_POLL_S)

    def cancel_if_active(self) -> None:
        try:
            current = Path(self.state_file).read_text(encoding="utf-8").strip()
        except OSError:
            return
        if current in ("recording", "transcribing"):
            write_state(self.state_file, "idle")
            cleanup_output_override()


def check_daemon_running() -> int:
    pid_path = runtime_dir() / "pid"
    try:
        pid = int(pid_path.read_text(encoding="utf-8").strip())
        os.kill(pid, 0)
    except (OSError, ValueError):
        print("voxtype-fake: no running daemon", file=sys.stderr)
        sys.exit(1)
    return pid


def cmd_record(args: argparse.Namespace) -> None:
    check_daemon_running()
    if args.ack_sleep > 0:
        time.sleep(args.ack_sleep)
    run_dir = runtime_dir()

    if args.action == "cancel":
        (run_dir / "cancel").write_text("cancel", encoding="utf-8")
        return

    if args.action == "start":
        target = args.file or ""
        (run_dir / "output_mode_override").write_text(f"file:{target}", encoding="utf-8")
        os.kill(check_daemon_running(), signal.SIGUSR1)
        return

    assert args.wait, "the adapters only use stop --wait"
    deadline = time.monotonic() + args.timeout
    override = (run_dir / "output_mode_override").read_text(encoding="utf-8").strip()
    target = override[5:] if override.startswith("file:") else ""
    sidecar = Path(target + ".done") if target else None
    os.kill(check_daemon_running(), signal.SIGUSR2)
    if sidecar is None:
        print(json.dumps({"status": "error", "chars": 0, "message": "no wait target"}))
        sys.exit(1)
    while time.monotonic() < deadline:
        try:
            body = sidecar.read_text(encoding="utf-8").strip()
        except OSError:
            time.sleep(POLL_S)
            continue
        with contextlib.suppress(OSError):
            sidecar.unlink()
        outcome = json.loads(body)
        status = str(outcome.get("status", "error"))
        text = ""
        if status == "ok":
            text = Path(target).read_text(encoding="utf-8")
        print(
            json.dumps(
                {
                    "status": status,
                    "text": text,
                    "chars": len(text),
                    "message": outcome.get("message"),
                }
            )
        )
        sys.exit({"ok": 0, "empty": 3}.get(status, 1))
    print(json.dumps({"status": "timeout", "text": "", "chars": 0, "message": None}))
    sys.exit(4)


def cmd_info(args: argparse.Namespace) -> None:
    if args.action == "variants":
        print("{}")
        return
    print("voxtype-fake: unknown info action", file=sys.stderr)
    sys.exit(1)


def cmd_grandchild(args: argparse.Namespace) -> None:
    sentinel = Path(args.sentinel)
    sentinel.touch()

    def handle(signum: int, frame: object) -> None:
        sentinel.write_text("terminated", encoding="utf-8")
        os._exit(0)

    signal.signal(signal.SIGTERM, handle)
    while True:
        time.sleep(0.2)


def main() -> None:
    parser = argparse.ArgumentParser(prog="voxtype-fake")
    parser.add_argument("--config", default=None)
    sub = parser.add_subparsers(dest="command", required=True)

    daemon = sub.add_parser("daemon")
    daemon.add_argument("--crash-after", type=float, default=None)
    daemon.add_argument("--transcribe-delay", type=float, default=0.15)
    daemon.add_argument("--transcript-text", default="hello world")
    daemon.add_argument("--empty-transcription", action="store_true")
    daemon.add_argument("--error-transcription", action="store_true")
    daemon.add_argument("--hang-transcription", action="store_true")
    daemon.add_argument("--ignore-term", action="store_true")
    daemon.add_argument("--grandchild-sentinel", default=None)

    record = sub.add_parser("record")
    record.add_argument("action", choices=["start", "stop", "cancel"])
    record.add_argument("--file", default=None)
    record.add_argument("--wait", action="store_true")
    record.add_argument("--json", action="store_true")
    record.add_argument("--timeout", type=int, default=120)
    record.add_argument("--ack-sleep", type=float, default=0.0)

    info = sub.add_parser("info")
    info.add_argument("action", choices=["variants"])
    info.add_argument("--json", action="store_true")

    grandchild = sub.add_parser("grandchild")
    grandchild.add_argument("--sentinel", required=True)

    args = parser.parse_args()
    if args.command == "daemon":
        if not args.config:
            print("voxtype-fake: daemon requires --config", file=sys.stderr)
            sys.exit(1)
        Daemon(args).run()
    elif args.command == "record":
        cmd_record(args)
    elif args.command == "info":
        cmd_info(args)
    else:
        cmd_grandchild(args)


if __name__ == "__main__":
    main()

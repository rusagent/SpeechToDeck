"""Fake Voxtype runtime implementing the CLI contract in bin/README.md.

Used only by tests/backend to exercise real process supervision, control-CLI
acknowledgements, atomic status/output files, signal handling and process
groups — without STT hardware, network or microphone (spec §90-§91).

The test suite copies this file to a temp `bin/voxtype` launcher with a
shebang pointing at the running interpreter.
"""

from __future__ import annotations

import argparse
import contextlib
import json
import os
import signal
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path


def write_status(path: str, state: str, *, backend: str = "cpu", detail: str | None = None) -> None:
    payload: dict[str, object] = {
        "protocolVersion": 1,
        "state": state,
        "backend": backend,
    }
    if detail is not None:
        payload["detail"] = detail
    tmp = Path(path + ".tmp")
    tmp.write_text(json.dumps(payload), encoding="utf-8")
    os.replace(tmp, path)


def produce_output(status: str, output: str, text: str, backend: str) -> None:
    tmp = Path(output + ".tmp")
    tmp.write_text(text, encoding="utf-8")
    os.replace(tmp, output)
    write_status(status, "idle", backend=backend)


def cmd_daemon(args: argparse.Namespace) -> None:
    status = args.status_file
    output = args.output_file
    control = Path(args.control_socket)
    backend = "vulkan" if args.compute_backend == "vulkan" else "cpu"
    stop = threading.Event()

    write_status(status, "idle", backend=backend)
    print(f"voxtype-fake daemon starting model={args.model}", flush=True)

    if args.crash_after is not None:
        crash = threading.Timer(args.crash_after, lambda: os._exit(3))
        crash.daemon = True
        crash.start()

    def handle_term(signum: int, frame: object) -> None:
        if args.ignore_term:
            return
        write_status(status, "stopped", backend=backend)
        with contextlib.suppress(FileNotFoundError):
            control.unlink()
        os._exit(0)

    signal.signal(signal.SIGTERM, handle_term)

    if args.grandchild_sentinel:
        # Same process group on purpose: the supervisor's group kill (§38)
        # must reach it so no orphan survives.
        subprocess.Popen(
            [
                sys.executable,
                os.path.abspath(__file__),
                "grandchild",
                "--sentinel",
                args.grandchild_sentinel,
            ]
        )

    with contextlib.suppress(FileNotFoundError):
        control.unlink()
    server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    server.bind(str(control))
    server.listen(4)
    server.settimeout(0.2)

    try:
        while True:
            try:
                conn, _ = server.accept()
            except TimeoutError:
                continue
            with conn:
                conn.settimeout(5.0)
                data = b""
                while not data.endswith(b"\n"):
                    chunk = conn.recv(64)
                    if not chunk:
                        break
                    data += chunk
                command = data.decode("utf-8", errors="replace").strip()
                if args.ack_sleep > 0:
                    time.sleep(args.ack_sleep)
                if command == "start":
                    write_status(status, "recording", backend=backend)
                    conn.sendall(b"OK\n")
                elif command == "stop":
                    if args.stop_ack_sleep > 0:
                        time.sleep(args.stop_ack_sleep)
                    write_status(status, "transcribing", backend=backend)
                    conn.sendall(b"OK\n")
                    if not args.hang_transcription:
                        produce = threading.Timer(
                            args.transcribe_delay,
                            produce_output,
                            args=(status, output, args.transcript_text, backend),
                        )
                        produce.daemon = True
                        produce.start()
                elif command == "cancel":
                    write_status(status, "idle", backend=backend)
                    conn.sendall(b"OK\n")
                else:
                    conn.sendall(b"ERR unknown command\n")
    finally:
        stop.set()
        server.close()


def cmd_record(args: argparse.Namespace) -> None:
    control = str(args.control_socket)
    deadline = time.time() + 5.0
    sock = None
    while time.time() < deadline:
        try:
            candidate = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
            candidate.connect(control)
            sock = candidate
            break
        except OSError:
            time.sleep(0.02)
    if sock is None:
        print("voxtype-fake: control socket unavailable", file=sys.stderr)
        sys.exit(1)
    with sock:
        sock.settimeout(5.0)
        sock.sendall(f"{args.action}\n".encode())
        reply = sock.recv(16)
    if reply.startswith(b"OK"):
        sys.exit(0)
    sys.exit(1)


def cmd_grandchild(args: argparse.Namespace) -> None:
    sentinel = Path(args.sentinel)
    sentinel.touch()  # ready marker: signal handler about to be installed

    def handle(signum: int, frame: object) -> None:
        sentinel.write_text("terminated", encoding="utf-8")
        os._exit(0)

    signal.signal(signal.SIGTERM, handle)
    while True:
        time.sleep(0.2)


def main() -> None:
    parser = argparse.ArgumentParser(prog="voxtype-fake")
    sub = parser.add_subparsers(dest="command", required=True)

    daemon = sub.add_parser("daemon")
    daemon.add_argument("--status-file", required=True)
    daemon.add_argument("--output-file", required=True)
    daemon.add_argument("--control-socket", required=True)
    daemon.add_argument("--model", default="base")
    daemon.add_argument("--compute-backend", default="auto")
    daemon.add_argument("--language", default="system")
    daemon.add_argument("--vad-enabled", default="true")
    daemon.add_argument("--max-recording-seconds", type=int, default=60)
    daemon.add_argument("--crash-after", type=float, default=None)
    daemon.add_argument("--ack-sleep", type=float, default=0.0)
    daemon.add_argument("--stop-ack-sleep", type=float, default=0.0)
    daemon.add_argument("--transcribe-delay", type=float, default=0.15)
    daemon.add_argument("--transcript-text", default="hello world")
    daemon.add_argument("--hang-transcription", action="store_true")
    daemon.add_argument("--ignore-term", action="store_true")
    daemon.add_argument("--grandchild-sentinel", default=None)

    record = sub.add_parser("record")
    record.add_argument("action", choices=["start", "stop", "cancel"])
    record.add_argument("--control-socket", required=True)

    grandchild = sub.add_parser("grandchild")
    grandchild.add_argument("--sentinel", required=True)

    args = parser.parse_args()
    if args.command == "daemon":
        cmd_daemon(args)
    elif args.command == "record":
        cmd_record(args)
    else:
        cmd_grandchild(args)


if __name__ == "__main__":
    main()

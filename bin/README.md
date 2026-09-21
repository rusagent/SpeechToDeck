# bin/ — Native Runtime Artifacts

This directory intentionally contains **no binary** in the repository. The
Voxtype v1.0.1 runtime (github.com/peteonrails/voxtype, MIT) is downloaded by
the **Decky loader at install time** from the `remote_binary` entries in
`package.json` and written to `<plugin_dir>/bin/<name>`; the loader verifies
each `sha256hash` before use. Nothing is committed to git.

## Pinning and acquisition

The exact artifacts are pinned in `defaults/runtime-manifest.json` (one
artifact per compute `variant`) and in the `package.json` `remote_binary`
array (what the loader downloads). The two files must agree entry for entry
(covered by `tests/backend/test_defaults_layout.py`):

| Field       | Meaning                                                          |
| ----------- | ---------------------------------------------------------------- |
| `id`/`name` | Artifact id; the loader writes it verbatim to `bin/<name>`.      |
| `variant`   | Compute backend the binary implements: `cpu` (avx2) or `vulkan`. |
| `version`   | Exact artifact version (`1.0.1`); never `latest`.                |
| `source`    | Exact release download URL (https).                              |
| `sha256`    | SHA-256 of the exact artifact bytes (release `SHA256SUMS.txt`).  |
| `license`   | License of the artifact (also listed in THIRD_PARTY_NOTICES.md). |
| `arch`      | Build architecture (`x86_64` for Steam Deck).                    |

Rules:

- The supervisor checksums the selected binary against
  `defaults/runtime-manifest.json` before every start; a mismatch or a
  missing binary is a hard `RUNTIME_START_FAILED` — never a fallback or a
  download.
- The manifest gate (`node scripts/validate-manifests.mjs`) fails on any
  unpinned artifact when run with `--strict` (release packaging). Both
  artifacts are pinned, so the gate passes in both modes. Never weaken the
  gate or invent a digest; pin the artifact instead.
- Application code must not depend on Voxtype-specific concepts; the runtime
  is replaceable infrastructure behind ports.

## Voxtype CLI contract (v1.0.1, invoked by the backend)

The backend (`backend/infrastructure/process/daemon_supervisor.py`,
`voxtype_client.py`, `runtime_variant.py`) invokes the pinned binary with
exact argument arrays — never a shell. A runtime build that does
not implement this surface needs an adapter change, not application changes.
Everything below is verified against the upstream v1.0.1 sources
(`src/cli/root.rs`, `src/cli/record.rs`, `src/app/record.rs`, `src/daemon.rs`,
`src/config/*.rs`, `config/default.toml`).

### Variant selection

There is no `--compute-backend` flag: the compute path is decided by WHICH
binary runs. The settings `computeBackend` maps onto the pinned variants:

- `cpu` → `bin/voxtype-avx2` (deterministic);
- `vulkan` → `bin/voxtype-vulkan` (deterministic);
- `auto` → explicit probe policy: the vulkan binary is executed once
  with `--config <generated> info variants --json` (read-only inventory; no
  daemon, no model, no capture) inside a bounded subprocess. Success selects
  vulkan; failure falls back to avx2. The decision is logged (variant only)
  and cached for the session.

### Daemon mode (persistent, started once by the supervisor)

```text
bin/<variant> --config <generated.toml> daemon
```

The `daemon` subcommand takes NO options upstream; all tuning travels through
the generated TOML config (`backend/infrastructure/process/daemon_supervisor.py`,
one file per start under the plugin data dir). Key mapping (verified against
`config/default.toml` and `src/config/*.rs`):

```toml
engine = "whisper"
state_file = "<runtime>/voxtype/state"

[hotkey]
enabled = false

[audio]
max_duration_secs = 86400

[whisper]
model = "<abs path to our ggml file>"
language = "<code | auto>"
on_demand_loading = false
eager_processing = false

[vad]
enabled = true

[output]
mode = "file"
file_path = "<runtime>/voxtype/transcript.out"
file_mode = "overwrite"

[output.notification]
on_recording_start = false
on_recording_stop = false
on_transcription = false

[osd]
enabled = false

```

Required daemon behaviour (upstream `src/daemon.rs`):

- writes the state file as a **bare word** (`idle | recording | streaming |
transcribing`) via a plain write on every state change; the backend
  consumes it event-driven via inotify — no polling. The daemon DELETES the
  state file on shutdown; a missing file means "stopped" (synthesized by
  consumers). No JSON, no error word — errors come from record outcomes.
- writes the final transcript to `output.file_path` **atomically** (sibling
  temp + rename) with exactly one trailing `\n`, then writes the completion
  sidecar `<output>.done` (`{"status": "ok"|"empty"|"error", "chars": N}` +
  `\n`) atomically and LAST. Empty speech writes ONLY the sidecar — no
  transcript file.
- handles SIGTERM gracefully (exit 0 after deleting the state file); the
  supervisor escalates to SIGKILL for the whole process group only after a
  bounded wait.

### Record commands (short-lived CLI, one per user action)

```text
bin/<variant> --config <generated.toml> record start --file=<transcript path>
bin/<variant> --config <generated.toml> record stop --wait --json --timeout <bounded>
bin/<variant> --config <generated.toml> record cancel
```

- `record start --file=<path>` exits 0 once the daemon was signalled
  (SIGUSR1 under the hood); the backend bounds it with a 2 s ack.
  The CLI refuses (non-zero exit) when no daemon is running.
- `record stop --wait --json --timeout <bounded>` signals the daemon
  (SIGUSR2), blocks on the `.done` sidecar and prints one JSON outcome
  object on stdout. Exit codes: **0** transcribed, **3** empty, **4**
  timed out, **1** failed. The backend maps these exit codes onto its own
  outcomes; stdout is never logged (the JSON embeds transcript text).
  `<bounded>` scales with the recorded duration:
  `max(120 s, 2 × recorded)` — short recordings keep the historical 120 s
  floor, long ones get transcription headroom instead of a bogus timeout.
  The application-level watchdog scales too (`max(90 s, 2 × recorded +
30 s)`); from 45 s recorded upward it stays above the CLI budget so
  upstream exit 4 remains the primary timeout path, while below 45 s its
  90 s floor fires before the CLI's 120 s floor — the historical v0.2.x
  relationship.
- `record cancel` writes a cancel trigger file in the runtime dir; the
  daemon observes it and returns to idle without producing output.
- Control signals are SIGUSR1 (start) / SIGUSR2 (stop); the CLI locates the
  daemon through the pid file in `$XDG_RUNTIME_DIR/voxtype`. The backend
  points `XDG_RUNTIME_DIR` at the plugin runtime directory so every native
  sentinel (state, pid, cancel, overrides) stays inside the plugin data dir.
- After a transcribed stop (exit 0), the backend reads the transcript file
  exactly once, strips exactly one trailing newline, and removes the file
  and any sidecar. Empty (exit 3) follows the empty-speech path — no
  transcript, no insertion, no error.

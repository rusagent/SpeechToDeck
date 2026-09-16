# bin/ — Native Runtime Artifacts

This directory intentionally contains **no binary** in the repository. The
Voxtype runtime daemon (spec §35) is packaged into the plugin archive at
release time, never committed to git.

## Acquisition requirements

Before packaging, the runtime artifact recorded in
`defaults/runtime-manifest.json` must be pinned with real values for all of:

| Field     | Meaning                                                           |
| --------- | ----------------------------------------------------------------- |
| `version` | Exact artifact version. **Never** use or download `latest` (§53). |
| `source`  | Exact build source (upstream project/release URL, https).         |
| `sha256`  | SHA-256 of the exact artifact bytes.                              |
| `license` | License of the artifact (also listed in THIRD_PARTY_NOTICES.md).  |
| `arch`    | Build architecture (`x86_64` for Steam Deck).                     |

Rules (spec §53, §109):

- The binary is checksummed against `defaults/runtime-manifest.json` before it
  is packaged; a mismatch aborts packaging.
- Until `sha256` is filled with a real digest, the manifest gate
  (`node scripts/validate-manifests.mjs`) prints a loud `RUNTIME_UNPINNED`
  diagnostic but stays green (spec §129): product code already fails closed
  against an unpinned manifest at backend startup (`RUNTIME_START_FAILED`).
  Release packaging must run the gate with `--strict`, which fails hard on an
  unpinned runtime. Never weaken the gate or invent a digest to satisfy it;
  pin the artifact instead.
- Application code must not depend on Voxtype-specific concepts; the runtime is
  replaceable infrastructure behind ports (spec §35, ADR-003).

## Voxtype CLI contract (invoked by the backend supervisor)

The backend (`backend/infrastructure/process/daemon_supervisor.py` and
`voxtype_client.py`) invokes the packaged binary as `bin/voxtype` with the
following exact argument arrays — never a shell (spec §40). A runtime build
that does not implement this surface needs an adapter change, not application
changes (ADR-003).

### Daemon mode (persistent, started once by the supervisor)

```text
voxtype daemon
    --status-file <path>          # JSON status, rewritten atomically on change
    --output-file <path>          # final transcript for the current recording
    --control-socket <path>       # Unix stream socket accepting record commands
    --model <id>                  # curated id: tiny | base | small (spec §48)
    --compute-backend auto|vulkan|cpu
    --language <system|auto|code>
    --vad-enabled true|false      # lightweight VAD only (spec §45)
    --max-recording-seconds <n>
```

Required daemon behaviour (spec §35-§39):

- configured for `engine=whisper`, `output=file`, `hotkey=disabled`,
  `streaming=disabled`, eager processing disabled, model kept loaded;
- writes the status file **atomically** (write temp + rename) on every state
  change; the backend consumes it event-driven via inotify — no polling;
- status payload: `{"protocolVersion": 1, "state": "idle|recording|transcribing|error|stopped",
"backend": "cpu|vulkan", "detail": "..."}` (`detail` optional, diagnostics
  only — never transcript text);
- writes the final transcript to the output file **atomically**, exactly once
  per completed transcription (empty file = empty transcript, §77); never
  writes it outside a recording;
- exits cleanly with status 0 on SIGTERM (the supervisor escalates to SIGKILL
  for the whole process group only after a bounded wait, §38/§71).

### Record commands (short-lived CLI, one per user action)

```text
voxtype record start  --control-socket <path>   # exit 0 once recording is live (ack ≤ 2 s, §71)
voxtype record stop   --control-socket <path>   # exit 0 once stop is accepted; transcription continues
voxtype record cancel --control-socket <path>   # exit 0; discards the recording (§72)
```

- Commands are delivered over the control socket; a non-zero exit or a missing
  acknowledgement within 2 s maps to stable error codes (§68).
- After `record stop` is acknowledged, the backend waits (event-driven) for
  either the transcript output file or an `error` status, then reads the
  output file exactly once and removes it (§42, §110).
- `record cancel` must ensure no output file is produced for the cancelled
  recording (§72).

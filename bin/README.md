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
  (`node scripts/validate-manifests.mjs`) intentionally fails. Do not weaken
  the gate to make it pass; pin the artifact instead.
- Application code must not depend on Voxtype-specific concepts; the runtime is
  replaceable infrastructure behind ports (spec §35, ADR-003).

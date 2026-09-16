# ADR-003: Voxtype as replaceable runtime adapter

Status: Accepted (spec §35, §53)

## Context

The product needs a local whisper-based STT engine but must not be coupled to
one engine's process model, CLI surface, or configuration format. Runtime
binaries are third-party artifacts with their own release cadence.

## Decision

v1 uses a pinned Voxtype runtime configured for `engine = whisper`,
`output = file`, `hotkey = disabled`, `streaming = disabled`, eager processing
disabled, and the model kept loaded. The runtime is treated as replaceable
infrastructure: application code depends only on ports
(`SpeechPort`/backend contracts), never on Voxtype-specific concepts. The
artifact is pinned by exact version, build source, SHA-256, license, and
architecture in `defaults/runtime-manifest.json` (see bin/README.md); `latest`
is never downloaded.

## Consequences

- Swapping or upgrading the STT engine touches one adapter package plus the
  runtime manifest, not the domain or application layers.
- Every packaged runtime artifact must carry full integrity metadata; the
  manifest validation gate fails closed until the artifact is pinned.
- Runtime-specific capabilities (e.g. streaming) stay unused in v1 and impose
  no model on the ports.

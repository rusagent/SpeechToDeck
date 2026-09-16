# ADR-009: No remote telemetry

Status: Accepted (spec §73-§74)

## Context

The plugin processes microphone audio on the device and inserts transcripts
into user text fields. Any telemetry channel would create a route for sensitive
data to leave the device and would erode the local-processing guarantee that
defines the product (§2.1).

## Decision

v1 has no remote telemetry. Nothing is transmitted off the device. Local
diagnostics may expose non-identifying counters (recordings started/completed,
runtime crashes, average transcription duration, last error code); counters
remain on the device. Persistence rules: microphone audio, normal transcripts,
and target field contents are never persisted. Diagnostic logs may contain
timestamps, state changes, durations, exit codes, model name, backend, and
non-sensitive error codes — never transcript text or audio bytes.

## Consequences

- No crash reporting or usage analytics; issues are reproduced locally from
  diagnostics counters and logs.
- Logging transcript content is a merge-blocking quality gate (§127).
- The transcript payload size is limited (§109) and diagnostic display is
  sanitized.

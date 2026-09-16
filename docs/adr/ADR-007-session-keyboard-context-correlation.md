# ADR-007: Session and keyboard-context correlation

Status: Accepted (spec §42, §128 Invariants 1-3)

## Context

A transcript is only meaningful in the keyboard context it was dictated into.
Users may close the keyboard mid-session or switch fields; stale output from a
previous session must never reach a new context.

## Decision

Every transcript is correlated with the active session and its originating
keyboard context. Before recording: previous transcript output is
removed/truncated, an active session is created, the monotonic start time is
captured, and the native recording starts. After stop: the native stop is
issued, the final transcription state is awaited, the newly produced output is
read exactly once, normalized, tagged with the active `sessionId`, and emitted
as `transcript_ready`. A transcript from a previous session is never reused.
Insertion validates the keyboard context twice inside the bulk insertion
transaction (ADR-005).

## Consequences

- Invariants hold: at most one active dictation session; a session belongs to
  exactly one keyboard context; a transcript may only be inserted into its
  originating context.
- Bypassing session correlation is a merge-blocking quality gate (§127).
- Stale-result races (late results from an older session) are dropped by
  correlation, not by timing heuristics.

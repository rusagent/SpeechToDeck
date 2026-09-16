# ADR-004: Final-only transcription

Status: Accepted (spec §21)

## Context

Live streaming would push partial words into the text field as they are
recognized. That conflicts with the one-shot insertion model, introduces chunk
reconciliation, and causes repeated target mutation with focus and consistency
problems inside Steam's virtual keyboard.

## Decision

v1 performs no live streaming. The pipeline per utterance is: record the full
utterance → stop → transcribe the final utterance → insert one complete
string. Partial hypotheses are never surfaced into the target field.

## Consequences

- The insertion path stays simple and transactional (see ADR-005).
- Users see output only after they stop recording; perceived latency is bound
  by the transcription performance metric (§63) rather than by streaming.
- Chunk reconciliation, diffing, and rollback of partial text do not exist and
  must not be reintroduced implicitly.

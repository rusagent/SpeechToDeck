# ADR-005: Bulk insertion only

Status: Accepted (spec §22-§24, §2.2)

## Context

Character-by-character or incremental text insertion into the Steam virtual
keyboard is slow, observable to the user, and fragile across target
applications. The product requires bulk text insertion that scales to long
transcripts.

## Decision

Text is inserted only as one complete payload through a single semantic
operation. The production architecture is `SteamBulkPasteInserter`, which
coordinates a strict transaction: validate text → validate keyboard context →
write the entire transcript to the clipboard → revalidate the context (the
user may close the keyboard during preparation) → invoke exactly one paste
action → report success. A compatibility gate verifies the paste mechanism; if
no mechanism is verified, the failure is surfaced, never silently degraded.

## Consequences

- The bulk insertion transaction is the primary release-risk area and is
  proven by a Phase-0 spike (§115 Spike B); bulk insertion failure blocks
  Direct Insert v1 (§116).
- No code path may insert partial text (quality gate, §127); streaming output
  has no insertion story (ADR-004).
- Clipboard contents are transient user data and are handled per the clipboard
  and privacy rules (§79, §73): no transcript persistence, no logging.

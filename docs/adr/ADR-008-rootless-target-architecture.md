# ADR-008: Rootless target architecture

Status: Accepted (spec §113, §110)

## Context

Many Decky plugins request root. Elevated privileges would broaden the blast
radius of a plugin that handles microphone input and injects text into
arbitrary applications, and would mask design mistakes that proper
architecture should surface.

## Decision

The initial product target is the no-root flag set: `plugin.json` declares no
root flag, and the audio/STT architecture (microphone access, native runtime,
model storage, insertion) must work unprivileged. Writable paths are restricted
to Decky/plugin data directories with user-only permissions where appropriate;
the transient transcript file is owned by the runtime user, overwritten per
session, and removed on clean shutdown where practical. No persistent audio
file exists. If the verified bulk-insertion implementation unexpectedly
requires elevated access, that becomes an explicit architecture review decision
(new ADR), never a silent flag flip.

## Consequences

- Least privilege for a plugin that records audio and injects text.
- Some insertion or audio mechanisms may prove unavailable without root; those
  findings must surface as explicit decisions, not as quiet root requests.
- Root must not be added merely because another plugin uses it.

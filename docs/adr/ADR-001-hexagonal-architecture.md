# ADR-001: Hexagonal architecture

Status: Accepted (spec §3.1, §4)

## Context

The plugin integrates with several hostile or moving infrastructure surfaces:
Decky, undocumented Steam frontend internals, the DOM, a native speech daemon,
the filesystem, and the clipboard. Embedding any of these into the core logic
would make the dictation workflow untestable and fragile against Steam and
Decky updates.

## Decision

The core application layer knows only abstract ports; adapters implement them
at the edges. Dependency direction points inward:
`Presentation → Application → Domain`, with infrastructure attached through
ports. The composition root (`src/index.tsx` on the frontend, `composition.py`
on the backend) is the only place that constructs dependencies; there is no
service locator and no global mutable container.

## Consequences

- Domain and application logic is unit-testable without Decky, Steam, or audio
  hardware.
- Infrastructure churn (e.g. a Steam UI update) is contained in adapter
  packages (see ADR-006).
- New integrations require writing an adapter plus a port, not editing core
  logic; the port list in `src/application/ports/` is the extension surface.

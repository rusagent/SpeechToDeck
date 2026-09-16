# ADR-002: Native persistent STT daemon

Status: Accepted (spec §35-§38, §47)

## Context

Starting a speech-to-text engine per sentence would pay model-loading overhead
on every dictation and would make latency dependent on model size. The product
requires predictable start/stop performance budgets (spec §62) on Steam Deck
hardware, with CPU and Vulkan compute backends.

## Decision

v1 runs a native, persistent STT daemon outside the Decky Python process. It
stays alive while dictation is enabled with `on_demand_loading = false`: the
model is loaded once at plugin startup and kept in an idle-ready state. The
model unloads only on plugin disable, compute backend change, model change,
configuration-driven restart, or Decky unload. The backend supervises the
daemon process (`SpeechDaemonSupervisor`, child lifetime ownership, no unread
pipes).

## Consequences

- Repeat dictations avoid model-load latency; start/stop budgets are
  achievable.
- A resident process adds lifecycle obligations: supervised restart, clean
  unload, and child-process lifetime management are product requirements, not
  optional hygiene.
- Memory is held while idle; this is accepted in exchange for latency (spec
  §65 governs the memory policy).

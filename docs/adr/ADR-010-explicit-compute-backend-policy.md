# ADR-010: Explicit compute backend policy

Status: Accepted (spec §47, §116, §32)

## Context

whisper.cpp can run on CPU or Vulkan. Silent fallbacks between backends would
hide broken Vulkan setups and produce unexplained latency or battery drain,
violating the no-silent-compatibility-fallback requirement (§2.4). Phase-0
Spike D (§115) benchmarks Vulkan against CPU on LCD and OLED before any
architecture assumption is finalized.

## Decision

The compute backend is an explicit user setting: `cpu`, `vulkan`, or `auto`.

- `cpu`: CPU only; failure does not switch backend.
- `vulkan`: Vulkan required; initialization failure surfaces an error — no
  silent CPU fallback.
- `auto`: the user explicitly selected the probe policy — probe Vulkan and use
  it when supported, otherwise use CPU. Because the user chose `auto`, this is
  a selected policy, not a hidden fallback.

## Consequences

- Vulkan may fail in Phase-0 without blocking the product, because CPU is an
  explicitly supported backend (§116).
- Backend switches (like model or language changes requiring restart) unload
  and reload the daemon model (ADR-002).
- Diagnostics expose the active backend (§74), so a user on `auto` can see
  which backend was probed.

# Hardware Compatibility Checklist

Required coverage for the hardware test suite (spec §93, canon). This file is
the tracking checklist; it is complete only when every cell below has been
executed on real devices. Hardware runs are Phase-0 work and are currently
**pending** (see docs/development/IMPLEMENTATION_STATUS.md).

## Devices

- [ ] Steam Deck LCD
- [ ] Steam Deck OLED

## Steam channels

- [ ] Steam Stable
- [ ] Steam Beta

## Target categories (spec §93)

For each device x channel combination:

- [ ] Steam search
- [ ] Steam chat
- [ ] Native Linux app
- [ ] XWayland app
- [ ] Proton app/game

## Additional gates that depend on hardware runs

- [ ] Phase-0 spikes A-D executed and recorded (spec §115): keyboard mounting
      (100 clean mount/unmount cycles), bulk insertion, STT runtime in Game
      Mode, Vulkan vs CPU benchmark on LCD and OLED.
- [ ] Phase-0 exit gate evaluated (spec §116): A/B/C PASS required; Vulkan may
      fail without blocking (CPU is a supported backend); bulk insertion
      failure blocks Direct Insert v1.
- [ ] Compute backend policy validated on both devices (spec §47, ADR-010):
      `vulkan` failure surfaces an error, never a silent CPU fallback; `auto`
      probes Vulkan first as the explicitly user-selected policy.
- [ ] Performance budgets verified on hardware (spec §62-64, §96): UI
      interaction, start command, stop overhead, bulk insertion overhead, idle
      behaviour.
- [ ] Microphone indicator integrity verified (spec §75).

## Rules

- No silent compatibility fallback (spec §2.4): if a target does not work, the
  incompatibility is surfaced, never worked around invisibly.
- Results are recorded per device, channel, and target; partial passes are not
  passes.

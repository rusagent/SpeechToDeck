# Architecture Overview

Derived from docs/spec/spec-v1.0.md §3-4 (canon). If this document and the
spec disagree, the spec wins and this file must be corrected.

## Hexagonal architecture (spec §3.1)

The core application layer knows only abstract ports. Infrastructure
dependencies — Decky, Steam frontend internals, the DOM, the native speech
daemon, the filesystem, and the clipboard implementation — never leak into the
domain or application model.

Dependency direction:

```text
Infrastructure ─────┐
                    ▼
Presentation → Application → Domain
                    ▲
Infrastructure ─────┘
```

Layer contents (spec §4-6):

- **Domain** — `DictationSession`, `DictationState`, `DictationError`,
  `Capability`, `Result`. Pure model, no I/O.
- **Application** — `DictationController`, `DictationStateMachine`,
  `PluginLifecycle`, and the ports (`SpeechPort`, `KeyboardHostPort`,
  `BulkTextInserter`, `SettingsPort`, `ClipboardPort`, `PasteActionPort`,
  `ClockPort`, `IdGeneratorPort`).
- **Presentation** — `MicrophoneButtonMount` / `MicrophoneButton` and the
  settings panel components.
- **Infrastructure** — adapters: `src/infrastructure/decky/` (Decky backend
  client, speech and settings adapters) and `src/infrastructure/steam/` (the
  Steam anti-corruption layer).
- **Composition root** — `src/index.tsx` only wires dependencies (spec §6): no
  service locator, no global mutable container, no dependency instantiation
  inside application or domain classes.

The Python backend mirrors the same discipline (`backend/` with
`application/`, `domain/`, `infrastructure/`, and a `composition.py` root).

## Anti-corruption layer for Steam internals (spec §3.3)

Everything touching undocumented Steam structures lives exclusively below
`src/infrastructure/steam/`. No other layer may access `window.SteamUIStore`,
`VirtualKeyboardManager`, `BrowserWindow`, `__reactFiber$`, Steam keyboard DOM
internals, or Steam private component methods. A Steam update should require
changes only inside this package. See ADR-006.

## Principles that constrain every layer

- **Composition over inheritance** (§3.2): TypeScript interfaces, Python
  `Protocol`s, tagged unions, immutable value objects.
- **Explicit state machine** (§3.4, §8): dictation state is a discriminated
  union driven by a pure transition function; independent boolean flags such as
  `isRecording` / `hasError` are forbidden because they permit invalid
  combinations.
- **Single ownership** (§3.5): each resource has exactly one owner (keyboard
  hook → `SteamKeyboardHostAdapter`, injected React root →
  `MicrophoneButtonMount`, active session → `DictationController`, daemon →
  `SpeechDaemonSupervisor`, active backend recording →
  `SpeechSessionCoordinator`, model files → `ModelStore`); the owner performs
  cleanup.

## End-to-end data flow (spec §4, §21)

```text
Steam Virtual Keyboard (with mounted mic button)
        ↓ Decky callable/events
Decky Frontend: Presentation → Application (controller + state machine) → ports
        ↓ Steam ACL adapters              Decky adapters
        ↓                                 Decky Python Backend:
        ↓                                 SpeechApplicationService →
        ↓                                 SpeechSessionCoordinator →
        ↓                                 SpeechDaemonSupervisor
        ↓                                     ↓ process IPC
        ↓                                 Native STT runtime (Voxtype daemon
        ↓                                 → whisper.cpp → CPU/Vulkan)
        ↓ transcript_ready
One complete payload inserted via clipboard + one paste action (§23-24)
```

Pipeline per utterance: record full utterance → stop → transcribe final
utterance → insert one complete string. There is no live streaming in v1
(ADR-004) and no character-by-character insertion (ADR-005).

## Decision records

Architectural decisions and their consequences are recorded in
[docs/adr/](../adr/); ADR-001 through ADR-010 are the initial set required by
spec §126. Architecture changes require new ADRs instead of silently rewriting
assumptions.

# Decky Voice Keyboard

## Technical Specification v1.0

**Status:** Implementation-ready specification
**Target:** Steam Deck Game Mode / Decky Loader
**Primary platform:** Steam Deck LCD and OLED
**Architecture:** Hexagonal Architecture with isolated Steam Anti-Corruption Layer
**Primary use case:** Local speech-to-text with one-shot bulk insertion into the text target currently controlled by the Steam virtual keyboard.

---

# 1. Product Definition

Decky Voice Keyboard adds a microphone action directly to the Steam virtual keyboard.

The primary interaction is:

1. A text field opens the Steam virtual keyboard.
2. The plugin injects a microphone button into that keyboard.
3. The user presses the microphone button.
4. Recording starts immediately.
5. The user speaks.
6. The user presses the microphone button again.
7. Recording stops.
8. The complete recording is transcribed locally.
9. The complete resulting string is inserted into the original text target in one bulk insertion operation.
10. The Steam keyboard remains open.
11. The plugin does not automatically press Enter or submit the field.

No cloud transcription is used.

Audio is not persisted after transcription.

---

# 2. Hard Product Requirements

The following requirements are release blockers.

## 2.1 Local processing

Speech recognition MUST run locally on the Steam Deck.

The normal dictation path MUST NOT:

* contact a transcription API;
* upload audio;
* require an account;
* require an API key;
* transmit transcripts;
* transmit telemetry containing spoken content.

The only network operation required during normal setup is downloading model/runtime artifacts.

---

## 2.2 Bulk insertion

The transcript MUST be inserted as one text payload.

Production code MUST NOT implement transcript insertion using:

```ts
for (const character of text) {
    typeCharacter(character);
}
```

or any equivalent mechanism.

The accepted semantics are:

```text
complete transcript
       ↓
single clipboard/text payload
       ↓
single paste/text insertion operation
       ↓
target field
```

A modifier chord required to invoke a paste operation does not violate this requirement because the transcript itself is not transmitted as individual key events.

---

## 2.3 No automatic submit

After insertion:

* no Enter key is emitted;
* no chat message is automatically sent;
* no form is automatically submitted.

The user retains final control.

---

## 2.4 No silent compatibility fallback

If bulk insertion cannot be performed safely for the current Steam build or target context:

* the plugin MUST NOT silently switch to character-by-character typing;
* the plugin MUST report that direct insertion is unavailable;
* the transcript MAY remain available to the user through an explicitly selected Clipboard Only mode.

`Clipboard Only` is a user-visible mode, not an automatic fallback.

---

# 3. Architectural Principles

The implementation SHALL use the following architectural rules.

## 3.1 Hexagonal Architecture

The core application layer knows only abstract ports.

Infrastructure dependencies include:

* Decky;
* Steam frontend internals;
* DOM;
* native speech daemon;
* filesystem;
* clipboard implementation.

None of those may leak into the domain/application model.

Dependency direction:

```text
Infrastructure ─────┐
                    ▼
Presentation → Application → Domain
                    ▲
Infrastructure ─────┘
```

---

## 3.2 Composition over inheritance

Inheritance SHALL NOT be used to model infrastructure variants unless subtype polymorphism is genuinely required.

Prefer:

* TypeScript interfaces;
* Python `Protocol`;
* tagged unions;
* composition;
* immutable value objects.

---

## 3.3 Anti-Corruption Layer for Steam internals

Everything touching undocumented Steam structures MUST live below:

```text
src/infrastructure/steam/
```

No other layer may access:

```text
window.SteamUIStore
VirtualKeyboardManager
BrowserWindow
__reactFiber$
Steam keyboard DOM internals
Steam private component methods
```

Changing Steam internals should require changes only in this package.

---

## 3.4 Explicit State Machine

Dictation workflow MUST use a deterministic state machine.

Boolean combinations such as:

```ts
isRecording
isLoading
isTranscribing
hasError
```

as independent mutable state are forbidden.

They permit invalid combinations.

The application state must instead be a discriminated union.

---

## 3.5 Single ownership

Each resource has exactly one owner:

* keyboard hook → `SteamKeyboardHostAdapter`;
* injected React root → `MicrophoneButtonMount`;
* active dictation session → `DictationController`;
* native daemon → `SpeechDaemonSupervisor`;
* active backend recording → `SpeechSessionCoordinator`;
* model files → `ModelStore`.

Cleanup responsibility belongs to the owner.

---

# 4. High-Level Architecture

```text
┌─────────────────────────────────────────────┐
│ Steam Game / Steam UI / Application         │
│                  ▲                          │
│                  │ complete text payload    │
│                  │                          │
│         Steam Virtual Keyboard              │
│       ┌───────────────────────┐             │
│       │                  🎤   │             │
│       └──────────┬────────────┘             │
└──────────────────┼──────────────────────────┘
                   │
                   ▼
┌─────────────────────────────────────────────┐
│ Decky Frontend                              │
│                                             │
│ Presentation                                │
│   MicButton                                 │
│   SettingsPanel                             │
│                                             │
│ Application                                 │
│   DictationController                       │
│   DictationStateMachine                     │
│                                             │
│ Ports                                       │
│   SpeechPort                                │
│   KeyboardHostPort                         │
│   BulkTextInserter                         │
│   SettingsPort                             │
│                                             │
│ Steam ACL                                   │
│   SteamKeyboardHostAdapter                  │
│   SteamBulkPasteInserter                    │
└──────────────────┬──────────────────────────┘
                   │ Decky callable/events
                   ▼
┌─────────────────────────────────────────────┐
│ Decky Python Backend                        │
│                                             │
│ Plugin facade                               │
│ SpeechApplicationService                    │
│ SpeechSessionCoordinator                    │
│ SpeechDaemonSupervisor                      │
│ ModelStore                                  │
│ SettingsRepository                          │
└──────────────────┬──────────────────────────┘
                   │ process IPC
                   ▼
┌─────────────────────────────────────────────┐
│ Native STT Runtime                          │
│                                             │
│ Voxtype daemon                              │
│    ↓                                        │
│ whisper.cpp                                 │
│    ↓                                        │
│ CPU / Vulkan                                │
└─────────────────────────────────────────────┘
```

---

# 5. Repository Layout

```text
/
├── src/
│   ├── index.tsx
│   │
│   ├── domain/
│   │   ├── DictationSession.ts
│   │   ├── DictationState.ts
│   │   ├── DictationError.ts
│   │   ├── Capability.ts
│   │   └── Result.ts
│   │
│   ├── application/
│   │   ├── DictationController.ts
│   │   ├── DictationStateMachine.ts
│   │   ├── PluginLifecycle.ts
│   │   └── ports/
│   │       ├── SpeechPort.ts
│   │       ├── KeyboardHostPort.ts
│   │       ├── BulkTextInserter.ts
│   │       ├── SettingsPort.ts
│   │       ├── ClipboardPort.ts
│   │       ├── PasteActionPort.ts
│   │       ├── ClockPort.ts
│   │       └── IdGeneratorPort.ts
│   │
│   ├── infrastructure/
│   │   ├── decky/
│   │   │   ├── DeckyBackendClient.ts
│   │   │   ├── DeckySpeechAdapter.ts
│   │   │   └── DeckySettingsAdapter.ts
│   │   │
│   │   └── steam/
│   │       ├── SteamKeyboardHostAdapter.ts
│   │       ├── SteamKeyboardLocator.ts
│   │       ├── SteamKeyboardContext.ts
│   │       ├── SteamCapabilityProbe.ts
│   │       ├── SteamBulkPasteInserter.ts
│   │       ├── SteamClipboardAdapter.ts
│   │       ├── SteamPasteActionAdapter.ts
│   │       ├── SteamInternalTypes.ts
│   │       └── SteamHookRegistry.ts
│   │
│   ├── presentation/
│   │   ├── keyboard/
│   │   │   ├── MicrophoneButtonMount.tsx
│   │   │   ├── MicrophoneButton.tsx
│   │   │   └── MicrophoneButtonModel.ts
│   │   │
│   │   └── settings/
│   │       ├── SettingsPanel.tsx
│   │       ├── ModelPicker.tsx
│   │       ├── LanguagePicker.tsx
│   │       ├── ComputeBackendPicker.tsx
│   │       └── DiagnosticsPanel.tsx
│   │
│   └── shared/
│       ├── Disposable.ts
│       ├── Logger.ts
│       ├── Deferred.ts
│       ├── Mutex.ts
│       └── assertNever.ts
│
├── backend/
│   ├── application/
│   │   ├── speech_service.py
│   │   └── model_service.py
│   │
│   ├── domain/
│   │   ├── contracts.py
│   │   ├── session.py
│   │   └── errors.py
│   │
│   ├── infrastructure/
│   │   ├── process/
│   │   │   ├── daemon_supervisor.py
│   │   │   ├── voxtype_client.py
│   │   │   ├── status_monitor.py
│   │   │   └── process_environment.py
│   │   │
│   │   ├── model/
│   │   │   ├── model_store.py
│   │   │   └── model_manifest.py
│   │   │
│   │   └── settings/
│   │       └── json_settings_repository.py
│   │
│   └── composition.py
│
├── main.py
├── bin/
├── defaults/
│   └── models.json
├── tests/
│   ├── frontend/
│   ├── backend/
│   ├── contract/
│   └── fixtures/
├── scripts/
├── docs/
│   ├── architecture/
│   ├── compatibility/
│   └── development/
├── package.json
├── plugin.json
├── tsconfig.json
├── pyproject.toml
└── THIRD_PARTY_NOTICES.md
```

---

# 6. Composition Root

`src/index.tsx` SHALL NOT contain application logic.

It creates dependencies and wires them.

Conceptually:

```ts
const backendClient = new DeckyBackendClient();

const speechPort = new DeckySpeechAdapter(backendClient);
const keyboardHost = new SteamKeyboardHostAdapter();
const capabilityProbe = new SteamCapabilityProbe();

const clipboard = new SteamClipboardAdapter();
const pasteAction = new SteamPasteActionAdapter();

const textInserter = new SteamBulkPasteInserter(
    clipboard,
    pasteAction,
    keyboardHost,
);

const settings = new DeckySettingsAdapter(backendClient);

const controller = new DictationController(
    speechPort,
    keyboardHost,
    textInserter,
    settings,
    new SystemClock(),
    new RandomIdGenerator(),
);

const lifecycle = new PluginLifecycle(
    controller,
    keyboardHost,
    speechPort,
);

lifecycle.start();
```

No service locator.

No global mutable dependency container.

No dependency may be instantiated inside application-domain classes.

---

# 7. Domain Model

## 7.1 DictationSession

```ts
export interface DictationSession {
    readonly sessionId: string;
    readonly keyboardContextId: string;
    readonly startedAtMonotonicMs: number;
}
```

A session always belongs to the keyboard context that existed when recording began.

---

## 7.2 Keyboard context

```ts
export interface KeyboardContext {
    readonly id: string;
    readonly windowToken: string;
    readonly visible: boolean;
}
```

Every keyboard appearance generates a new context ID.

A transcript MUST NOT be inserted into a different context.

---

# 8. Dictation State Machine

```ts
export type DictationState =
    | { kind: "booting" }
    | { kind: "unavailable"; reason: UnavailableReason }
    | { kind: "ready" }
    | { kind: "starting"; session: DictationSession }
    | { kind: "recording"; session: DictationSession }
    | { kind: "stopping"; session: DictationSession }
    | { kind: "transcribing"; session: DictationSession }
    | {
          kind: "inserting";
          session: DictationSession;
          transcript: string;
      }
    | {
          kind: "error";
          error: DictationError;
          recoverable: boolean;
      };
```

Valid normal transition:

```text
booting
   ↓
ready
   ↓ press
starting
   ↓ acknowledgement
recording
   ↓ press
stopping
   ↓ acknowledgement
transcribing
   ↓ transcript
inserting
   ↓ inserted
ready
```

---

## 8.1 Forbidden transitions

Examples:

```text
ready → transcribing
recording → inserting
inserting → recording
error → recording
```

must be rejected by the state machine.

---

## 8.2 Pure transition function

```ts
export interface TransitionResult {
    readonly state: DictationState;
    readonly effects: readonly DictationEffect[];
}
```

```ts
export function transition(
    current: DictationState,
    event: DictationEvent,
): TransitionResult;
```

The transition function:

* performs no I/O;
* accesses no global state;
* contains no Decky calls;
* contains no DOM calls;
* is fully unit-testable.

---

# 9. DictationController

`DictationController` is the application orchestrator.

```ts
export class DictationController implements Disposable {
    constructor(
        private readonly speech: SpeechPort,
        private readonly keyboard: KeyboardHostPort,
        private readonly inserter: BulkTextInserter,
        private readonly settings: SettingsPort,
        private readonly clock: ClockPort,
        private readonly ids: IdGeneratorPort,
    ) {}

    start(): Promise<void>;

    handleMicrophonePressed(): Promise<void>;

    handleKeyboardOpened(
        context: KeyboardContext,
    ): void;

    handleKeyboardClosed(
        contextId: string,
    ): Promise<void>;

    dispose(): Promise<void>;
}
```

Responsibilities:

* own current application state;
* create sessions;
* serialize microphone actions;
* dispatch state-machine effects;
* reject stale backend events;
* verify keyboard context before insertion;
* invoke bulk insertion;
* expose read-only state subscription to presentation layer.

It MUST NOT:

* know DOM selectors;
* know Steam internals;
* spawn processes;
* know file paths;
* directly call Decky.

---

# 10. Concurrency Model

Exactly one dictation session may exist.

`DictationController` SHALL maintain an async operation mutex.

Repeated microphone presses while an operation is being accepted MUST NOT start parallel calls.

Example:

```text
press
  → start request pending
press again
  → ignored until start acknowledgement
```

The button itself is disabled during transient states.

---

# 11. Stale Result Protection

Every frontend/backend operation carries `sessionId`.

Backend event:

```ts
export interface TranscriptReadyEvent {
    readonly sessionId: string;
    readonly text: string;
    readonly metrics: TranscriptionMetrics;
}
```

The frontend accepts it only when:

```ts
event.sessionId === activeSession.sessionId
```

and:

```ts
activeSession.keyboardContextId ===
    keyboard.currentContext()?.id
```

Otherwise the result is stale and MUST NOT be injected.

---

# 12. Keyboard Close Safety

If the keyboard disappears while recording:

```text
Recording
   ↓ keyboard closed
Cancel recording
   ↓
Discard captured audio/result
   ↓
Ready when next keyboard appears
```

If it disappears while transcription is already running:

* transcription may finish;
* insertion MUST be suppressed;
* transcript MAY be retained temporarily in application memory;
* the user may manually copy it from the plugin panel.

It MUST NOT be inserted into whatever happens to receive focus afterward.

---

# 13. KeyboardHostPort

```ts
export interface KeyboardHostPort {
    start(): Promise<void>;

    currentContext(): KeyboardContext | null;

    subscribe(
        listener: KeyboardHostListener,
    ): Disposable;

    mountMicrophoneControl(
        props: MicrophoneControlProps,
    ): Disposable;

    stop(): Promise<void>;
}
```

---

# 14. SteamKeyboardHostAdapter

This adapter exclusively owns Steam-private behavior.

Responsibilities:

1. locate active Steam window;
2. locate virtual keyboard;
3. detect keyboard appearance;
4. detect disappearance;
5. create keyboard context ID;
6. locate safe microphone mount position;
7. mount React control;
8. restore all hooks on unload.

It MUST NOT contain dictation logic.

---

# 15. Steam Hooking Strategy

The adapter may instrument:

```text
VirtualKeyboardManager.SetVirtualKeyboardVisible
VirtualKeyboardManager.SetVirtualKeyboardHidden
```

but the wrapper MUST preserve:

* original arguments;
* return value;
* `this`;
* exception behavior.

Conceptual implementation:

```ts
function (...args: unknown[]) {
    const result = original.apply(this, args);

    queueMicrotask(() => {
        notifyKeyboardLifecycle();
    });

    return result;
}
```

The wrapper MUST NOT assume the method has zero arguments.

---

# 16. Hook Ownership and Plugin Compatibility

`SteamHookRegistry` owns every installed hook.

```ts
export interface InstalledHook extends Disposable {
    readonly target: object;
    readonly property: string;
}
```

On unload:

* restore a function only when the currently installed function is still the wrapper owned by this plugin;
* do not overwrite modifications made later by another plugin;
* cleanup MUST be idempotent.

No persistent Steam files are patched.

---

# 17. SteamKeyboardLocator

```ts
export class SteamKeyboardLocator {
    locateWindow(): SteamWindowHandle | null;

    locateKeyboardDom(
        window: SteamWindowHandle,
    ): HTMLElement | null;

    locateKeyboardComponent(
        dom: HTMLElement,
    ): SteamKeyboardComponent | null;
}
```

Discovery SHALL be bounded.

No endless polling loop.

After a keyboard-open notification:

```text
attempt immediately
then retry with short bounded backoff
stop after configured deadline
```

Recommended maximum discovery window:

```text
1000 ms
```

Once found, use event-driven lifecycle observation.

---

# 18. Microphone Button Mounting

A dedicated React root/portal is mounted into a plugin-owned DOM node.

Steam-owned child elements MUST NOT be replaced.

Example:

```html
<div id="virtual keyboard">
    ...
    <div data-decky-voice-keyboard-root></div>
</div>
```

Cleanup removes only the plugin-owned node.

---

# 19. MicrophoneButton

`MicrophoneButton` is a pure presentation component.

```ts
export interface MicrophoneButtonProps {
    readonly state: MicrophoneVisualState;
    readonly disabled: boolean;
    readonly onPress: () => void;
}
```

Visual states:

```ts
export type MicrophoneVisualState =
    | "ready"
    | "recording"
    | "processing"
    | "error";
```

The component contains no backend logic.

---

# 20. Button Behaviour

### Ready

Icon:

```text
microphone
```

Press:

```text
start recording
```

### Recording

Visual:

* clearly active;
* recording indicator;
* optional subtle timer.

Press:

```text
stop recording
```

### Processing

Visual:

```text
spinner / processing indicator
```

Button disabled.

### Error

Short visible indicator.

Detailed error remains in Decky plugin panel.

---

# 21. No Live Streaming in v1

v1 does not stream partial words into the text field.

Reasons:

* user requested final bulk insertion;
* partial text would violate the one-shot insertion model;
* chunk reconciliation introduces complexity;
* repeated target mutation creates focus and consistency problems.

Pipeline is:

```text
record full utterance
        ↓
stop
        ↓
transcribe final utterance
        ↓
insert one complete string
```

---

# 22. BulkTextInserter Contract

This interface expresses a semantic guarantee, not merely a method name.

```ts
export interface BulkTextInserter {
    probe(
        context: KeyboardContext,
    ): Promise<BulkInsertionCapability>;

    insert(
        context: KeyboardContext,
        text: string,
    ): Promise<BulkInsertResult>;
}
```

A compliant implementation MUST:

* send the text as one payload;
* perform no per-character iteration;
* perform no character-to-keycode translation;
* preserve Unicode;
* not submit the field;
* target only the currently verified keyboard context.

---

# 23. Production Bulk Insertion Architecture

Production implementation:

```text
SteamBulkPasteInserter
        │
        ├── ClipboardPort
        │       ↓
        │   complete transcript
        │
        └── PasteActionPort
                ↓
          one native paste
```

`SteamBulkPasteInserter` coordinates the transaction.

```ts
export class SteamBulkPasteInserter
    implements BulkTextInserter {

    constructor(
        private readonly clipboard: ClipboardPort,
        private readonly pasteAction: PasteActionPort,
        private readonly keyboard: KeyboardHostPort,
    ) {}

    async insert(
        context: KeyboardContext,
        text: string,
    ): Promise<BulkInsertResult>;
}
```

---

# 24. Bulk Insertion Transaction

Required transaction sequence:

```text
1. Validate text.
2. Validate keyboard context.
3. Write entire transcript to clipboard.
4. Revalidate keyboard context.
5. Invoke exactly one paste action.
6. Return success.
```

Context is checked twice because the user may close the keyboard while clipboard preparation is running.

---

# 25. ClipboardPort

```ts
export interface ClipboardPort {
    probe(
        context: KeyboardContext,
    ): Promise<ClipboardCapability>;

    writeText(
        context: KeyboardContext,
        text: string,
    ): Promise<void>;
}
```

It always accepts the complete string.

Maximum supported transcript for v1:

```text
16 KiB UTF-8
```

Larger results are rejected with a controlled error.

This is substantially larger than normal game-chat input while protecting against accidental pathological payloads.

---

# 26. PasteActionPort

```ts
export interface PasteActionPort {
    probe(
        context: KeyboardContext,
    ): Promise<PasteCapability>;

    invokePaste(
        context: KeyboardContext,
    ): Promise<void>;
}
```

`invokePaste()` MUST invoke the native semantic paste operation associated with the currently visible Steam keyboard.

It MUST NOT type the contents itself.

---

# 27. Steam Paste Compatibility Gate

The exact Steam-internal paste hook is a mandatory Phase-0 hardware validation item.

A production adapter is accepted only when all of the following pass:

1. Steam search.
2. Steam friends/chat.
3. native Linux text field.
4. XWayland application.
5. Proton application/game text field.
6. Steam Stable.
7. Steam Beta.
8. Steam Deck LCD.
9. Steam Deck OLED.

The adapter MUST also pass Unicode tests containing:

```text
ä ö ü Ä Ö Ü ß
quotes
apostrophes
commas
periods
colon
semicolon
question mark
exclamation mark
line-safe whitespace
```

The release MUST be blocked if no compliant adapter exists.

Character typing is not an acceptable workaround.

---

# 28. Candidate Paste Mechanisms

Phase 0 investigates, in this order:

### Candidate A — Steam keyboard native Paste action

Preferred.

Use the same semantic action the Steam keyboard exposes to the user.

The plugin supplies clipboard content and invokes that action once.

### Candidate B — internal complete-string Steam text insertion

Accept only if runtime inspection demonstrates an internal API that accepts the complete string in a single invocation.

`TypeKeyInternal()` MUST NOT be assumed to satisfy this requirement.

It may be used only if a hardware test proves one complete-string call performs one bulk insertion.

### Candidate C — Clipboard Only

Compatibility mode only.

It copies the final transcript and tells the user that direct insertion is unavailable.

It is not considered fulfillment of the default direct-insert feature.

---

# 29. SpeechPort

Frontend application contract:

```ts
export interface SpeechPort {
    initialize(): Promise<SpeechCapabilities>;

    startRecording(
        sessionId: string,
    ): Promise<void>;

    stopRecording(
        sessionId: string,
    ): Promise<void>;

    cancelRecording(
        sessionId: string,
    ): Promise<void>;

    subscribe(
        listener: SpeechEventListener,
    ): Disposable;

    shutdown(): Promise<void>;
}
```

---

# 30. DeckySpeechAdapter

Maps application calls to Decky callables.

No domain logic.

Callables:

```text
get_capabilities
get_status
start_recording
stop_recording
cancel_recording
get_settings
update_settings
list_models
download_model
cancel_model_download
restart_runtime
```

Backend events:

```text
speech_status
transcript_ready
speech_error
model_download_progress
model_download_complete
runtime_status
```

---

# 31. Backend main.py

The root `Plugin` class remains deliberately thin.

```python
class Plugin:
    def __init__(self) -> None:
        self._app = None

    async def _main(self) -> None:
        ...

    async def _unload(self) -> None:
        ...

    async def _uninstall(self) -> None:
        ...

    async def _migration(self) -> None:
        ...

    async def start_recording(
        self,
        session_id: str,
    ) -> dict:
        ...

    async def stop_recording(
        self,
        session_id: str,
    ) -> dict:
        ...
```

It does not contain:

* process management;
* model downloads;
* filesystem business logic;
* transcription state transitions.

Those are delegated.

---

# 32. Backend Contracts

Use structural interfaces.

```python
from typing import Protocol


class SpeechRuntime(Protocol):
    async def start(self) -> None: ...
    async def stop(self) -> None: ...
    async def start_recording(self) -> None: ...
    async def stop_recording(self) -> None: ...
    async def cancel_recording(self) -> None: ...


class SettingsRepository(Protocol):
    async def load(self) -> "Settings": ...
    async def save(self, settings: "Settings") -> None: ...


class ModelRepository(Protocol):
    async def list_models(self) -> list["ModelInfo"]: ...
    async def ensure_model(self, model_id: str) -> None: ...


class EventPublisher(Protocol):
    async def publish(
        self,
        event_name: str,
        payload: dict,
    ) -> None: ...
```

No inheritance hierarchy is required.

---

# 33. SpeechApplicationService

```python
class SpeechApplicationService:
    def __init__(
        self,
        runtime: SpeechRuntime,
        sessions: "SpeechSessionCoordinator",
        publisher: EventPublisher,
    ) -> None:
        ...

    async def start_recording(
        self,
        session_id: str,
    ) -> None:
        ...

    async def stop_recording(
        self,
        session_id: str,
    ) -> None:
        ...

    async def cancel_recording(
        self,
        session_id: str,
    ) -> None:
        ...
```

Responsibilities:

* validate session IDs;
* enforce single-session invariant;
* coordinate runtime;
* correlate native results with Decky events.

---

# 34. SpeechSessionCoordinator

Backend has its own concurrency guard because frontend correctness cannot be trusted as a security/concurrency boundary.

State:

```python
@dataclass(frozen=True)
class ActiveSpeechSession:
    session_id: str
    started_monotonic: float
```

Internally:

```python
self._lock = asyncio.Lock()
self._active_session: ActiveSpeechSession | None = None
```

Exactly one active session.

---

# 35. Native Runtime Choice

v1 uses a pinned Voxtype runtime configured for:

```text
engine = whisper
output = file
hotkey = disabled
streaming = disabled
eager processing = disabled
model kept loaded
```

The runtime is treated as replaceable infrastructure.

Application code MUST NOT depend on Voxtype-specific concepts.

---

# 36. Why a persistent daemon

Starting Whisper for every sentence would incur model-loading overhead.

The native daemon therefore stays alive while dictation is enabled.

Configuration:

```text
on_demand_loading = false
```

Result:

```text
plugin startup
    ↓
load model once
    ↓
idle ready state
    ↓
record
    ↓
infer
    ↓
record
    ↓
infer
```

The model unloads only when:

* plugin is disabled;
* compute backend changes;
* model changes;
* language/runtime configuration requires restart;
* Decky unloads the plugin.

---

# 37. SpeechDaemonSupervisor

Supervisor pattern.

```python
class SpeechDaemonSupervisor:
    async def start(self) -> None: ...
    async def stop(self) -> None: ...
    async def restart(self) -> None: ...

    def is_running(self) -> bool: ...
```

Responsibilities:

* start exact pinned binary;
* redirect stdout/stderr to file;
* monitor exit code;
* own process handle;
* guarantee cleanup;
* detect unexpected exit;
* notify application layer;
* prevent orphan process.

---

# 38. Child Process Lifetime

Linux child process SHALL be configured so that loss of the Decky backend cannot leave the STT daemon running indefinitely.

The supervisor additionally stops the process explicitly in `_unload`.

Normal stop order:

```text
stop accepting sessions
        ↓
cancel recording
        ↓
stop status monitor
        ↓
SIGTERM daemon
        ↓
bounded wait
        ↓
SIGKILL only if required
```

---

# 39. No unread process pipes

Persistent daemon stdout/stderr MUST NOT be attached to pipes that nobody drains.

Use:

```text
plugin log file
```

or an actively consumed async stream.

Default production implementation uses a rotating/truncated daemon log.

Logs contain diagnostics only.

Transcripts MUST NOT be logged.

---

# 40. Native Runtime Control

Use argument-array subprocess invocation only.

Correct:

```python
await asyncio.create_subprocess_exec(
    binary,
    "record",
    "start",
)
```

Forbidden:

```python
os.system(...)
subprocess.run(..., shell=True)
```

No user-supplied value becomes shell syntax.

---

# 41. Runtime Status Monitor

Use one persistent status monitor rather than repeated polling.

```python
class RuntimeStatusMonitor:
    async def start(self) -> None: ...
    async def stop(self) -> None: ...
```

It consumes native status changes and emits typed internal events.

No 100-ms timer loop.

No constant filesystem polling.

---

# 42. Transcript Correlation

Before recording:

1. remove/truncate previous transcript output;
2. create active session;
3. capture monotonic start time;
4. issue native recording start.

After stop:

1. issue native stop;
2. wait for final transcription state;
3. read newly produced output exactly once;
4. normalize result;
5. attach active `sessionId`;
6. emit `transcript_ready`.

A transcript from a previous session MUST never be reused.

---

# 43. Transcript Normalization

Normalization is deliberately minimal.

Allowed:

* trim leading/trailing whitespace;
* normalize invalid UTF-8 handling at process boundary;
* reject NUL characters;
* enforce maximum size.

Forbidden by default:

* rewriting grammar;
* LLM correction;
* changing words;
* automatically adding chat commands;
* translating;
* automatically appending punctuation not produced by STT.

The transcript remains what the STT engine produced.

---

# 44. Audio Configuration

Default:

```text
sample rate: 16000 Hz
channels: mono
maximum recording: 60 seconds
input device: system default
```

Users may select an alternative microphone later through settings if device enumeration is supported.

---

# 45. Voice Activity Detection

v1 enables lightweight VAD to reject accidental silence.

VAD is not used to stream text.

Its purposes are:

* ignore silence-only recordings;
* reduce hallucinations caused by silence;
* avoid unnecessary inference.

VAD must not automatically stop recording while the user is speaking.

The user controls stop via microphone button.

---

# 46. Eager Processing

Disabled by default:

```text
eager_processing = false
```

The final utterance is processed in one coherent pass.

This maximizes determinism and avoids chunk-boundary reconciliation.

Future versions may benchmark an eager mode separately.

---

# 47. Compute Backend

```ts
export type ComputeBackend =
    | "auto"
    | "vulkan"
    | "cpu";
```

Semantics:

### cpu

CPU only.

Failure does not switch backend.

### vulkan

Vulkan required.

If Vulkan initialization fails, surface an error.

No silent CPU fallback.

### auto

Explicit user-selected policy:

```text
probe Vulkan
    ↓ supported
use Vulkan

probe fails
    ↓
use CPU
```

Because the user selected `auto`, this behavior is not considered a hidden fallback.

---

# 48. Default Model

Default:

```text
base
```

not:

```text
base.en
```

The product is multilingual by default.

Curated v1 model set:

```text
tiny
base
small
```

Advanced models may later be exposed after device performance validation.

---

# 49. Language Selection

```ts
export type LanguageSetting =
    | { kind: "system" }
    | { kind: "auto" }
    | { kind: "explicit"; code: string };
```

Default:

```text
system
```

`system` attempts to map the Steam UI language to the speech engine's supported language code.

If mapping does not exist:

```text
language selection unavailable
```

must be surfaced.

It must not silently invent a language.

The user may explicitly select `auto`.

---

# 50. Model Manifest

Models are described through a checked-in immutable manifest.

Example:

```json
{
  "schemaVersion": 1,
  "models": [
    {
      "id": "base",
      "engine": "whisper",
      "multilingual": true,
      "sha256": "...",
      "downloadUrl": "...",
      "filename": "ggml-base.bin"
    }
  ]
}
```

Never construct download URLs directly from arbitrary user input.

---

# 51. ModelStore

```python
class ModelStore:
    async def list_models(self) -> list[ModelInfo]: ...
    async def is_installed(self, model_id: str) -> bool: ...
    async def download(self, model_id: str) -> None: ...
    async def remove(self, model_id: str) -> None: ...
```

Download algorithm:

```text
validate model ID
        ↓
download to *.part
        ↓
stream SHA-256
        ↓
validate digest
        ↓
fsync
        ↓
atomic rename
```

A partially downloaded model is never considered valid.

---

# 52. Model Download Concurrency

Only one model download at a time.

Use backend async lock.

Progress events contain:

```ts
interface ModelDownloadProgress {
    modelId: string;
    bytesReceived: number;
    totalBytes: number | null;
}
```

No polling from frontend.

---

# 53. Runtime Artifact Integrity

Every bundled native artifact SHALL have:

* exact version;
* exact build source;
* SHA-256 checksum;
* license;
* build architecture.

Store metadata in:

```text
THIRD_PARTY_NOTICES.md
defaults/runtime-manifest.json
```

Do not download `latest`.

---

# 54. Settings

```ts
export interface PluginSettings {
    schemaVersion: 1;

    enabled: boolean;

    computeBackend:
        | "auto"
        | "vulkan"
        | "cpu";

    modelId:
        | "tiny"
        | "base"
        | "small";

    language:
        | "system"
        | "auto"
        | string;

    maxRecordingSeconds: number;

    vadEnabled: boolean;

    outputMode:
        | "direct-insert"
        | "clipboard-only";
}
```

Defaults:

```json
{
  "schemaVersion": 1,
  "enabled": true,
  "computeBackend": "auto",
  "modelId": "base",
  "language": "system",
  "maxRecordingSeconds": 60,
  "vadEnabled": true,
  "outputMode": "direct-insert"
}
```

---

# 55. SettingsRepository

Backend owns persistence.

Frontend never writes settings files directly.

Use atomic update:

```text
serialize
    ↓
write temporary file
    ↓
flush
    ↓
rename
```

Unknown fields are rejected or migrated deliberately.

---

# 56. Settings migrations

Each settings format has:

```text
schemaVersion
```

Migration chain:

```python
MIGRATIONS = {
    1: migrate_v1_to_v2,
}
```

Never reinterpret old data silently.

---

# 57. Capability Model

Startup produces a typed capability report.

```ts
export interface RuntimeCapabilities {
    speechRuntimeAvailable: boolean;
    microphoneAvailable: boolean;
    cpuAvailable: boolean;
    vulkanAvailable: boolean;
    modelInstalled: boolean;

    keyboardHookAvailable: boolean;
    clipboardAvailable: boolean;
    nativePasteAvailable: boolean;

    directInsertAvailable: boolean;
}
```

`directInsertAvailable` is:

```ts
clipboardAvailable &&
nativePasteAvailable &&
keyboardHookAvailable
```

No optimistic assumption.

---

# 58. SteamCapabilityProbe

Per Steam session, the probe checks:

1. active Steam window reachable;
2. virtual keyboard manager recognizable;
3. keyboard DOM signature supported;
4. clipboard mechanism usable;
5. native paste mechanism recognized.

Capability detection does not modify user text.

---

# 59. Compatibility Profiles

Do not scatter Steam-version checks throughout code.

Use explicit profile objects.

```ts
export interface SteamKeyboardProfile {
    readonly id: string;

    matches(
        context: SteamDiscoveryContext,
    ): boolean;

    locateMountPoint(
        keyboard: HTMLElement,
    ): HTMLElement | null;

    locatePasteAction(
        keyboard: HTMLElement,
    ): SteamPasteHandle | null;
}
```

Known profiles live under:

```text
src/infrastructure/steam/profiles/
```

A Steam update usually requires adding or changing a profile, not rewriting the application.

---

# 60. No CSS-Class-Only Discovery

Minified Steam CSS class names SHALL NOT be the only locator.

Prefer, in order:

1. stable semantic attributes;
2. element role;
3. accessible label;
4. structural relationship;
5. known profile-specific signature.

Opaque generated class names may be used only as secondary evidence.

---

# 61. Performance Architecture

The performance principle is:

> Do expensive work once; keep hot paths event-driven.

Specifically:

* model loaded once;
* native daemon persistent;
* no Python inference;
* no JS audio processing;
* no frontend audio buffers;
* no periodic keyboard scanning;
* no transcript key loop;
* no repeated process startup for inference runtime;
* no React rerender timer during idle;
* no polling for state where an event stream exists.

---

# 62. Performance Budgets

These are acceptance targets to measure on real Steam Deck hardware.

## UI interaction

Mic press → visual state change:

```text
P95 ≤ 50 ms
```

## Start command

Mic press → recording accepted:

```text
P95 ≤ 100 ms
```

excluding hardware/audio stack anomalies.

## Stop overhead

Button press → inference pipeline begins:

```text
P95 ≤ 100 ms
```

## Bulk insertion overhead

Transcript ready → insertion call completed:

```text
P95 ≤ 50 ms
target
P95 ≤ 100 ms
maximum acceptance threshold
```

No dependency on text length within normal chat-sized payloads.

---

# 63. Transcription Performance Metric

Inference is measured using real-time factor:

```text
RTF =
transcription_time /
audio_duration
```

Release benchmark must record:

* model;
* backend;
* Deck model;
* audio duration;
* RTF;
* peak memory;
* CPU;
* GPU.

No unverified fixed latency shall be advertised.

---

# 64. Idle Performance

When disabled:

* native daemon absent;
* no audio stream;
* no timer polling.

When enabled and model warm:

Target:

```text
average idle CPU ≤ 1%
```

over a representative measurement window.

There must be no continuously busy worker.

---

# 65. Memory Policy

Performance mode keeps the model loaded.

The plugin does not automatically unload it after each utterance.

Model changes perform:

```text
stop runtime
unload old model
start runtime with new model
health check
ready
```

---

# 66. Frontend Rendering Performance

Application state subscriptions SHALL update only consumers of relevant state.

Do not place the entire plugin tree behind a high-frequency mutable global context.

The microphone button rerenders only on meaningful state changes.

No animation loop is required.

---

# 67. Backend Event Protocol

All cross-boundary payloads must be JSON-compatible and versioned where necessary.

Example:

```ts
interface TranscriptReadyPayload {
    protocolVersion: 1;
    sessionId: string;
    text: string;

    metrics: {
        audioDurationMs: number;
        transcriptionDurationMs: number;
        modelId: string;
        computeBackend: "cpu" | "vulkan";
    };
}
```

Metrics contain no spoken content beyond the transcript already delivered locally.

---

# 68. Error Types

Use stable error codes.

Examples:

```text
STEAM_KEYBOARD_NOT_FOUND
STEAM_PROFILE_UNSUPPORTED
PASTE_ACTION_UNAVAILABLE
CLIPBOARD_WRITE_FAILED

MICROPHONE_UNAVAILABLE
RUNTIME_START_FAILED
RUNTIME_CRASHED
RECORDING_START_FAILED
RECORDING_STOP_FAILED
TRANSCRIPTION_FAILED
TRANSCRIPTION_TIMEOUT

MODEL_NOT_INSTALLED
MODEL_DOWNLOAD_FAILED
MODEL_CHECKSUM_FAILED

SESSION_CONFLICT
STALE_SESSION
KEYBOARD_CONTEXT_CHANGED
```

UI text is mapped from codes.

Do not parse arbitrary exception strings in frontend logic.

---

# 69. Error Recovery

Recoverable error:

```text
show state
    ↓
cleanup active session
    ↓
return to ready
```

Fatal runtime error:

```text
error
    ↓
explicit restart runtime action
```

The supervisor may restart a crashed idle daemon according to a bounded documented policy.

It MUST NOT automatically retry a transcription whose success is unknown.

That could duplicate text.

---

# 70. Runtime Restart Policy

Automatic daemon recovery:

```text
maximum 3 attempts
bounded exponential delay
```

Only when no active transcript insertion is pending.

After threshold:

```text
runtime unavailable
```

until user explicitly restarts it.

---

# 71. Timeouts

Every cross-process operation has a timeout.

Examples:

```text
record start acknowledgement: 2 s
record stop acknowledgement: 2 s
final transcription: bounded by max recording/model policy
daemon shutdown: 5 s
```

No unresolved Promise/Future waits forever.

---

# 72. Cancellation

Cancel operation is first-class.

```ts
speech.cancelRecording(sessionId)
```

Cancellation:

* stops microphone capture;
* discards result;
* removes active session;
* emits no transcript;
* does not modify clipboard;
* does not insert text.

---

# 73. Privacy

The following data MUST NOT be persisted:

* microphone audio;
* normal transcripts;
* target field contents.

Diagnostic logs may contain:

* timestamps;
* state changes;
* duration;
* exit codes;
* model name;
* backend;
* non-sensitive error codes.

Never:

```text
Transcript: "..."
Audio bytes: ...
```

---

# 74. Telemetry

v1 has no remote telemetry.

Local diagnostics may expose counters.

Example:

```text
recordings started
recordings completed
runtime crashes
average transcription duration
last error code
```

Counters remain on the device.

---

# 75. Microphone Indicator Integrity

The microphone button MUST display active state only after recording start has been acknowledged.

Likewise recording state ends only after stop has been accepted.

Avoid lying to the user about microphone state.

---

# 76. Maximum Recording Duration

At configured maximum:

```text
recording
    ↓ timeout
automatic stop recording
    ↓
transcribe
```

The UI communicates that the maximum length was reached.

This automatic stop does not submit the resulting text.

---

# 77. Empty Speech

If transcription yields empty text:

```text
transcribing
    ↓
ready
```

No clipboard write.

No paste.

No error unless runtime reported one.

Optional UI message:

```text
No speech detected
```

---

# 78. Text Validation

Before insertion:

```ts
function validateTranscript(text: string): string {
    const normalized = text.trim();

    if (normalized.length === 0) {
        throw new EmptyTranscriptError();
    }

    if (normalized.includes("\0")) {
        throw new InvalidTranscriptError();
    }

    if (
        new TextEncoder()
            .encode(normalized)
            .byteLength > 16 * 1024
    ) {
        throw new TranscriptTooLargeError();
    }

    return normalized;
}
```

No character escaping should alter valid Unicode text.

---

# 79. Clipboard Behaviour

In direct-insert mode, the transcript may remain in clipboard after insertion.

v1 does not attempt clipboard restoration by default.

Reason:

Clipboard restoration adds another asynchronous operation and can race with user clipboard activity.

Future clipboard restoration must be explicitly enabled and transactional.

---

# 80. Settings UI

Settings screen contains:

### Runtime

* Enable plugin
* Compute backend
* Runtime health

### Speech

* Model
* Language
* Microphone
* Maximum duration
* VAD

### Output

* Direct Insert
* Clipboard Only

### Diagnostics

* Steam keyboard detected
* Paste capability
* Clipboard capability
* Runtime version
* Model
* Compute backend
* Last runtime error
* Benchmark button

---

# 81. No controller shortcut required

The principal product path is microphone-button-driven.

Controller PTT is not required for v1.

This avoids:

* Steam Input conflicts;
* accidental activation;
* duplicate interaction models.

It can be added independently later.

---

# 82. Startup Lifecycle

```text
Decky loads plugin
        ↓
build composition root
        ↓
load settings
        ↓
initialize backend
        ↓
verify runtime
        ↓
start native daemon if enabled
        ↓
load model
        ↓
install Steam keyboard lifecycle hook
        ↓
ready
```

Keyboard hook installation MUST NOT wait for model loading.

Steam UI remains responsive.

---

# 83. Plugin Unload Lifecycle

```text
mark controller shutting down
        ↓
reject new microphone presses
        ↓
cancel active recording
        ↓
unmount mic UI
        ↓
restore Steam hooks
        ↓
unsubscribe backend events
        ↓
stop status monitor
        ↓
stop native daemon
        ↓
dispose resources
```

Every cleanup operation is idempotent.

---

# 84. PluginCompositionRoot ownership

Composition root owns all disposables.

```ts
class PluginCompositionRoot
    implements Disposable {

    private readonly resources:
        Disposable[] = [];

    async start(): Promise<void>;

    async dispose(): Promise<void>;
}
```

Dispose in reverse construction order.

---

# 85. Shared Disposable contract

```ts
export interface Disposable {
    dispose():
        void | Promise<void>;
}
```

No anonymous event listener may be registered without a corresponding disposable owner.

---

# 86. Logging

Use structured categories.

Examples:

```text
plugin.lifecycle
steam.keyboard
steam.capability
dictation.session
speech.runtime
speech.model
output.paste
```

Development log:

```text
[steam.keyboard]
keyboard mounted context=abc123
```

Never include transcript text.

---

# 87. Frontend Testing

Use unit tests for:

* all state transitions;
* forbidden transitions;
* stale session handling;
* keyboard-context changes;
* duplicate button presses;
* cancel during recording;
* cancel during transcription;
* insertion failures;
* empty transcript;
* maximum text size.

Infrastructure tests use mocks/fakes.

---

# 88. Pure State Machine Test Example

```ts
it(
    "transitions recording to stopping",
    () => {
        const result = transition(
            recordingState,
            {
                type: "MICROPHONE_PRESSED",
            },
        );

        expect(result.state.kind)
            .toBe("stopping");
    },
);
```

---

# 89. Steam Adapter Contract Tests

Fixtures SHALL model known Steam keyboard DOM structures.

Tests verify:

* detection;
* microphone mount;
* no destruction of Steam nodes;
* paste action discovery;
* proper cleanup;
* unsupported structure returns unsupported capability.

No guess-and-continue behavior.

---

# 90. Backend Unit Tests

Use `pytest`.

Test:

* session locking;
* stale session;
* process crash;
* timeout;
* cancellation;
* malformed native status;
* missing model;
* corrupt model;
* checksum mismatch;
* settings migration;
* daemon shutdown;
* orphan prevention.

---

# 91. Fake Speech Runtime

Backend tests use a deterministic fake.

```python
class FakeSpeechRuntime:
    async def start_recording(self):
        ...

    async def stop_recording(self):
        ...

    def emit_transcript(self, text: str):
        ...
```

Tests do not require microphone hardware.

---

# 92. Native Runtime Integration Tests

CI integration tests use:

* bundled runtime where architecture permits;
* fixed WAV fixture;
* known model fixture or lightweight test model;
* expected non-empty transcription.

Large model downloads are not required for every unit-test run.

---

# 93. Hardware Test Suite

A dedicated checklist runs on real Deck hardware.

Required devices:

```text
Steam Deck LCD
Steam Deck OLED
```

Required channels:

```text
Steam Stable
Steam Beta
```

Required target categories:

```text
Steam search
Steam chat
native Linux app
XWayland app
Proton app/game
```

---

# 94. Bulk Insertion Test Matrix

For every target:

```text
"hello"
"hello world"
"Grüße aus München"
"äöü ÄÖÜ ß"
punctuation
128 characters
1024 characters
4096 characters
```

Verify:

* complete string inserted;
* correct order;
* no missing characters;
* no duplicated characters;
* Unicode intact;
* no Enter;
* exactly one semantic paste/text operation;
* insertion duration independent of character count within tolerance.

---

# 95. Focus-Race Tests

Test:

### Case A

```text
start recording
close keyboard
stop recording
```

Expected:

```text
no insertion
```

### Case B

```text
stop recording
transcription running
close keyboard
open another field
```

Expected:

```text
no insertion into second field
```

### Case C

```text
transcription ready
same keyboard context
```

Expected:

```text
one insertion
```

---

# 96. Performance Benchmark Suite

Record:

```text
device
SteamOS version
Steam client channel
plugin commit
runtime version
model
backend
audio duration
transcription duration
RTF
insertion duration
peak RSS
CPU usage
GPU usage
```

Store benchmark results under:

```text
docs/performance/
```

No subjective „fast enough“ acceptance.

---

# 97. CI Pipeline

Required checks:

```text
frontend formatting
frontend lint
TypeScript strict compile
frontend unit tests

Python formatting
Python lint
Python type checking
backend unit tests

contract tests
artifact manifest validation
third-party license validation
package build
package structure validation
```

No release artifact if any required gate fails.

---

# 98. TypeScript Rules

`tsconfig`:

```text
strict = true
noImplicitAny = true
noUncheckedIndexedAccess = true
exactOptionalPropertyTypes = true
```

Avoid:

```ts
any
```

except where unavoidable at the Steam private-API boundary.

Such uses must remain inside:

```text
infrastructure/steam
```

and be converted immediately into typed internal representations.

---

# 99. Boundary Validation

Unknown data crossing from Steam internals or backend JSON must be validated.

Do not cast arbitrary objects:

```ts
const x = payload as TranscriptReadyPayload;
```

without validation.

Use small manual type guards or a lightweight schema library.

---

# 100. Python Rules

Python backend:

* Python 3.11 target;
* complete public type annotations;
* Ruff;
* mypy or equivalent static checking;
* `asyncio` for process/lifecycle coordination;
* blocking file/network operations moved from event loop where necessary.

No large dependency framework.

---

# 101. Dependency Policy

Dependencies are accepted only if they provide real value.

Avoid:

* Redux for a tiny finite-state workflow;
* dependency injection frameworks;
* RxJS unless event complexity later justifies it;
* general-purpose Python web frameworks;
* embedded databases;
* Electron;
* extra background services.

---

# 102. Application State Subscription

The controller exposes:

```ts
export interface StateStore<T> {
    getSnapshot(): T;

    subscribe(
        listener: () => void,
    ): () => void;
}
```

React can consume this through `useSyncExternalStore`.

This avoids making React itself the source of truth.

---

# 103. Steam Internal Type Boundary

`SteamInternalTypes.ts` contains only minimal types that have actually been observed and are required.

Do not reproduce huge private Steam type trees.

Example:

```ts
export interface SteamVirtualKeyboardManager {
    SetVirtualKeyboardVisible:
        (...args: unknown[]) => unknown;

    SetVirtualKeyboardHidden:
        (...args: unknown[]) => unknown;
}
```

Every optional/private member is capability-checked before use.

---

# 104. No blind monkey patching

Before patching:

```text
object exists?
method exists?
method is callable?
profile recognized?
plugin not already patched?
```

If not:

```text
keyboardHookAvailable = false
```

Do not mutate unknown structures.

---

# 105. Steam Update Resilience

When an unsupported Steam build breaks the adapter:

* Decky must remain stable;
* Steam keyboard must remain functional;
* microphone button simply does not appear;
* plugin panel shows compatibility error;
* backend daemon may stay available for diagnostics/clipboard mode.

Failure of plugin integration must never break Steam's own keyboard.

---

# 106. Exception Containment

Every Steam callback boundary is protected.

Example:

```ts
try {
    handleKeyboardOpened();
} catch (error) {
    logger.error(
        "steam.keyboard",
        error,
    );
}
```

An exception may disable the plugin integration but must not propagate into Steam UI lifecycle code.

---

# 107. Accessibility

Microphone control must expose:

```text
role=button
accessible name
pressed/recording state
disabled state
```

Visual state cannot rely only on color.

---

# 108. Internationalization

All user-visible frontend text is localized through a translation dictionary.

No strings buried inside application services.

Initial languages:

```text
English
German
```

Architecture must permit additional languages without code changes.

---

# 109. Security

The plugin MUST:

* avoid shell execution;
* validate model IDs;
* checksum external model artifacts;
* pin native runtime;
* restrict writable paths to Decky/plugin data directories;
* reject path traversal;
* never execute downloaded arbitrary binaries;
* sanitize diagnostic display;
* limit transcript payload size.

---

# 110. File Permissions

Runtime-created files should use user-only permissions where appropriate.

Transient transcript file is:

* owned by Deck user/runtime;
* overwritten per session;
* removed on clean shutdown where practical.

No persistent audio file.

---

# 111. Build Reproducibility

Commit:

```text
pnpm-lock.yaml
runtime manifest
model manifest
exact tool configuration
```

Release CI records:

```text
source commit SHA
runtime binary SHA-256
package SHA-256
```

---

# 112. Packaging

Resulting Decky plugin contains approximately:

```text
dist/index.js
main.py
backend/
bin/
defaults/
plugin.json
package.json
LICENSE
THIRD_PARTY_NOTICES.md
```

Native runtime binaries are packaged intentionally rather than relying on host-installed packages.

---

# 113. Plugin privileges

Initial product target:

```text
no root flag
```

Audio/STT architecture must work unprivileged.

If the verified bulk-insertion implementation unexpectedly requires elevated access, this becomes an explicit architecture review decision.

Root must not be added merely because another plugin uses it.

---

# 114. Explicit Non-Goals for v1

v1 does not include:

* cloud STT;
* LLM correction;
* automatic translation;
* automatic Enter;
* game-specific slash commands;
* WoW-specific routing;
* voice commands;
* continuous listening;
* wake word;
* controller PTT;
* live partial transcription;
* character-by-character text typing.

---

# 115. Phase 0 — Architecture Validation

Before full implementation, implement isolated technical spikes.

## Spike A — Steam keyboard mounting

Prove:

```text
detect keyboard
mount mic button
unmount cleanly
repeat 100 times
```

without damaging keyboard behavior.

## Spike B — Bulk insertion

Prove one complete Unicode string can be inserted through one semantic operation.

This is the primary release-risk spike.

## Spike C — STT runtime

Prove:

```text
start daemon
warm multilingual base model
record mic
stop
receive transcript
```

in Game Mode.

## Spike D — Vulkan

Benchmark Vulkan against CPU on LCD and OLED.

No architecture assumption is finalized from theoretical capability alone.

---

# 116. Phase-0 Exit Gate

Full product implementation proceeds only if:

```text
A PASS
B PASS
C PASS
```

Vulkan may fail without blocking the product because CPU is an explicit supported compute backend.

Bulk insertion failure blocks Direct Insert v1.

---

# 117. Phase 1 — Domain and Contracts

Implement:

* domain objects;
* state machine;
* ports;
* controller;
* fake adapters;
* exhaustive unit tests.

No Steam-specific code required.

---

# 118. Phase 2 — Native Runtime Integration

Implement:

* Python backend facade;
* process supervisor;
* runtime client;
* status monitor;
* session correlation;
* model store;
* settings repository;
* Decky events.

Validate STT end-to-end independently of keyboard integration.

---

# 119. Phase 3 — Steam Integration

Implement:

* keyboard lifecycle hook;
* DOM locator;
* profile system;
* microphone mount;
* context tracking;
* capability probe.

No speech-specific code inside adapter.

---

# 120. Phase 4 — Bulk Insertion

Implement the Phase-0-proven bulk insertion mechanism behind:

```text
ClipboardPort
PasteActionPort
BulkTextInserter
```

Run full compatibility matrix.

---

# 121. Phase 5 — Production Hardening

Complete:

* failure containment;
* Steam update handling;
* localization;
* model download UX;
* diagnostics;
* memory measurements;
* CPU/GPU benchmarks;
* LCD/OLED matrix;
* Stable/Beta matrix;
* package validation;
* third-party notices.

---

# 122. Acceptance Criteria — Core Flow

Given:

```text
Steam virtual keyboard visible
runtime ready
model loaded
```

When user:

```text
presses microphone
speaks
presses microphone again
```

Then:

```text
recording starts
recording stops
final transcript is generated locally
same keyboard context is verified
full transcript is inserted in one bulk action
keyboard remains open
text is not submitted
```

---

# 123. Acceptance Criteria — Performance

The implementation must demonstrate:

* responsive mic state;
* no visible UI freeze;
* no per-character insertion delay;
* no repeated model loading;
* no continuous high-frequency polling;
* no unnecessary native process creation on idle;
* no meaningful idle CPU burn;
* deterministic insertion latency independent of transcript length.

---

# 124. Acceptance Criteria — Correctness

Must pass:

```text
German
English
mixed punctuation
Unicode
rapid repeated sessions
keyboard close during recording
keyboard close during transcription
runtime crash
model change
backend change
plugin unload
Steam UI reload
```

---

# 125. Acceptance Criteria — Safety

Must prove:

* no transcript inserted into a new target after focus/context change;
* no duplicate transcript;
* no delayed stale insertion;
* no automatic Enter;
* no microphone capture after cancellation;
* no orphan speech daemon;
* no audio persistence;
* no transcript logs.

---

# 126. Architectural Decision Records

The repository must maintain ADRs.

Initial ADRs:

```text
ADR-001 Hexagonal architecture
ADR-002 Native persistent STT daemon
ADR-003 Voxtype as replaceable runtime adapter
ADR-004 Final-only transcription
ADR-005 Bulk insertion only
ADR-006 Steam internals isolated behind ACL
ADR-007 Session and keyboard-context correlation
ADR-008 Rootless target architecture
ADR-009 No remote telemetry
ADR-010 Explicit compute backend policy
```

Architecture changes require new ADRs instead of silently rewriting assumptions.

---

# 127. Quality Gates

A change may not merge when it:

* leaks Steam internals outside adapter package;
* adds character-by-character transcript insertion;
* adds an implicit fallback;
* accesses microphone outside session lifecycle;
* logs transcript content;
* bypasses session correlation;
* introduces unbounded polling;
* adds `shell=True`;
* adds unmanaged event listeners;
* adds global mutable application state;
* breaks cleanup idempotency.

---

# 128. Final Architectural Invariants

These invariants define the product.

### Invariant 1

There is at most one active dictation session.

### Invariant 2

A session belongs to exactly one Steam keyboard context.

### Invariant 3

A transcript may only be inserted into its originating context.

### Invariant 4

A transcript is inserted as one complete payload.

### Invariant 5

No transcript is automatically submitted.

### Invariant 6

Speech recognition runs locally.

### Invariant 7

Steam-private structures are confined to one anti-corruption layer.

### Invariant 8

The native model remains warm during enabled operation.

### Invariant 9

Backend and native process failures cannot break Steam's keyboard.

### Invariant 10

Every hook, listener, task, child process and mounted UI root has an explicit owner and deterministic cleanup.

---

# 129. Definition of Done

Version 1.0 is finished only when all of the following are true:

* microphone control integrates into Steam keyboard;
* integration survives repeated open/close cycles;
* local multilingual speech recognition works;
* base model works on CPU;
* Vulkan works when explicitly supported and selected;
* model remains warm;
* final transcript appears only after stop;
* transcript is inserted as one bulk payload;
* no character typing implementation exists in production path;
* no automatic Enter occurs;
* context-race tests pass;
* LCD validation passes;
* OLED validation passes;
* Steam Stable validation passes;
* Steam Beta validation passes;
* target compatibility matrix passes;
* idle resource budgets pass;
* insertion latency budget passes;
* runtime crash recovery passes;
* unload leaves no hooks/processes;
* privacy requirements pass;
* third-party licenses are complete;
* CI is green;
* release artifact is reproducible and checksummed.

Only at that point is Direct Insert considered production-ready.

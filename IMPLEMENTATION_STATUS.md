# IMPLEMENTATION_STATUS

## v0.2.0 — owner-designed product pivot: QAM dictation card (big mic button + live level strip) → local transcript → system clipboard → Steam-keyboard Paste

### The v0.2 flow (owner design)

The plugin panel now LEADS with a dictation card: a BIG microphone button, a
live 24-bar level strip while recording, and — after stop — the transcript
preview with its clipboard status and a "copy again" action. The deliverable
is the SYSTEM clipboard: the user copies, opens the Steam virtual keyboard
(STEAM+X), and presses the keyboard's own Paste key into any text field
(primary target: the Steam Chat input). The keyboard-injection path (v0.1.7
tab-bridge) stays in the codebase unchanged and remains honestly degraded:
its native overlay surface is still unreachable on device, and the v0.2 flow
does not depend on it.

### Live audio levels — the daemon's own surface (audio.sock)

Discovery (research lane, source-verified at the pinned tag): voxtype v1.0.1
broadcasts audio levels unconditionally while the daemon runs —
`src/audio/levels.rs`: 10 ms windows at 100 Hz, one 16-byte frame per window
over `$XDG_RUNTIME_DIR/voxtype/audio.sock`,
`#[repr(C)] struct AudioFrame { seq: u32, min: f32, max: f32, peak_dbfs: f32 }`,
per-field native byte order, no handshake, multiple subscribers, slow
consumers dropped after a 300 ms queue. Only the OSD child process is config-
gated; the socket is NOT (daemon.rs:2710-2725), so no daemon.toml change was
needed. Our socket path is `<data_dir>/runtime/voxtype/audio.sock`
(`PluginPaths.audio_socket`; children get `XDG_RUNTIME_DIR` pointed there).

- `backend/infrastructure/process/level_frames.py` — the verified wire
  parser with sanity validation (finite values, min ≤ max within ±1,
  peak_dbfs within the documented −120 dBFS clamp). Wrong byte order,
  truncation and corruption are dropped and counted, never rendered.
- `backend/infrastructure/process/level_socket_client.py` — asyncio client
  coalescing frames into additive `recording_level` event vectors at 15 Hz
  (`{protocolVersion: 1, kind: "recording_level", seq, frames: [[min, max,
peakDbfs] × k]}`, k = 6–8, ≈ 300 B/event) with bounded-backoff reconnect
  (hub respawn / slow-consumer drop, upstream issue #391) and full §106
  containment. §61 gate: started ONLY after an acknowledged recording start
  and stopped on stop/cancel/disable/dispose/runtime loss (composed
  `on_unexpected_exit`). This is a live LEVEL meter — the envelope of
  exactly the audio whisper hears — not an FFT; product copy says "level",
  never "spectrum".
- Frontend: `LevelMeterStore` (24-bar rolling window, one bar per frame,
  amplitude = max(|min|, |max|)) fed by a §99-guarded adapter subscription;
  transport-level UI state, never part of the §8 dictation machine.

### Clipboard strategy (transcript → system clipboard)

- PRIMARY (frontend): `PanelClipboard.copyTextToClipboard` — the
  SharedJSContext `execCommand('copy')` pattern proven shipped by the
  snippets plugin (hidden input + focus + select + copy;
  `navigator.clipboard.writeText` fallback). The dictation card runs it
  automatically when the backend leg did not already copy, reports the
  outcome, and offers "copy again".
- SECONDARY (backend): `XclipClipboardWriter` — `bin/xclip -selection
clipboard -t text/plain -i <staging file>` with DISPLAY read from
  `/run/user/1000/gamescope-environment` (fallback `:0`) and
  XAUTHORITY `/home/deck/.Xauthority` when present (DeckyClipboard
  pattern; no sudo needed — the loader already drops the plugin to the
  host user). Argument array only, bounded timeout, staging file under
  `<data_dir>/runtime` with 0600, transcript text never logged (§73).
  **Pin decision (owner fork, resolved): NO `remote_binary` entry was
  added.** Upstream xclip (astrand/xclip) publishes no prebuilt release
  binaries; the only bundled binary in the audited ecosystem is an
  unofficial third-party build (DeckyClipboard `bin/xclip`, sha256
  `1a757a1ae88441c9fc6101c0750d86a1afb5cb7b2073a0ed98967c41dc292d20` at
  its sole tag 7c5c970) behind a raw repository URL — not a trustworthy
  pinned source for an executed artifact, and inventing or adopting that
  pin was explicitly out of bounds. The writer is fully implemented and
  activates automatically when `bin/xclip` exists; until then the backend
  leg reports `clipboard: "skipped"` and the frontend copy is primary.
- `transcript_ready` (frozen core unchanged) gained the ADDITIVE optional
  field `clipboard: "ok" | "failed" | "skipped"`; `get_status` gained the
  additive `dictationFlow.clipboard` diagnostics fact. Older frontends/
  backends ignore both (§99 guards updated).

### Panel press path (additive, semantics preserved)

`DictationController.handlePanelMicrophonePressed()` is a second entry into
the SAME serialized press path (§10 mutex, §8 state machine, §11 stale
protection). With no keyboard context it starts a clipboard-flow session
(`keyboardContextId: null`): the §12 suppression retains the transcript for
the panel (never inserted), and a keyboard appearing/closing can never
switch or cancel the session. The keyboard-mount press semantics are
byte-for-byte unchanged (a context-less keyboard press is still ignored).

### Diagnostics

The Diagnostics section gained the additive "Dictation flow" row (backend
running / clipboard state) fed by the guarded `dictationFlow` status field.

### Live-verify on device (offline validation limit)

- The Steam keyboard's Paste key reading the copy written by the panel CEF
  (`execCommand`) — expected to work per shipped-plugin evidence, but a
  2023 gamescope regression (#916) shows this must be live-verified.
- End-to-end QAM flow latency (panel over the OSK, keyboard context
  lifecycle during QAM use).
- The backend xclip leg stays "skipped" until a trustworthy pinned binary
  exists or one is installed manually.

### Suite delta

Backend 157 → 183 tests (level parser against recorded fixtures incl. the
guarded byte-swapped stream, level client coalescing/cadence/reconnect/
containment/restart defect, clipboard status mapping incl. timeout/empty-
speech, full-pipeline §61 gate). Frontend 271 → 301 tests (guards, stores,
adapter subscriptions, panel press flow, DictationCard, visual harness
dictation states). No existing test weakened; one pre-existing accidental
60 s wait in the transcription-timeout test shrunk to the identical
assertion at a 2 s budget.

On-device fix (2026-09-18): the §99 `get_status` guard required a
`dictationFlow.backendRunning` boolean the shipped backend never emits (its
v0.2 dictationFlow is clipboard-only), so every real payload was dropped
("dropped get_status payload: boundary guard failed") and the panel lost its
status feed; the field is now additive-optional, the Diagnostics row derives
running/stopped from the same report's `runtime.running`, and the captured
real payload is pinned in `tests/fixtures/status/get_status_real.json`
(frontend suite 301 → 302).

v0.2.1 diagnosability fix (2026-09-18): `Plugin._call` (single choke point)
now logs every failed callable at WARNING with the callable name, the stable
§68 code and the session id when present (no transcript/payload text, §73;
successes stay quiet), and the DictationCard error state renders the §68 code
chip plus the translated message inline (same chip as the setup-failed row)
instead of only the generic mic label — one press + one journal read now
names the exact code and layer (backend suite 183 → 184, frontend 302 → 303).

## v0.1.8 — on-device mount fix: the CEF keyboard container reports `offsetWidth` 0 while visible, so the bootstrap trusts the `VirtualKeyboardVisible` class token alone and the 250 ms poll re-runs `window.__stdKbEvaluate` as the §61 self-heal

## v0.1.7 — tab-bridge keyboard architecture (replaces the dead registry-mount)

### Architecture

The Big Picture virtual keyboard lives in the CDP target titled exactly
`"Steam Big Picture Mode"` — a document the plugin's own context cannot see.
v0.1.7 replaces the dead v0.1.6 registry-mount with the tab-bridge: the
microphone button is created and driven INSIDE the keyboard document by a
persistent in-window bootstrap, and presses/transcripts flow through a small
poll into the EXISTING DictationController pipeline. This path needs NO
"Allow Remote CEF Debugging".

```
[SP keyboard document]                     [plugin frontend]
  bootstrap (self-installing)                KeyboardTabBridge (engine)
  - MutationObserver + std-mic-host  <---->  - executeInTab inject (30s cadence)
  - press events (__stdMicEvents)   ------>  - 250 ms poll (visibility/presses/facts)
  - __stdMicInsert / __stdMicPaste  <------  - one-payload insert, §24 fallback paste
  - __stdMicState (§75 visuals)     <------  - MicrophoneControlPresenter mapping
        |                                          |
        └────────────── executeInTab ──────────────┘
        (loader official API, no CDP flag)
```

New/changed modules (all owned paths):

- `src/infrastructure/steam/keyboardBridgeBootstrap.ts` — string-building
  module: the self-installing IIFE source (idempotent via
  `window.__stdKbBridgeLoaded`; observer + `std-mic-host` button + focus
  capture + capped press queue + `__stdMicInsert`/`__stdMicPaste`/
  `__stdMicState`/`__stdMicTeardown`) and the poll/insert/state/teardown
  expression builders.
- `src/infrastructure/steam/KeyboardTabBridge.ts` — the engine: bounded
  re-injection, 250 ms poll (only while enabled), strict payload boundary
  guard (§99), context lifecycle from visibility (§7.2), press draining,
  one-payload insertion, §75 state pushes, observed capability facts (§57),
  bounded exponential backoff (§61/§106).
- `src/infrastructure/steam/KeyboardTabBridgeHostAdapter.ts` — the
  `KeyboardHostPort` the controller/presenter/lifecycle consume; forwards
  keyboard lifecycle as port events, maps §75-true visuals onto
  `__stdMicState`, exposes §58-shaped and tab-bridge diagnostics.
- `src/infrastructure/steam/KeyboardBridgeInserter.ts` — composite inserter:
  one-payload bridge insert PRIMARY; the §24 clipboard+single-paste
  transaction as FALLBACK only when the bridge declines (below).
- `src/infrastructure/steam/TabBridgePasteActionAdapter.ts` — makes the §24
  fallback real in this architecture: the single native paste is invoked
  inside the keyboard document (`__stdMicPaste`, execCommand("paste") with
  the loader's userGesture), after the plugin-context clipboard write.
- `src/infrastructure/decky/DeckyApiTransport.ts` — added
  `createDeckyTabExecutor()` (the only module importing `executeInTab` from
  `@decky/api`, matching the existing side-effect boundary rule).
- `src/index.tsx` — composition root rewired to the tab-bridge stack; the
  v0.1.6 registry-mount adapter is no longer wired (its classes and contract
  tests remain untouched for the record).
- `src/application/ports/KeyboardHostPort.ts` — additive (§99):
  `MicrophoneControlVisualState` + optional `visual` prop,
  `TabBridgeDiagnostics`.
- `src/presentation/settings/DiagnosticsPanel.tsx` +
  `src/presentation/i18n/messages.ts` — new rows: tab bridge injected /
  keyboard view seen / press channel live (+ stable degrade reasons), EN+DE
  parity enforced by the compiler and the i18n parity test.

Pipeline semantics (unchanged code, Task 3): presses enter through
`DictationController.handleMicrophonePressed()` — the same entry the local
button uses — so §10 mutex serialization, §11 stale protection and the §8
machine are authoritative. Poll `v:false` mid-transcription closes the bridge
context; the transcript is suppressed and retained for the panel (§12).
Visual state is pushed only after the corresponding acknowledgement (§75).

### TASK 0 gate — `executeInTab` IS callable from the sandboxed plugin frontend: VERIFIED

The plugin (api_version 1) has a first-class, typed access path to the loader's
`executeInTab`. Evidence chain, verified from the installed dependency and the
audited loader sources:

1. `node_modules/@decky/api@1.1.3` `dist/index.d.ts` (line 17-20) declares
   `executeInTab(tab: string, runAsync: boolean, code: string) => Promise<{success: boolean; result: any}>`
   as a top-level export, alongside `injectCssIntoTab` / `removeCssFromTab`.
   `dist/index.js` (line 30) wires it at runtime:
   `export const executeInTab = api.executeInTab;` where `api` comes from
   `window.__DECKY_SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED_deckyLoaderAPIInit
.connect(API_VERSION, manifest.name)`.
2. Loader frontend `plugin-loader.tsx` (audit clone,
   `.tmp/audit/loader-src/plugin-loader.tsx` line 716-718) puts
   `executeInTab: DeckyBackend.callable<[tab, runAsync, code], {success, result}>('utilities/execute_in_tab')`
   on the per-plugin `backendAPI` returned to `connect` for api versions 1 and
   2 (the legacy v0 API at line 784 exposes the same callable).
3. Loader backend `utilities.py` (line 231-247) implements
   `execute_in_tab(tab, run_async, code)` via `inject_to_tab` → CDP
   `Runtime.evaluate` with `userGesture: true` and `awaitPromise: run_async`.
   In-tab JS exceptions are returned as
   `{success: false, result: exceptionDetails}`; a missing tab title raises
   inside the loader and is caught, also returning `{success: false}`. The
   call therefore RESOLVES instead of rejecting for both failure classes —
   the engine treats `success === false` and transport rejections identically
   as "transport failed" (bounded backoff).
4. Tab lookup is by exact title (`injector.py` `get_tab`); the target is the
   CDP target titled exactly `"Steam Big Picture Mode"` (on-device evidence).

**Gate verdict: PASS** — the tab-bridge is built on the official loader API
with no new frontend dependency. `runAsync` is `false` everywhere.

### v0.1.6 registry path — proven dead end (on-device, kept for the record)

- Enumeration sees 25 window-store instances with the keyboard open;
  `managersFound=0`. The virtual keyboard manager hides itself behind
  getters/prototype indirection; direct property reads fail too.
- Consequence: the v0.1.6 mount path never hooked a lifecycle method and never
  mounted the microphone button; the §58 capability derivation degraded to
  `manager-not-found` permanently.

### §2.2 one-payload compliance reading

Spec §2.2/§22 require the complete transcript to be delivered as ONE payload
with no per-character iteration. The v0.1.7 primary insertion path satisfies
this directly: `window.__stdMicInsert(text)` sets the complete value through
the native value setter taken from the element's prototype chain and dispatches
exactly one bubbled `input` InputEvent (the React-controlled-component-safe
pattern); contenteditable uses one `execCommand("insertText")`. The §24
clipboard-write + single-native-paste transaction is retained unchanged as the
FALLBACK path, used only when the focused-element insertion reports failure
(element gone, not editable, transport failure). No path performs
per-character synthesis; §22 holds on both paths. (§40 is n/a here: no
frontend transcript persistence exists.)

### Capability and diagnostics honesty (§57/§58/§105)

`keyboardHookAvailable` is now derived from OBSERVED bridge facts: transport
round trip proven, in-window `__stdKbBridgeLoaded` flag read back by the poll,
and the permanently-present keyboard container seen at least once since start.
All three settle within the first poll cycle that `start()` awaits (bounded),
so the startup capability report is built on evidence, not assumption. Stable
degrade reasons: `sp-target-not-found`, `bridge-not-injected`,
`signature-not-found`.

### Known boundaries / on-device open points (offline validation limit)

- The §24 fallback's `queryCommandSupported('paste')` probe and execCommand
  paste behavior inside CEF are implemented per the loader's userGesture
  evaluation but are only provable on device; offline tests cover the
  fail-closed mapping.
- The bootstrap's contenteditable branch (`execCommand("insertText")`) and
  fixed-position math cannot be rendered in jsdom; the input/textarea
  one-payload path is fully tested.
- Suite delta: 223 → 271 tests (48 new decision-point tests, owner-approved
  Task 5 coverage; no existing test weakened or removed).

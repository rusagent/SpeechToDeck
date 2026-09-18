# IMPLEMENTATION_STATUS

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

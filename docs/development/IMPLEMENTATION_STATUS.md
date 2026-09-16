# Implementation Status

Current repository state after the integration pass over the merged tree
(main: scaffold + frontend core + python backend + steam/UI layers). The canon
is docs/spec/spec-v1.0.md; the phase plan is §115-§121. All gate evidence below
is from a single validation run of this integration lane on the merged tree.

## What exists today

- Frontend core (`src/domain`, `src/application`): dictation state machine,
  controller, ports, lifecycle (merged at `bc73bec`).
- Python backend (`backend/`, `main.py`): composition root, daemon supervisor
  over the pinned-runtime CLI, inotify status monitor, model store, settings
  repository, real-subprocess supervision tests (merged at `797fa45`).
- Steam ACL / Decky adapters / presentation (`src/infrastructure`,
  `src/presentation`, `src/index.tsx`): keyboard profiles, capability probe,
  clipboard/paste adapters, Decky transport/adapters, microphone button and
  settings UI, contract tests (merged at `1b5e3ae`).
- Tooling hubs: `package.json` (+ pinned lockfile), §98-strict `tsconfig.json`,
  `vitest.config.ts`, `rollup.config.mjs` (esbuild TSX transform),
  `pyproject.toml`, `plugin.json` (§113), ESLint/Prettier, CI (§97).
- `defaults/models.json`: curated v1 whisper models with real SHA-256 digests.
- `defaults/runtime-manifest.json`: Voxtype artifact schema, deliberately
  **unpinned** (no binary may be invented); see gate policy below.

## Integration seam fixes applied (this pass)

Fixed toward §30/§67/§68/§55/§57; each was a real frontend↔backend mismatch:

1. **Coded-result envelope (§68)** — `main.py` `Plugin._call` returns
   `{"ok": true, ...payload}` / `{"ok": false, "code": ...}` (frozen by backend
   tests), but the frontend ignored the envelope, silently swallowing failures.
   `DeckyBackendClient.call` now unwraps success payloads and throws a
   `DictationError` carrying the stable §68 code on `ok: false`.
2. **`get_capabilities` shape (§57)** — the backend returned context fields
   only; the frontend guard requires the §57 speech-side booleans. The backend
   now reports them conservatively (microphone = runtime availability; CPU is
   the baseline backend; Vulkan only when the daemon reported it;
   `modelInstalled` from the real store query). Hardware probes stay in the
   daemon (§115 Spike C/D).
3. **`runtime_status` payload (§67/§99)** — backend publishes versioned
   `{protocolVersion, state, ...}` dicts with supervisor/daemon state
   vocabularies; the frontend guard expected a bare string and would have
   dropped every real payload. The adapter now maps the versioned payload
   (`starting|idle|recording|transcribing|restarted|crashed|error|stopped|
unavailable|unknown` → `starting|ready|crashed|unavailable`) and still
   accepts the bare-string form; unknown states are dropped (§99).
4. **`speech_error` codes (§68)** — the backend produces `RUNTIME_UNAVAILABLE`,
   `INVALID_SESSION_ID`, `INVALID_TRANSCRIPT`, `SETTINGS_INVALID`,
   `MANIFEST_INVALID`, `INTERNAL_ERROR`; the frontend code list did not contain
   them (guard would drop those payloads). List extended; UI text added for
   both locales (`ERROR_MESSAGES` stays complete over all codes).
5. **`transcript_ready` metrics (§67)** — `computeBackend` could leak `"auto"`
   when the daemon under-reported; §67 freezes the union to `"cpu" | "vulkan"`.
   The backend now prefers the daemon-reported backend, then the explicit
   setting, and resolves `auto` to the baseline `"cpu"`.
6. **Settings update payload (§55)** — the settings adapter sent the full
   document including `schemaVersion`, which the backend rejects
   (backend-owned field). The adapter now sends exactly the client-settable
   fields.

## Review repair (cycle 1, on main @ c278945)

Bounded repair of the three independent-review findings plus two notes; no
scope beyond them. All gates were re-run green on the repaired tree
(§97 gate list; counts below).

1. **F1 — SettingsPanel dead on mount (§102)**: the panel passed the
   controller's unbound `subscribe`/`getSnapshot` class methods to
   `useSyncExternalStore`, so React invoked them with `this === undefined`
   and the plugin panel threw on first mount. Fixed with the same
   bound-closure accessors the microphone-button bridge uses; new render
   test (`tests/contract/SettingsPanel.test.tsx`) proves mount, §80
   sections and store-driven rerender (red against the defect, green after).
2. **F2 — `update_settings` persisted only (§36/§64/§65)**: the §30 callable
   now drives the runtime lifecycle: `enabled=false` stops the runtime in
   the §38 order (stop accepting sessions → cancel recording → stop monitor
   → SIGTERM daemon), `enabled=true` follows the §82 startup path, and a
   runtime-relevant change (the fields the daemon consumes at start: model,
   backend, language, max duration, VAD) triggers exactly one supervised
   restart with the new settings plus health check. Updates are serialized
   by a lifecycle lock and deduplicated (no restart when nothing
   runtime-relevant changed); restart recovery stays inside the §70 policy.
   `start_recording` rejects with the stable §68 `RUNTIME_UNAVAILABLE` code
   while disabled. Backend test extended (fixture daemon; red against the
   pre-repair code).
3. **F3 — layering (§3.1)**: `MicrophoneControlRenderer` moved from the
   Steam adapter into `src/application/ports/KeyboardHostPort.ts`; the §58
   capability-report type now lives in the domain layer
   (`KeyboardCapabilityReport` in `src/domain/Capability.ts`) with
   `SteamCapabilityProbe` implementing it — presentation no longer imports
   infrastructure.
4. **Note a — repeat keyboard appearance**: `SteamKeyboardHostAdapter`
   emits `keyboard-closed` for the stale context when a new appearance
   arrives without an intervening hidden notification (§7.2 context
   semantics; adapter contract test extended).
5. **Note b — `consoleSink`**: the export was unreferenced outside
   `src/shared/Logger.ts`; de-exported (kept as the module-private `Logger`
   default sink, so behavior is unchanged).

Review note (c) (`scripts/validate-package.mjs`) belongs to the release-CI
lane and was intentionally not created here; note (d) (real hardware
capability probes) stays documented under the unproven capabilities below.

## Review repair (cycle 2, on main @ 3146009)

Bounded repair of four reviewer findings; no scope beyond them. All gates
re-run green on the repaired tree (counts in the validation section).

1. **LF1 — lifecycle race fences (§36/§38/§83)**: `Application.start()` and
   `dispose()` now run under the existing `_lifecycle_lock` (previously only
   `update_settings` held it), and `_apply_runtime_lifecycle` checks a
   `_disposed` fence inside the lock. A disable issued during an in-flight
   startup can no longer end with a running daemon against disabled
   settings, and an update in flight during unload can no longer respawn a
   daemon after `dispose()` (no orphan). Two deterministic race tests
   (`tests/backend/test_composition.py`, fixture daemon; both red against
   the pre-fix composition, green after). `restart_runtime` (§69) was left
   as-is per the bounded scope.
2. **LF2 — reproducible packaging (§111)**: `listFilesRecursive`
   (`scripts/build-package.mjs`) sorts the accumulated relPosix paths, so
   zip entry order and the SHA256SUMS.txt digest are filesystem-independent.
   Proven by two full builds into separate `.tmp` dirs: byte-identical zips,
   both `sha256 b04d2e6cd4a0a99b06f79bd90996eb433d957737b283229ed9a946b4738446f0`.
3. **Traversal hardening (§109)**: `resolve_defaults_file` verifies the
   resolved absolute candidate stays inside the plugin root
   (`pathlib.is_relative_to`) and raises the stable §68 `MANIFEST_INVALID`
   error instead of returning an escaping path; both shipped layouts and the
   fail-closed missing-file location are unchanged. Test added
   (`tests/backend/test_defaults_layout.py`).
4. **Visual capture fix (§80/§107)**: the harness page now renders
   unscrolled and reports its section geometry (`data-geometry`);
   `tests/visual/capture.mjs` screenshots the full window and crops the
   exact 410px column with ImageMagick (headless Chromium does not reliably
   honor page-side scroll offsets — the old `scrollIntoView` targeting
   captured the wrong region). `panel-en-diag` clips to the Diagnostics
   section (410x240, all §80 rows visible); the mic-states strip gap widened
   18→36px so the error flash bubble clears the neighboring figcaption
   (measured 12px overlap → 6px clearance). Fresh set in `.tmp/ui-visual/`:
   `panel-en-top` 410x450/13911B, `panel-en-diag` 410x240/8505B,
   `panel-de-top` 410x450/14642B, `mic-states-en` 410x160/3513B,
   `mic-states-de` 410x160/3814B (JPEG q42, 1x, within capture limits).
5. **`wait_until` async predicates (tests/backend/conftest.py)**: an
   awaitable predicate is now awaited — the previously truthy
   never-awaited coroutine made one lifecycle-test wait vacuous and raised
   the benign `RuntimeWarning`. No test semantics weakened (the affected
   assertion now actually polls).

## Store submission prep (lane/store-assets)

- Store assets added: `assets/icon.png` (512x512, drawn with ImageMagick
  primitives; panel-dark background consistent with the visual harness
  tokens) and `assets/screenshot.jpg` (real `SettingsPanel` render, English,
  top sections; captured by `tests/visual/capture.mjs`, 820x900).
- `plugin.json` `publish.image` points at the raw.githubusercontent URL of
  `assets/screenshot.jpg` (store CI POSTs this URL to the store upload
  endpoint; an empty or broken image hard-fails). URL reachability is proven
  only after this lane merges to `main`.
- `docs/development/release.md` testing-channel guidance corrected: this
  plugin ships prebuilt dynamically-linked voxtype binaries, so the db
  template's "Tested on Stable and Beta" line is replaced by third-party
  SteamOS Preview-channel testing (never self-checked).

## Gate policy: unpinned runtime manifest

`node scripts/validate-manifests.mjs` (default, CI):
`models.json` violations and a malformed runtime manifest fail hard; the
intentionally unpinned runtime artifact prints a loud `RUNTIME_UNPINNED`
diagnostic and the run stays **green** (§129 — a permanently red CI gate would
contradict "done" without adding safety, because product code already fails
closed against the unpinned manifest at backend startup with
`RUNTIME_START_FAILED`, covered by tests). `node scripts/validate-manifests.mjs
--strict` (release packaging) fails hard on an unpinned runtime. Rationale and
acquisition procedure: bin/README.md.

## Validation evidence (this run, merged tree)

| Command                                        | Exit | Proves                                                                         |
| ---------------------------------------------- | ---- | ------------------------------------------------------------------------------ |
| `pnpm install`                                 | 0    | node_modules synced with the post-merge lockfile                               |
| `pnpm typecheck`                               | 0    | §97/§98 TypeScript strict compile                                              |
| `pnpm test`                                    | 0    | 168 tests / 17 files (frontend unit + steam/Decky contract suites)             |
| `pnpm lint`                                    | 0    | §97 frontend lint (ESLint flat config)                                         |
| `pnpm build`                                   | 0    | rollup bundle; `dist/index.js` produced                                        |
| `pnpm format:check`                            | 0    | §97 frontend formatting (Prettier, repo-wide)                                  |
| `python -m pytest tests/backend -q`            | 0    | 93 passed (real-subprocess supervision tests; plain pytest, no pytest-asyncio) |
| `ruff check .`                                 | 0    | §97 Python lint (backend, tests, main.py)                                      |
| `python -m mypy`                               | 0    | §97 Python type checking (strict, 21 source files)                             |
| `ruff format --check backend main.py tests`    | 0    | §97 Python formatting                                                          |
| `node scripts/validate-manifests.mjs`          | 0    | models.json valid; unpinned runtime → `RUNTIME_UNPINNED` diagnostic            |
| `node scripts/validate-manifests.mjs --strict` | 1    | intended: fails on the unpinned runtime (release gate)                         |
| `node scripts/validate-licenses.mjs`           | 0    | 4 runtime dependencies covered by THIRD_PARTY_NOTICES.md                       |

Backend environment note: the venv is created with uv (`ruff` + `mypy`) and
needs `uv pip install --python .venv/bin/python pytest aiohttp` for the suite.
On desktop sessions that leak AppImage `LD_LIBRARY_PATH` into child processes,
run the venv python through `env -u LD_LIBRARY_PATH`.

## Capability matrix

Proven by the suites above (offline/fake-path evidence):

- Frontend domain/state machine, controller, lifecycle, protocol guards,
  transcript validation (unit tests, jsdom).
- Steam ACL contracts: keyboard discovery/profiles, capability probe,
  clipboard/paste adapters, bulk insertion, hook registry (contract tests over
  DOM fixtures; not a live Steam session).
- Decky adapter contracts: frozen §30 callable/event names, §67 payload
  guards, §99 boundary dropping, §68 coded envelope (fake transport).
- Backend: composition, session coordination, speech service, daemon
  supervision with a real subprocess fixture daemon, model store, settings
  repository, status monitor (pytest; the fixture daemon is not Voxtype).

Unproven live-path capabilities (hardware/loader-gated; §115 Phase-0 spikes
A-D remain open and the §116 exit gate has not been evaluated):

- Real Steam keyboard hooking against a live `SteamUIStore` (Spike A).
- Real bulk insertion: CEF clipboard write + native paste on target apps (Spike B).
- STT end-to-end with a pinned Voxtype binary on Deck hardware (Spike C),
  including Vulkan/CPU benchmarks (Spike D).
- Real Decky callable/event round-trip through the Decky loader (the loader
  transport is not executable in the development sandbox).
- Runtime artifact pinning: `defaults/runtime-manifest.json` stays unpinned
  until a real Voxtype artifact is acquired (bin/README.md); startup fails
  closed (`RUNTIME_START_FAILED`, tested) against it today.

## Documented transport seam

`main.py` composes the backend with `LoggingEventPublisher` at the
`EventPublisher` port: without a Decky event transport, events are logged with
transcript text redacted (§73) instead of being silently dropped. The real
loader wiring point is the `event_publisher` parameter of
`backend.composition.compose`; the Decky-facing callable transport
(`DeckyApiTransport`) is implemented on the frontend side and imported only by
the composition root.

## Next actions

1. Phase-0 hardware spikes (§115 A-D) on Deck hardware; evaluate the §116 exit
   gate before finalizing any architecture assumption.
2. Acquire and pin the Voxtype runtime artifact (bin/README.md), flip the
   manifest gate to `--strict` for release packaging.
3. Wire the real Decky loader transport for backend events (replace
   `LoggingEventPublisher` at the `compose` seam) and verify one live
   callable/event round-trip through the loader.
4. Packaging lane: `scripts/validate-package.mjs` against §112 (CI job is
   declared and skips until the script exists).

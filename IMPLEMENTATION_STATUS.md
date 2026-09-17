# IMPLEMENTATION_STATUS

## v0.1.7 — tab-bridge keyboard architecture (replaces the dead registry-mount)

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
2. Loader frontend `plugin-loader.tsx` (v0.1.6 audit clone,
   `.tmp/audit/loader-src/plugin-loader.tsx` line 716-718) puts
   `executeInTab: DeckyBackend.callable<[tab, runAsync, code], {success, result}>('utilities/execute_in_tab')`
   on the per-plugin `backendAPI` returned to `connect` for api versions 1 and 2
   (the legacy v0 API at line 784 exposes the same callable).
3. Loader backend `utilities.py` (line 231-247) implements `execute_in_tab(tab,
   run_async, code)` via `inject_to_tab` → CDP `Runtime.evaluate` with
   `userGesture: true` and `awaitPromise: run_async`. In-tab JS exceptions are
   returned as `{success: false, result: exceptionDetails}`; a missing tab
   title raises inside the loader and is caught, also returning
   `{success: false}`. The call therefore resolves instead of rejecting for
   both failure classes — the frontend must treat `success === false` and
   transport rejections identically as "transport failed".
4. Tab lookup is by exact title (`injector.py` `get_tab`: `i.title == tab_name`);
   the target is the CDP target titled exactly `"Steam Big Picture Mode"` (on-device
   evidence from the v0.1.7 hard-evidence session). Missing titles fail with
   `{success: false}` (bounded backoff, not an error loop).

**Gate verdict: PASS** — the tab-bridge architecture is buildable on the
official loader API with no new frontend dependency and no
"Allow Remote CEF Debugging" requirement. `runAsync` is passed as `false`
everywhere (synchronous expressions; the returned value is read from
`result`).

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
exactly one `input` event (React-controlled-component-safe). The §24
clipboard-write + single-native-paste transaction is retained unchanged as the
FALLBACK path, used only when the focused-element insertion reports failure
(element gone, not editable, or transport failure). No path performs
per-character synthesis; the §22 contract holds on both paths.

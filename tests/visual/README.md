# Visual harness (QAM settings panel + microphone button)

Renders the REAL `src/presentation` components on a plain HTML page sized
like the Deck QAM plugin column (~410px), with the repository's existing
fakes (`FakeSettingsPort`, `FakeStateStore`) and realistic capability
reports.

`@decky/ui` resolves its field primitives from Steam's webpack runtime, so
they cannot run in a plain browser. The plugin bundle treats `@decky/ui` as
a runtime global (`DFL` on the Steam page, see `rollup.config.mjs`); this
harness maps it to its own `DeckyUI` global (`tests/visual/rollup.config.mjs`)
and provides that global through `decky-ui-standin.js`, a static
re-creation of the Deck visual language (see its header comment for the
cited tokens: Motiva Sans stack, hairline-divided panel sections, Steam
blue accent #1a9fff, state colors #5ac189/#ff5c5c/#8f98a0). No production
code imports the stand-in.

## Build

```sh
pnpm exec rollup -c tests/visual/rollup.config.mjs
```

`tests/visual/dist/` is a build artifact (gitignored).

## Capture

```sh
tests/visual/capture.mjs
```

Requires a headless-capable Chromium and ImageMagick on the host (no
project dependencies; override with `CHROME=...`). The page renders
unscrolled and reports its geometry (`data-geometry`, written by
harness-entry); the driver screenshots the full window and crops the exact
410px column region with ImageMagick — headless Chromium maps window
pixels 1:1 onto the page from its origin, but does not reliably honor
page-side scroll offsets. Section shots (`scroll=<Section>`) clip to the
titled section so it fills the frame. Writes JPEG screenshots
(wave-visual-read limits: quality 42, 1x, ≤410px column, height ≤450px,
≤80KB) to `.tmp/ui-visual/` and prints the numeric `data-overflow-x`
probe for 390px and 768px page widths.

## States

`index.html?case=panel|mic&locale=en|de&state=ready|recording|error&scroll=<Section>`

- `panel` — the real `SettingsPanel` (§80 sections Runtime/Speech/Output/
  Diagnostics).
- `mic` — the real `MicrophoneButton` in all four §20 states (ready,
  recording with elapsed timer, processing spinner, error with localized
  flash).

## jsdom smoke

`harness.test.tsx` mounts exactly the captured states (`CAPTURED_CASES`)
and asserts a throw-free mount of the expected surfaces.

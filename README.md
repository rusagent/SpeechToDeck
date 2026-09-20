# SpeechToDeck

A Steam Deck plugin for local voice dictation. A BIG dictation button in the
QuickAccess panel records your voice, transcribes it **locally**, shows a
**live level strip** while recording, and copies the finished transcript to
the **system clipboard** — open a text field, bring up the Steam virtual
keyboard with STEAM+X, and press its Paste key. No cloud services, no audio
leaves the device, and nothing is typed automatically.

## How it works

- **v0.2 dictation flow (QAM panel):** open the plugin panel, press the big
  microphone button, speak, press again to stop. The 24-bar strip renders
  the live microphone envelope streamed from the native runtime's own
  `audio.sock` broadcast (10 ms frames coalesced to 15 Hz event vectors) —
  a real level meter, not a spectrum. After stop the transcript appears in
  the panel with its clipboard status and a "copy again" button.
- Recording flows through an explicit state machine (a discriminated union,
  no boolean flag soup): record full utterance → stop → transcribe →
  clipboard → you paste.
- A persistent native STT daemon (pinned Voxtype runtime over whisper.cpp,
  CPU or Vulkan) keeps the model warm; the Decky Python backend supervises it
  and forwards the daemon's live audio-level broadcast while a recording is
  active.
- Models (whisper tiny / base / small, multilingual) are downloaded at runtime
  and verified against `defaults/models.json` SHA-256 digests.

## Clipboard

After a successful transcription the transcript is copied to the system
clipboard so the Steam keyboard's Paste key can insert it:

- **Primary:** the panel's own copy path (hidden-input `execCommand("copy")`
  in the QuickAccess browser context), reported in the panel with a
  "copy again" fallback.
- **Secondary (backend):** an `xclip` writer for the Game Mode XWayland
  server (DISPLAY from the gamescope environment, XAUTHORITY from the deck
  user's Xauthority). It activates when `bin/xclip` exists; v0.2.0 does NOT
  pin a third-party-compiled binary (no trustworthy upstream release
  artifact exists), so the backend leg reports `skipped` until one is
  provided.
- The `transcript_ready` event carries the additive `clipboard` field
  (`ok` / `failed` / `skipped`); a clipboard failure never loses the
  transcript — it stays in the panel for manual copy.

## Status

v0.2.0 (QAM dictation flow).

## Development quickstart

Requires Node 24, pnpm 10, Python >= 3.11.

```bash
pnpm install --frozen-lockfile                          # pinned deps

# Manifest integrity gates (fail-closed; runtime artifact pin pending)
node scripts/validate-manifests.mjs
node scripts/validate-licenses.mjs

# Formatting / lint (active gates)
pnpm exec prettier --check .
python3 -m venv .venv && .venv/bin/pip install ruff mypy
.venv/bin/ruff --version

# These activate as src/ and tests/ land
pnpm typecheck && pnpm test && pnpm lint && pnpm build
```

## Store

- **Testing store:** while the submission PR is open, SpeechToDeck is
  installable from <https://testing.deckbrew.xyz> (Decky settings →
  Store channel → Testing).
- **Manual install:** release zips for URL-install are attached to
  [GitHub Releases](https://github.com/rusagent/SpeechToDeck/releases).
- **Updates are one click:** Decky shows an _Update_ button when a new version
  reaches the store; the loader replaces the plugin itself — no manual
  uninstall needed.
- **Your models are safe:** downloaded transcription models and settings live
  outside the plugin code directory (`~/homebrew/data/SpeechToDeck`), so they
  survive every update. A full uninstall leaves them on disk by design; delete
  that folder if you want to reclaim the space. Single models can also be
  deleted in-app via Manage models in the Speech settings - the selected model
  is kept, and anything deleted can be downloaded again at any time.

## Layout

```text
src/           frontend (domain, application, ports, infrastructure, presentation)
backend/       Decky Python backend (hexagonal, same discipline)
bin/           native runtime artifact (not committed; see bin/README.md)
defaults/      models.json + runtime-manifest.json (pinned artifacts)
scripts/       dependency-free Node validators
tests/         frontend / backend / contract / fixtures
```

## License

MIT — see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

# SpeechToDeck

A Steam Deck plugin that adds a microphone button to the Steam virtual
keyboard. Speech is transcribed **locally** and the final transcript is
inserted as **one complete payload** — no cloud services, no live streaming,
no automatic submit. The authoritative product specification is
[docs/spec/spec-v1.0.md](docs/spec/spec-v1.0.md) (canon).

## How it works

- A mic button is mounted into the Steam virtual keyboard through a strict
  anti-corruption layer; all undocumented Steam internals stay inside
  `src/infrastructure/steam/`.
- Recording flows through an explicit state machine (a discriminated union, no
  boolean flag soup): record full utterance → stop → transcribe → insert one
  complete string via clipboard + one paste action.
- A persistent native STT daemon (pinned Voxtype runtime over whisper.cpp,
  CPU or Vulkan) keeps the model warm; the Decky Python backend supervises it.
- Models (whisper tiny / base / small, multilingual) are downloaded at runtime
  and verified against `defaults/models.json` SHA-256 digests.

See [docs/architecture/overview.md](docs/architecture/overview.md) and
[docs/adr/](docs/adr/) (ADR-001..010) for the architectural decisions.

## Status

Scaffold phase: tooling, manifests, docs, and CI exist; `src/` and `backend/`
implementation and the Phase-0 hardware spikes are pending. Details and exact
gate states: [docs/development/IMPLEMENTATION_STATUS.md](docs/development/IMPLEMENTATION_STATUS.md).

## Development quickstart

Requires Node 24, pnpm 10, Python >= 3.11.

```bash
pnpm install --frozen-lockfile                          # pinned deps (§111)

# Manifest integrity gates (fail-closed; runtime artifact pin pending)
node scripts/validate-manifests.mjs
node scripts/validate-licenses.mjs

# Formatting / lint (active gates)
pnpm exec prettier --check .
python3 -m venv .venv && .venv/bin/pip install ruff mypy
.venv/bin/ruff --version

# These activate as src/ and tests/ land (see IMPLEMENTATION_STATUS.md)
pnpm typecheck && pnpm test && pnpm lint && pnpm build
```

Full setup and the CI gate mapping: [docs/development/setup.md](docs/development/setup.md),
[docs/development/validation.md](docs/development/validation.md). Releasing to
GitHub and the Decky store: [docs/development/release.md](docs/development/release.md).

## Store

- **Testing store:** while the submission PR is open, SpeechToDeck is
  installable from <https://testing.deckbrew.xyz> (Decky settings →
  Store channel → Testing).
- **Manual install:** release zips for URL-install are attached to
  [GitHub Releases](https://github.com/rusagent/SpeechToDeck/releases).

## Layout

```text
src/           frontend (domain, application, ports, infrastructure, presentation)
backend/       Decky Python backend (hexagonal, same discipline)
bin/           native runtime artifact (not committed; see bin/README.md)
defaults/      models.json + runtime-manifest.json (pinned artifacts, §50/§53)
scripts/       dependency-free Node validators
docs/          architecture, compatibility, development, ADRs, spec
tests/         frontend / backend / contract / fixtures
```

## License

MIT — see [LICENSE](LICENSE) and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).

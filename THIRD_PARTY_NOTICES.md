# Third-Party Notices

Third-party software shipped with or downloaded by this plugin, per spec §53.
This project itself is MIT-licensed (see LICENSE).

## Shipped / runtime components

### react, react-dom

- License: MIT
- Copyright (c) Meta Platforms, Inc. and affiliates.
- https://react.dev/
- Provided by the Steam client / Decky Loader at runtime and externalized from
  the plugin bundle; not redistributed by this repository.

### @decky/ui, @decky/api

- License: MIT
- Copyright (c) Deck Users (Decky Loader contributors).
- https://github.com/SteamDeckHomebrew/decky-frontend-lib (ui), https://github.com/SteamDeckHomebrew/decky-loader (api, loader)
- Provided by the Decky Loader runtime; externalized from the plugin bundle.

## Downloaded at runtime

### whisper.cpp ggml models (tiny, base, small)

- Source: https://huggingface.co/ggerganov/whisper.cpp
- License: MIT (whisper.cpp conversions; original Whisper models MIT,
  Copyright (c) OpenAI).
- Downloaded on demand by the backend `ModelStore` and verified against the
  SHA-256 digests in `defaults/models.json`. Never committed to this
  repository.

### Voxtype runtime daemon

- Source: https://github.com/peteonrails/voxtype
- License: MIT, Copyright (c) the Voxtype authors.
- Both pinned x86_64 Linux binaries (avx2 + vulkan, v1.0.1) are recorded
  with exact version, build source, SHA-256 and license in
  `defaults/runtime-manifest.json` and downloaded at install time through
  the `remote_binary` entries in `package.json` (see bin/README.md). The
  backend verifies the pinned digest before every start. Never committed to
  this repository.

## Development-only tooling (not shipped in the plugin package)

typescript, rollup (+ @rollup/plugin-node-resolve, @rollup/plugin-commonjs,
@rollup/plugin-json), vitest, jsdom, @testing-library/react,
@types/react, @types/react-dom, eslint, typescript-eslint, prettier —
all MIT-licensed.

# Packaging

Derived from spec §111 (Build Reproducibility) and §112 (Packaging).

## Committed for reproducibility (§111)

- `pnpm-lock.yaml` — exact resolved dependency graph
- `defaults/runtime-manifest.json` — pinned runtime artifact metadata
- `defaults/models.json` — pinned model manifest
- exact tool configuration — `tsconfig.json`, `rollup.config.mjs`,
  `vitest.config.ts`, `eslint.config.mjs`, `.prettierrc`, `pyproject.toml`,
  `plugin.json`

Release CI records the source commit SHA, the runtime binary SHA-256, and the
package SHA-256 (§111).

## Plugin package contents (§112, verified Decky packager layout)

The Decky CLI packager (`decky plugin build -s <dir>` inside
`ghcr.io/steamdeckhomebrew/builder:latest`) produces a zip with a single
top-level directory named exactly `plugin.json` `name`:

```text
dist/index.js
main.py
backend/
bin/
models.json             # defaults/ is FLATTENED into the plugin root
runtime-manifest.json
plugin.json
package.json
LICENSE
README.md
THIRD_PARTY_NOTICES.md
```

- `defaults/` is **not** shipped as a directory: the packager flattens it
  into the plugin root. The backend resolves both layouts (repository
  checkout: `defaults/`; installed package: flattened) through the single
  documented resolver `resolve_defaults_file` in
  `backend/infrastructure/process/process_environment.py`, and
  `scripts/validate-package.mjs` rejects any package that still contains a
  `defaults/` directory.
- `bin/` carries the pinned native runtime artifact; it is packaged
  intentionally rather than relying on host-installed packages, and is
  checksummed against the runtime manifest before packaging (bin/README.md).
  The binary itself is never committed to git.
- `models.json` ships so the on-device `ModelStore` can download and
  verify models at runtime (§50-§51). Model binaries are never committed.
- Dev-only tooling (node_modules, test suites, docs, `src/`, `tests/`) does
  not ship in the plugin package.
- `package.json` deliberately carries no `packageManager` field: the builder
  image ships a global pnpm 9 that must not be overridden (see
  [release.md](release.md)).
- The store review checklist additionally requires the root `defaults.txt`
  documenting every defaults file.

## Privileges

The plugin targets the no-root flag set (spec §113): `plugin.json` declares no
root flag and the audio/STT architecture must work unprivileged. Root must not
be added merely because another plugin uses it.

## Structure validation

Package structure validation (§97) checks the archive against the verified
§112 layout above. `scripts/validate-package.mjs` validates a built zip, or a
docker-independent `--dir` staging tree that mirrors the zip root; CI's
`package-structure-validation` job assembles that tree and the release
pipeline validates every zip it ships. The release/store flow itself is
documented in [release.md](release.md).

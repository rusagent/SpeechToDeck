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

## Plugin package contents (§112)

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

- `bin/` carries the pinned native runtime artifact; it is packaged
  intentionally rather than relying on host-installed packages, and is
  checksummed against `defaults/runtime-manifest.json` before packaging
  (bin/README.md). The binary itself is never committed to git.
- `defaults/models.json` ships so the on-device `ModelStore` can download and
  verify models at runtime (§50-§51). Model binaries are never committed.
- Dev-only tooling (node_modules, test suites, docs) does not ship in the
  plugin package.

## Privileges

The plugin targets the no-root flag set (spec §113): `plugin.json` declares no
root flag and the audio/STT architecture must work unprivileged. Root must not
be added merely because another plugin uses it.

## Structure validation

Package structure validation (§97) checks the archive against the §112 layout.
The validator script is owned by the packaging lane; CI activates its job as
soon as `scripts/validate-package.mjs` exists.

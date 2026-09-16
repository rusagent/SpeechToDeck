# Development Setup

## Prerequisites

- Node.js 24.x and pnpm 10.x (the repo pins `packageManager: pnpm@10.33.2`)
- Python >= 3.11 (the plugin backend targets the Decky runtime's Python; spec
  §100)

## Frontend toolchain

```bash
pnpm install          # install pinned dependencies (pnpm-lock.yaml, §111)
pnpm build            # rollup bundle → dist/index.js (needs src/, see status)
pnpm typecheck        # tsc --noEmit with spec §98 strict flags
pnpm test             # vitest (jsdom), tests live in tests/
pnpm lint             # eslint (flat config)
pnpm format           # prettier --write .
pnpm format:check     # prettier --check .
```

## Backend toolchain

The repository keeps a virtualenv at `.venv/` (gitignored) with ruff and mypy
installed:

```bash
python3 -m venv .venv
.venv/bin/pip install ruff mypy

.venv/bin/ruff check backend tests main.py
.venv/bin/ruff format --check backend tests main.py
.venv/bin/mypy                 # config in pyproject.toml (strict)
```

Python unit tests run with pytest from `tests/backend/` and contract tests from
`tests/contract/` once those suites land.

## Manifest validation

```bash
node scripts/validate-manifests.mjs    # defaults/ manifests (§50/§53)
node scripts/validate-licenses.mjs     # THIRD_PARTY_NOTICES.md coverage (§97)
```

`validate-manifests.mjs` is a hard gate for `models.json` violations and for a
malformed runtime manifest. An unpinned runtime artifact (empty `sha256`, the
documented pre-pin state) prints a loud `RUNTIME_UNPINNED` diagnostic but keeps
the default run green (§129); release packaging must run it with `--strict`,
which fails on an unpinned runtime. See bin/README.md for the pinning
procedure.

## Model and runtime artifacts

- `defaults/models.json` pins the curated v1 whisper models (tiny, base,
  small) with real SHA-256 digests. Models are downloaded at runtime by the
  backend `ModelStore` (§51), never committed to git.
- `defaults/runtime-manifest.json` pins the native runtime artifact. It is
  intentionally not filled yet; the acquisition and checksum procedure is in
  bin/README.md.

## Packaging

See docs/development/packaging.md (§111-§112).

## CI

.github/workflows/ci.yml implements the §97 gate list. Gates whose code does
not exist yet are present but skipped until their paths appear; gates that can
run today (formatting, manifest validation, license validation) are active and
required.

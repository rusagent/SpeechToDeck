# Implementation Status

Current repository state. The canon is docs/spec/spec-v1.0.md; the phase plan
is §115-§121.

## What exists today (scaffold only)

- Repository hubs: `package.json` (+ pinned `pnpm-lock.yaml`), `tsconfig.json`
  with the §98 strict flags, `vitest.config.ts`, `rollup.config.mjs`,
  `pyproject.toml`, `plugin.json` (no root flag, §113), ESLint flat config,
  Prettier config, LICENSE, THIRD_PARTY_NOTICES.md.
- `defaults/models.json`: tiny / base / small whisper ggml entries with **real
  SHA-256 digests** computed from downloaded artifacts (spec §48/§50).
- `defaults/runtime-manifest.json`: Voxtype runtime artifact schema (§53) with
  the binary intentionally **not** bundled and the pin fields (version, source,
  sha256, license) deliberately empty; bin/README.md documents acquisition.
  The manifest validation gate therefore **fails by design** until the runtime
  lane pins the artifact.
- `scripts/validate-manifests.mjs` and `scripts/validate-licenses.mjs`
  (dependency-free Node validators, §97 gates).
- Docs: architecture overview, compatibility checklist (§93), development
  guides, ADR-001..010 (§126).
- CI: .github/workflows/ci.yml implementing the §97 gate list. Gates whose
  input code does not exist yet are present but skipped; active gates:
  formatting, manifest validation, license validation.
- `.venv/` (gitignored, not committed) with ruff and mypy for later lanes.

## What does not exist yet (owned by later lanes)

- `src/**` frontend implementation and `backend/**` Python implementation.
- `tests/**` suites (frontend, backend, contract, fixtures).
- Phase-0 hardware spikes (§115): keyboard mounting, bulk insertion, STT
  runtime in Game Mode, Vulkan vs CPU benchmarks. The Phase-0 exit gate (§116)
  has not been evaluated; **no architecture assumption is finalized from
  theoretical capability alone.**
- Runtime artifact pinning (fills `defaults/runtime-manifest.json`).
- The packaging/structure validator (`scripts/validate-package.mjs`).

## Known integration decisions pending

- The rollup config carries the three scaffold plugins (node-resolve,
  commonjs, json) and externalizes react, react-dom, @decky/ui, @decky/api.
  A TypeScript/TSX transform for `src/index.tsx` must be added by the build
  lane that lands src/ (rollup does not compile TSX natively). `pnpm typecheck`
  (tsc) is the strict-compile gate and activates with the first sources.
- TypeScript typecheck is deliberately not an L1 gate until src/ exists
  (tsconfig `include` is empty today; tsc would fail with "no inputs").

## How to verify the current state

```bash
pnpm install --frozen-lockfile
node scripts/validate-manifests.mjs   # exits 1: runtime artifact unpinned (expected)
node scripts/validate-licenses.mjs    # exits 0
pnpm exec prettier --check .
.venv/bin/ruff --version
```

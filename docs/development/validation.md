# Validation Commands

The decisive local checks and their CI counterparts. All gates are the CI
pipeline list from spec §97; "no release artifact if any required gate fails".

## Local L1 checks (run before every commit)

| Command                                   | Proves                                                                                                                                                  |
| ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `pnpm install --frozen-lockfile`          | Lockfile and manifests are consistent (§111 reproducibility).                                                                                           |
| `node scripts/validate-manifests.mjs`     | defaults/ manifests satisfy §50/§53; unpinned runtime → loud `RUNTIME_UNPINNED` diagnostic, still green (§129); `--strict` fails for release packaging. |
| `node scripts/validate-licenses.mjs`      | Declared runtime deps are covered by THIRD_PARTY_NOTICES.md.                                                                                            |
| `pnpm exec prettier --check .`            | Frontend/docs formatting (§97 frontend formatting).                                                                                                     |
| `.venv/bin/ruff --version` / `ruff check` | Python lint/format gates available and clean (§97).                                                                                                     |
| `.venv/bin/mypy`                          | Python type checking (§97) — active once backend/ exists.                                                                                               |
| `pnpm typecheck`                          | TypeScript strict compile (§97/§98) — active once src/ exists.                                                                                          |
| `pnpm test`                               | Frontend unit tests (§97) — active once tests/ exists.                                                                                                  |

## CI gate mapping (spec §97)

| Spec gate                      | CI job                         | State today                                  |
| ------------------------------ | ------------------------------ | -------------------------------------------- |
| frontend formatting            | `frontend-formatting`          | Active.                                      |
| frontend lint                  | `frontend-lint`                | Present; skips until lintable sources exist. |
| TypeScript strict compile      | `typescript-strict-compile`    | Present; skips until src/ exists.            |
| frontend unit tests            | `frontend-unit-tests`          | Present; skips until tests/ exists.          |
| Python formatting              | `python-formatting`            | Present; skips until Python sources exist.   |
| Python lint                    | `python-lint`                  | Present; skips until Python sources exist.   |
| Python type checking           | `python-type-checking`         | Present; skips until backend/ exists.        |
| backend unit tests             | `backend-unit-tests`           | Present; skips until tests/backend exists.   |
| contract tests                 | `contract-tests`               | Present; skips until tests/contract exists.  |
| artifact manifest validation   | `manifest-validation`          | Active and **failing by design** until the   |
|                                |                                | runtime artifact is pinned (bin/README.md).  |
| third-party license validation | `license-validation`           | Active.                                      |
| package build                  | `package-build`                | Present; skips until src/ exists.            |
| package structure validation   | `package-structure-validation` | Present; skips until its validator script is |
|                                |                                | added by the packaging lane.                 |

Skipped is not passing: each code-dependent job activates as soon as its input
paths exist, and then runs as a required gate. No gate is ever weakened to make
the pipeline green (spec §2.4, §97, §127).

## Notes

- TypeScript strictness (§98): `strict`, `noImplicitAny`,
  `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes` are all on in
  tsconfig.json.
- Manifest validation is intentionally fail-closed: an empty `sha256` in either
  manifest fails the gate with a clear message instead of being tolerated.
- Boundary validation (§99): unknown data crossing from Steam internals or
  backend JSON must be validated at the boundary; contract tests own this
  once they exist.

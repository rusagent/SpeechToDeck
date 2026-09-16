# Release & Store Distribution Handbook

Owner-facing procedure for cutting releases and shipping to the Decky store.
The automation lives in [.github/workflows/release.yml](../../.github/workflows/release.yml);
store rules are owned by SteamDeckHomebrew:

- Submitting plugins: <https://wiki.deckbrew.xyz/en/plugin-dev/submitting-plugins>
- Review & testing: <https://wiki.deckbrew.xyz/en/plugin-dev/review-and-testing>

## What the release pipeline does

```text
tag push v*  (or workflow_dispatch, channel = stable | preview)
  ├─ gates          same checks as CI's core jobs; the artifact-manifest gate
  │                 runs with --strict, so a release fails while the native
  │                 runtime artifact is unpinned (bin/README.md, spec §53)
  ├─ package        toolchain build inside ghcr.io/steamdeckhomebrew/builder
  │                 (its entrypoint runs pnpm i --frozen-lockfile, pnpm run
  │                 build and assembles the output tree into /out), then
  │                 scripts/build-package.mjs writes the contract-conformant
  │                 zip(s) + SHA256SUMS.txt; --dev adds the URL-install dev
  │                 zip for preview / *-pre.* / *-rc* builds
  ├─ validate       scripts/validate-package.mjs on every produced zip
  ├─ github-release zips + checksums attached; prerelease for preview/pre/rc
  └─ store-pr       OPTIONAL, off by default (see below)
```

Store distribution is a review flow, not an upload: a PR to
[SteamDeckHomebrew/decky-plugin-database](https://github.com/SteamDeckHomebrew/decky-plugin-database)
adds this repository as a submodule under `plugins/<name>`; **their** CI builds
the package with **their** secrets and uploads it. Nothing in this repo holds
store credentials.

## One-time setup

1. **Pin the native runtime artifact.** Fill every field of
   `defaults/runtime-manifest.json` per [bin/README.md](../../bin/README.md)
   and place the binary at `bin/voxtype`. The strict manifest gate makes this
   a hard prerequisite of every release run. Never invent a digest.
2. **Icon + screenshot.** Add `assets/icon.png` and `assets/screenshot.jpg`
   (the store listing image: a real settings-panel render produced by
   `tests/visual/capture.mjs`) and put the hosted URL into `plugin.json`
   `publish.image`. This repository serves the screenshot via
   raw.githubusercontent:
   `https://raw.githubusercontent.com/rusagent/SpeechToDeck/main/assets/screenshot.jpg`
   — reachable only once the asset is merged to `main`. The store CI
   hard-fails when `image` is empty or broken: it POSTs the URL to the store
   upload endpoint, so a reachable URL is a hard submission requirement.
3. **Fork the db repo** `SteamDeckHomebrew/decky-plugin-database` under the
   owner account.
4. **Repository variables** (Settings → Secrets and variables → Actions):
    - `STORE_PR_ENABLED` = `true` to switch the optional `store-pr` job on
      (leave unset/anything else and the job is skipped);
    - `DB_FORK_REPO` = `<owner>/decky-plugin-database` (the fork).
5. **Repository secret**: `DB_PR_PAT` — a fine-grained personal access token
   with contents read/write on the fork only. Used to push the submodule
   update branch and open the PR. If the secret is absent while
   `STORE_PR_ENABLED` is `true`, the job skips with a notice.
6. **Talk to the maintainers about generative AI.** The db submission/review
   template asks whether generative AI was used. The automation deliberately
   does **not** answer that question (see the PR checklist it posts); have the
   conversation with the maintainers and state the answer yourself.
7. **Test pass (third party, SteamOS Preview channel).** This plugin ships
   prebuilt dynamically-linked voxtype binaries, so the db review template's
   "Tested on Stable and Beta" line does not apply here and must be
   **removed**. The required testing line for this plugin is a **SteamOS
   Preview update channel** test pass performed by a **third party** (a
   tester other than the author — never self-checked); arrange it with the
   maintainers while the PR is open. Release automation never claims testing
   on your behalf.

## Stable release flow

1. Bump `package.json` `.version` (semver — the loader's update detection
   reads it) and merge to `main`.
2. Push the tag: `git tag v0.1.0 && git push origin v0.1.0`.
3. The pipeline runs gates → package → validate → GitHub release, and — when
   enabled — opens the db PR from the fork: `Plugin addition:` the first time
   (adds the submodule), `Plugin update:` afterwards (moves the gitlink to the
   tagged commit).
4. **While the db PR is open, testers can install from the testing store**
   <https://testing.deckbrew.xyz>.
5. Complete the PR's **OWNER REVIEW REQUIRED** checklist (AI-usage
   declaration, icon/screenshot URL, third-party SteamOS Preview-channel
   testing — this plugin's prebuilt dynamically-linked binaries — and the
   `defaults.txt` check). Only then ask maintainers for review.
6. Maintainers merge → the plugin appears in the production store.

## Preview flow (prereleases)

- Tag a preview: any tag matching `*-pre.*` or `*-rc*` (e.g. `v0.2.0-rc.1`), or
  run the workflow manually with `channel: preview`.
- The build is published as a **GitHub prerelease** and the Decky CLI gets
  `-d`, producing an additional `-dev` zip for URL installs.
- Previews reach the testing store through the same db-PR flow while the PR
  is open.

## Escape hatch: `dnu`

Tagging a build `dnu` ("do not update") withholds its store upload — use it
for a build that must exist on GitHub but must never reach store users.

## Manifests and package layout (why CI is shaped this way)

- The builder image ships a **global pnpm 9**; `package.json` therefore
  carries no `packageManager` field, and our own workflows pin pnpm
  10.33.2 explicitly. The lockfile (`lockfileVersion: '9.0'`) installs
  identically under both.
- The packager **flattens `defaults/`** into the plugin root of the installed
  package while this repository keeps the files under `defaults/`. The
  backend resolves both layouts through a single resolver
  (`resolve_defaults_file` in
  `backend/infrastructure/process/process_environment.py`), and
  `scripts/validate-package.mjs` rejects any package that still contains a
  `defaults/` directory.
- `plugin.json` uses `api_version: 1`, keeps `"flags": []` (rootless, spec
  §113) and carries the store metadata block `publish` (`tags`,
  `description`, `image`).
- Every defaults file is documented in the root [`defaults.txt`](../../defaults.txt)
  (store review checklist item).

## Local dry run

```bash
pnpm install --frozen-lockfile && pnpm build
# Build the contract-conformant zip exactly like CI does, then validate it:
node scripts/build-package.mjs --src . --out .tmp/package-check
node scripts/validate-package.mjs ".tmp/package-check/$(node -p "JSON.parse(require('fs').readFileSync('plugin.json','utf8')).name").zip"
```

With Docker available, the real container toolchain build works locally too.
Observed builder-image behavior (this is what release.yml relies on): the
entrypoint mounts the plugin at `/plugin`, runs `pnpm i --frozen-lockfile` +
`pnpm run build`, and rsyncs the result into `/out` (excluding `src/`,
`__pycache__`, `node_modules`). The image ships **no** `decky` CLI binary, so
the zip is produced by `scripts/build-package.mjs` from the `/out` tree —
which is why `--dev` (not a CLI `-d` flag) emits the preview dev zip. Keep
`/out` outside the source tree: the entrypoint rsyncs `/plugin/` into `/out`,
and nesting the destination inside the source would make rsync self-copy.

```bash
OUT_DIR=$(mktemp -d)
docker run --rm -v "$PWD:/plugin" -v "$OUT_DIR:/out" \
    ghcr.io/steamdeckhomebrew/builder:latest
node scripts/build-package.mjs --src "$OUT_DIR" --out .tmp/release --dev
node scripts/validate-package.mjs .tmp/release/*.zip
```

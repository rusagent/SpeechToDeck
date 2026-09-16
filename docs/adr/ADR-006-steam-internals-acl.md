# ADR-006: Steam internals isolated behind an anti-corruption layer

Status: Accepted (spec §3.3, §103-§105)

## Context

Mounting UI into the Steam virtual keyboard and driving its paste behaviour
requires undocumented Steam structures: `window.SteamUIStore`,
`VirtualKeyboardManager`, `BrowserWindow`, React fiber internals
(`__reactFiber$`), keyboard DOM internals, and private component methods.
These change without notice across Steam client updates.

## Decision

Everything touching undocumented Steam structures lives exclusively below
`src/infrastructure/steam/` (the Steam ACL: `SteamKeyboardHostAdapter`,
`SteamKeyboardLocator`, `SteamCapabilityProbe`, `SteamBulkPasteInserter`,
`SteamClipboardAdapter`, `SteamPasteActionAdapter`, `SteamHookRegistry`, ...).
No other layer may access those internals. Untyped data crossing the boundary
is validated immediately and converted into typed internal representations;
`any` is tolerated only inside the ACL package (§98, enforced by the ESLint
override in `eslint.config.mjs`). Hooks are registered and owned through a
registry, never applied blind.

## Consequences

- A Steam client update should require changes only inside the ACL package.
- Leaking Steam internals outside the adapter package is a merge-blocking
  quality gate (§127) and is checked in review and boundary tests.
- Discovery strategies degrade explicitly (capability probing with surfaced
  incompatibility), never through CSS-class-only guesses (§60) or silent
  compatibility fallbacks (§2.4).

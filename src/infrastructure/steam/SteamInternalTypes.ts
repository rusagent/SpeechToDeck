/**
 * Minimal Steam internal type surface (spec §103).
 *
 * Contains only shapes that the adapter actually consumes; it does not
 * reproduce private Steam type trees. Raw Steam objects are converted into
 * these typed representations at the discovery boundary (§98) and every
 * optional/private member is capability-checked before use (§103/§104).
 */

/** The two lifecycle methods the adapter instruments (spec §15). */
export interface SteamVirtualKeyboardManager {
    SetVirtualKeyboardVisible: (...args: unknown[]) => unknown;

    SetVirtualKeyboardHidden: (...args: unknown[]) => unknown;
}

/**
 * Typed handle for the Steam UI window the plugin runs in. The token is a
 * stable, non-DOM identifier used as `KeyboardContext.windowToken` (§7.2).
 */
export interface SteamWindowHandle {
    readonly token: string;
    readonly window: Window;
    readonly document: Document;
}

/**
 * Typed representation of the React-managed keyboard component. v1 does not
 * depend on React internals; the fiber key is recorded for diagnostics only.
 */
export interface SteamKeyboardComponent {
    readonly rootElement: HTMLElement;
    readonly reactFiberKey: string | null;
}

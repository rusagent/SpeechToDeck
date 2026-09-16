/**
 * Compatibility profile contract (spec §59) and its discovery context.
 *
 * Steam-version specifics live in explicit profile objects under
 * `src/infrastructure/steam/profiles/` — never scattered through the adapter
 * code. A Steam update usually requires adding or changing a profile, not
 * rewriting the application.
 */

import type {
    SteamKeyboardComponent,
    SteamVirtualKeyboardManager,
    SteamWindowHandle,
} from "../SteamInternalTypes";

/**
 * What discovery observed in the current Steam session. Every field is a
 * typed internal representation converted at the boundary (§98/§103);
 * `manager` and `keyboardDom` are `null` when the corresponding capability
 * check failed — profiles decide support, they never guess.
 */
export interface SteamDiscoveryContext {
    readonly window: SteamWindowHandle;
    readonly manager: SteamVirtualKeyboardManager | null;
    readonly keyboardDom: HTMLElement | null;
    readonly component: SteamKeyboardComponent | null;
}

/**
 * Handle for the keyboard's native paste semantic action (spec §26/§28
 * Candidate A). Invoking it performs the same operation the user's Paste
 * control performs; it never types content.
 */
export interface SteamPasteHandle {
    invoke(): void;

    /** Auditable description of the discovered mechanism (diagnostics/logs). */
    readonly mechanism: string;
}

export interface SteamKeyboardProfile {
    readonly id: string;

    /** True only when the observed structure matches this known signature. */
    matches(context: SteamDiscoveryContext): boolean;

    /** Safe container the plugin-owned microphone node is appended into. */
    locateMountPoint(keyboard: HTMLElement): HTMLElement | null;

    /** The keyboard's native paste action, or null when unrecognized. */
    locatePasteAction(keyboard: HTMLElement): SteamPasteHandle | null;
}

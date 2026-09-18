/**
 * Keyboard host contract (spec §13) with the listener and microphone-control
 * prop types the host implementation consumes.
 */

import type { KeyboardContext } from "../../domain/DictationSession";
import type { Disposable } from "../../shared/Disposable";

/**
 * Visual state of the microphone control (§19/§20 model output). Carried on
 * the props since v0.1.7 so a host that renders outside the plugin document
 * (tab bridge) can map the exact visual, not just the active/busy flags.
 */
export type MicrophoneControlVisualState = "ready" | "recording" | "processing" | "error";

/**
 * Props for the microphone control mounted into the Steam keyboard
 * (spec §13/§19). `active` becomes true only after recording start has been
 * acknowledged (§75); `busy` disables the button during transient states (§10).
 * `visual` is additive since v0.1.7 (§99).
 */
export interface MicrophoneControlProps {
    readonly visible: boolean;
    readonly active: boolean;
    readonly busy: boolean;
    readonly onPress: () => void;
    readonly visual?: MicrophoneControlVisualState;
}

/**
 * Keyboard lifecycle events pushed by the host. Every keyboard appearance is a
 * new context id (spec §7.2).
 */
export type KeyboardHostEvent =
    | { readonly type: "keyboard-opened"; readonly context: KeyboardContext }
    | { readonly type: "keyboard-closed"; readonly contextId: string };

export type KeyboardHostListener = (event: KeyboardHostEvent) => void;

/**
 * Seam between the host adapter and the microphone UI (spec §18).
 * Implementations render into the plugin-owned node the adapter created; the
 * returned Disposable removes exactly that render.
 */
export interface MicrophoneControlRenderer {
    render(host: HTMLElement, props: MicrophoneControlProps): Disposable;
}

/**
 * §58-shaped keyboard hook facts (v0.1.6, additive optional port surface):
 * drives the `keyboardHookAvailable` capability derivation (§57) and the
 * diagnostics panel. `reason` is a stable lowercase degrade code
 * ("registry-not-found" | "manager-not-found" | "signature-not-found") or
 * null when the hook is fully available (§105).
 */
export interface KeyboardHostDiagnostics {
    /** A window-store registry access chain resolved at least once. */
    readonly registryFound: boolean;
    /** Manager instances currently wrapped with §15 lifecycle hooks. */
    readonly managersHooked: number;
    /** The verified keyboard DOM signature was located at least once. */
    readonly keyboardSignatureSeen: boolean;
    /** At least one registry window instance resolved a document. */
    readonly documentResolved: boolean;
    readonly reason: string | null;
}

/**
 * v0.1.7 tab-bridge facts for the diagnostics panel (§99 additive surface).
 * All three booleans are observed, never assumed (§57): `injected` is the
 * in-window `__stdKbBridgeLoaded` flag read back by the poll, `keyboardSeen`
 * is the permanently-present keyboard container observed at least once since
 * start, and `pressChannelLive` means the poll channel completed at least one
 * successful round trip since start. `reason` reuses the stable lowercase
 * degrade-code convention (§105): "sp-target-not-found" |
 * "bridge-not-injected" | "signature-not-found", or null when fully available.
 */
export interface TabBridgeDiagnostics {
    readonly injected: boolean;
    readonly keyboardSeen: boolean;
    readonly pressChannelLive: boolean;
    readonly reason: string | null;
}

export interface KeyboardHostPort {
    start(): Promise<void>;

    currentContext(): KeyboardContext | null;

    subscribe(listener: KeyboardHostListener): Disposable;

    mountMicrophoneControl(props: MicrophoneControlProps): Disposable;

    stop(): Promise<void>;

    /**
     * Optional since v0.1.6: implementations that cannot report hook facts
     * omit it (or report null), and consumers keep their pre-0.1.6 behavior
     * (§99: additive optional boundary fields).
     */
    getDiagnostics?(): KeyboardHostDiagnostics | null;
}

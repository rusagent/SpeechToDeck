/**
 * Keyboard host contract with the listener and microphone-control
 * prop types the host implementation consumes.
 */

import type { KeyboardContext } from "../../domain/DictationSession";
import type { Disposable } from "../../shared/Disposable";

/**
 * Visual state of the microphone control (the model's rendered output).
 * Carried on the props so a host that renders outside the plugin document
 * (tab bridge) can map the exact visual, not just the active/busy flags.
 */
export type MicrophoneControlVisualState = "ready" | "recording" | "processing" | "error";

/**
 * Props for the microphone control mounted into the Steam keyboard.
 * `active` becomes true only after recording start has been acknowledged;
 * `busy` disables the button during transient states. `visual` is additive
 * and optional.
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
 * new context id.
 */
export type KeyboardHostEvent =
    | { readonly type: "keyboard-opened"; readonly context: KeyboardContext }
    | { readonly type: "keyboard-closed"; readonly contextId: string };

export type KeyboardHostListener = (event: KeyboardHostEvent) => void;

/**
 * Seam between the host adapter and the microphone UI.
 * Implementations render into the plugin-owned node the adapter created; the
 * returned Disposable removes exactly that render.
 */
export interface MicrophoneControlRenderer {
    render(host: HTMLElement, props: MicrophoneControlProps): Disposable;
}

/**
 * Keyboard hook facts (additive optional port surface): drives the
 * `keyboardHookAvailable` capability derivation and the diagnostics panel.
 * `reason` is a stable lowercase degrade code
 * ("registry-not-found" | "manager-not-found" | "signature-not-found") or
 * null when the hook is fully available.
 */
export interface KeyboardHostDiagnostics {
    /** A window-store registry access chain resolved at least once. */
    readonly registryFound: boolean;
    /** Manager instances currently wrapped with lifecycle hooks. */
    readonly managersHooked: number;
    /** The verified keyboard DOM signature was located at least once. */
    readonly keyboardSignatureSeen: boolean;
    /** At least one registry window instance resolved a document. */
    readonly documentResolved: boolean;
    readonly reason: string | null;
}

/**
 * Tab-bridge facts for the diagnostics panel (additive surface).
 * All three booleans are observed, never assumed: `injected` is the
 * in-window `__stdKbBridgeLoaded` flag read back by the poll, `keyboardSeen`
 * is the permanently-present keyboard container observed at least once since
 * start, and `pressChannelLive` means the poll channel completed at least one
 * successful round trip since start. `reason` reuses the stable lowercase
 * degrade-code convention: "sp-target-not-found" |
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
     * Optional: implementations that cannot report hook facts omit it (or
     * report null), and consumers fall back to their older assumption that
     * the hook is installed (additive optional boundary fields).
     */
    getDiagnostics?(): KeyboardHostDiagnostics | null;
}

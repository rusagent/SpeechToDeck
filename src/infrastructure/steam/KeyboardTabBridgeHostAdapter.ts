/**
 * SteamKeyboardTabBridgeHostAdapter (v0.1.7) — the KeyboardHostPort the
 * controller, presenter and lifecycle see, implemented over the tab bridge.
 *
 * This REPLACES the v0.1.6 registry-mount adapter in the composition root
 * (on-device evidence: the window-store registry never exposes a keyboard
 * manager — managersFound=0 with the keyboard open). Responsibilities:
 *
 * - keyboard lifecycle: poll visibility → keyboard-opened/keyboard-closed
 *   port events with fresh context ids (§7.2) — the controller's existing
 *   subscription consumes them unchanged;
 * - microphone control: the button lives in the keyboard document (bootstrap
 *   injected via executeInTab), so `mountMicrophoneControl` translates the
 *   §75-true model output into `__stdMicState` pushes instead of rendering
 *   React into a plugin-owned node;
 * - §58-shaped diagnostics: the capability derivation (`reason === null` →
 *   `keyboardHookAvailable`) consumes observed bridge facts — transport round
 *   trip proven, in-window bootstrap flag read back, keyboard container seen.
 *
 * Hard boundaries kept from §14/§106: no dictation logic; every executor call
 * is exception-contained; no optimistic capability assumption (§57).
 */

import type { KeyboardContext } from "../../domain/DictationSession";
import type {
    KeyboardHostDiagnostics,
    KeyboardHostEvent,
    KeyboardHostListener,
    KeyboardHostPort,
    MicrophoneControlProps,
    TabBridgeDiagnostics,
} from "../../application/ports/KeyboardHostPort";
import type { Disposable } from "../../shared/Disposable";
import { Logger } from "../../shared/Logger";
import { KeyboardTabBridge } from "./KeyboardTabBridge";
import type { KeyboardTabBridgeOptions, TabExecutor } from "./KeyboardTabBridge";

export interface SteamKeyboardTabBridgeHostAdapterOptions {
    executor: TabExecutor;

    /** Press forwarding — wired to the same controller entry the QAM model uses. */
    onPress: () => void;

    /** Poll gate: the bridge polls ONLY while the plugin is enabled. */
    isEnabled?: () => boolean;

    tabTitle?: string;

    pollMs?: number;

    reinjectMs?: number;

    logger?: Logger;
}

export class SteamKeyboardTabBridgeHostAdapter implements KeyboardHostPort, Disposable {
    /** The engine, exposed for the insertion-path wiring (paste action, composite inserter). */
    readonly bridge: KeyboardTabBridge;
    private readonly logger: Logger;
    private readonly listeners = new Set<KeyboardHostListener>();
    private micDisposable: Disposable | null = null;
    private stopped = false;

    constructor(options: SteamKeyboardTabBridgeHostAdapterOptions) {
        this.logger = options.logger ?? new Logger("steam.keyboard");
        const bridgeOptions: KeyboardTabBridgeOptions = {
            executor: options.executor,
            onPress: options.onPress,
            onKeyboardOpened: (context) => {
                this.emit({ type: "keyboard-opened", context });
            },
            onKeyboardClosed: (contextId) => {
                this.emit({ type: "keyboard-closed", contextId });
            },
        };
        if (options.isEnabled !== undefined) {
            bridgeOptions.isEnabled = options.isEnabled;
        }
        if (options.tabTitle !== undefined) {
            bridgeOptions.tabTitle = options.tabTitle;
        }
        if (options.pollMs !== undefined) {
            bridgeOptions.pollMs = options.pollMs;
        }
        if (options.reinjectMs !== undefined) {
            bridgeOptions.reinjectMs = options.reinjectMs;
        }
        if (options.logger !== undefined) {
            bridgeOptions.logger = options.logger;
        }
        this.bridge = new KeyboardTabBridge(bridgeOptions);
    }

    // ── KeyboardHostPort (§13) ──

    /** Never throws: transport failures degrade through `getDiagnostics` (§105). */
    async start(): Promise<void> {
        if (this.stopped) {
            return;
        }
        await this.bridge.start();
    }

    async stop(): Promise<void> {
        if (this.stopped) {
            return;
        }
        this.stopped = true; // new mounts and visual pushes are rejected from here on (§83)
        this.releaseMic();
        await this.bridge.stop();
    }

    currentContext(): KeyboardContext | null {
        return this.bridge.currentContext();
    }

    subscribe(listener: KeyboardHostListener): Disposable {
        this.listeners.add(listener);
        return {
            dispose: () => {
                this.listeners.delete(listener);
            },
        };
    }

    /**
     * The control itself is the in-window `std-mic-host` div (self-installing
     * bootstrap). This method records the §75-true visual state and pushes it
     * into the keyboard document; the returned Disposable detaches the
     * current props (exactly the plugin-owned surface, §18).
     */
    mountMicrophoneControl(props: MicrophoneControlProps): Disposable {
        if (this.stopped) {
            // §83: no visual pushes after teardown started; return a no-op mount.
            return {
                dispose: () => undefined,
            };
        }
        this.pushVisual(props);
        if (this.micDisposable === null) {
            this.micDisposable = {
                dispose: () => {
                    if (!this.stopped) {
                        this.bridge.pushState("idle");
                    }
                    this.micDisposable = null;
                },
            };
        }
        return this.micDisposable;
    }

    /**
     * §58-shaped mapping for the controller's capability derivation. Field
     * semantics under the tab bridge: `registryFound` = a transport round
     * trip resolved at least once; `keyboardSignatureSeen` = the keyboard
     * container was observed at least once; `documentResolved` = the
     * in-window bootstrap flag was read back; `managersHooked` is
     * structurally 0 (no registry managers in this architecture). `reason`
     * is null — hence `keyboardHookAvailable` — only when all observed facts
     * are proven (§57).
     */
    getDiagnostics(): KeyboardHostDiagnostics {
        const facts = this.bridge.getFacts();
        return {
            registryFound: facts.transportOk,
            managersHooked: 0,
            keyboardSignatureSeen: facts.keyboardSeen,
            documentResolved: facts.bootstrapInjected,
            reason: facts.reason,
        };
    }

    /** Panel-facing tab-bridge rows (Task 4) from the same observed facts. */
    getBridgeDiagnostics(): TabBridgeDiagnostics {
        return this.bridge.getDiagnostics();
    }

    dispose(): Promise<void> {
        return this.stop();
    }

    // ── Internals ──

    private pushVisual(props: MicrophoneControlProps): void {
        const visual = props.visual ?? "ready";
        this.bridge.pushState(
            visual === "recording" ? "recording" : visual === "error" ? "error" : "idle",
        );
    }

    private releaseMic(): void {
        this.micDisposable?.dispose();
        this.micDisposable = null;
    }

    private emit(event: KeyboardHostEvent): void {
        for (const listener of [...this.listeners]) {
            try {
                listener(event);
            } catch (error) {
                this.logger.error("keyboard listener failed", {
                    eventType: event.type,
                    detail: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }
}

/**
 * SteamKeyboardLocator.
 *
 * Locates the active Steam window, the per-window virtual keyboard manager
 * (through the SharedJSContext window-store registry) and the
 * keyboard DOM. Discovery is strictly bounded: attempt immediately after a
 * keyboard-open notification, retry with a short capped backoff, and stop
 * after the configured deadline (recommended maximum 1000 ms). There is no
 * endless polling loop and no periodic scanning; once found, the
 * lifecycle is observed event-driven through the keyboard manager hooks.
 */

import type { SteamDiscoveryContext } from "./profiles/SteamKeyboardProfile";
import { SteamWindowRegistry } from "./SteamWindowRegistry";
import type {
    SteamKeyboardComponent,
    SteamVirtualKeyboardManager,
    SteamWindowHandle,
} from "./SteamInternalTypes";

export interface SteamLocatorConfig {
    /** Total discovery budget in milliseconds (1000 ms recommended maximum). */
    readonly deadlineMs: number;
    readonly initialBackoffMs: number;
    readonly maxBackoffMs: number;
}

/** Recommended maximum discovery window. */
export const DEFAULT_LOCATOR_CONFIG: SteamLocatorConfig = {
    deadlineMs: 1000,
    initialBackoffMs: 50,
    maxBackoffMs: 200,
};

export interface SteamClock {
    nowMs(): number;
}

export interface SteamSleeper {
    sleep(ms: number): Promise<void>;
}

const monotonicClock: SteamClock = {
    nowMs: () =>
        typeof performance !== "undefined" && typeof performance.now === "function"
            ? performance.now()
            : Date.now(),
};

const timerSleeper: SteamSleeper = {
    sleep: (ms) =>
        new Promise<void>((resolve) => {
            setTimeout(resolve, ms);
        }),
};

/**
 * Root selectors in preference order: stable semantic attributes first,
 * then the live-verified structural class token. The keyboard's
 * CSS-module classes carry the stable literal token `virtualkeyboard_` (the
 * mappings database lists 106 stable ids with that prefix) and the container
 * gains the literal "VirtualKeyboardVisible" class while shown — the on-device
 * scan located the container with exactly this case-insensitive match.
 * Opaque hashes are only ever corroborated by the
 * registry manager hook, never the sole locator.
 */
const KEYBOARD_ROOT_SELECTORS: readonly string[] = [
    '[data-virtualkeyboard="true"]',
    '[role="region"][aria-label="Virtual Keyboard"]',
    '[class*="virtualkeyboard" i]',
];

/** The literal visibility token driven by Valve's own show/hide calls. */
export const VK_VISIBLE_CLASS = "VirtualKeyboardVisible";

/** React 17/18 attach `__reactFiber$…` / `__reactContainer$…` own keys. */
const REACT_FIBER_KEY_PATTERN = /^__react(?:Fiber|Container)\$/;

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

export class SteamKeyboardLocator {
    private readonly registry: SteamWindowRegistry;

    constructor(
        private readonly config: SteamLocatorConfig = DEFAULT_LOCATOR_CONFIG,
        private readonly clock: SteamClock = monotonicClock,
        private readonly sleeper: SteamSleeper = timerSleeper,
        registry?: SteamWindowRegistry,
    ) {
        this.registry = registry ?? new SteamWindowRegistry();
    }

    /**
     * The Steam UI window the plugin runs in. A window qualifies when it
     * exposes one of the verified registry signatures (the `SteamUIStore`
     * global, or a plain `SteamUIWindows` array); anything else is reported
     * as unreachable instead of assumed.
     */
    locateWindow(): SteamWindowHandle | null {
        const document = (globalThis as { document?: Document }).document;
        if (document === undefined) {
            return null;
        }
        const win = document.defaultView ?? (globalThis as { window?: Window }).window;
        if (win === undefined || win === null) {
            return null;
        }
        const candidate = win as unknown as { SteamUIStore?: unknown; SteamUIWindows?: unknown };
        const hasStore = isObject(candidate.SteamUIStore);
        const hasWindowsArray = Array.isArray(candidate.SteamUIWindows);
        if (!hasStore && !hasWindowsArray) {
            return null;
        }
        return { token: "steam-ui-window", window: win, document };
    }

    /**
     * The first capability-checked per-window keyboard manager from the
     * registry. The old `window.VirtualKeyboardManager` global does
     * not exist on real Steam clients (live-probed); managers are per-window
     * objects inside the window store (capability checks apply in the
     * registry).
     */
    locateKeyboardManager(windowHandle: SteamWindowHandle): SteamVirtualKeyboardManager | null {
        void windowHandle;
        return this.registry.enumerate().entries[0]?.manager ?? null;
    }

    locateKeyboardDom(windowHandle: SteamWindowHandle): HTMLElement | null {
        return this.locateKeyboardDomIn(windowHandle.document);
    }

    /**
     * Keyboard DOM location in ANY window document: the keyboard
     * container is permanent in its host document and toggles visibility via
     * the verified "VirtualKeyboardVisible" class, so a document reference
     * resolved from a registry window instance is scanned the same way as
     * the plugin's own document.
     */
    locateKeyboardDomIn(document: Document): HTMLElement | null {
        for (const selector of KEYBOARD_ROOT_SELECTORS) {
            const element = document.querySelector<HTMLElement>(selector);
            if (element !== null) {
                return element;
            }
        }
        return null;
    }

    /** The live-verified visibility signature (literal class token). */
    isKeyboardVisible(keyboardDom: HTMLElement): boolean {
        return keyboardDom.classList.contains(VK_VISIBLE_CLASS);
    }

    /**
     * Typed representation of the React-managed keyboard component. The
     * fiber key is diagnostics-only; functionality never depends on it.
     */
    locateKeyboardComponent(dom: HTMLElement): SteamKeyboardComponent {
        let reactFiberKey: string | null = null;
        for (const key of Object.keys(dom)) {
            if (REACT_FIBER_KEY_PATTERN.test(key)) {
                reactFiberKey = key;
                break;
            }
        }
        return { rootElement: dom, reactFiberKey };
    }

    /**
     * Bounded discovery: immediate attempt, capped-backoff retries,
     * hard deadline. Resolves `null` when the deadline expires or the Steam
     * window is unreachable — never polls forever.
     */
    async discoverKeyboard(): Promise<SteamDiscoveryContext | null> {
        const windowHandle = this.locateWindow();
        if (windowHandle === null) {
            return null;
        }
        const startedAtMs = this.clock.nowMs();
        let backoffMs = this.config.initialBackoffMs;
        for (;;) {
            const dom = this.locateKeyboardDom(windowHandle);
            if (dom !== null) {
                return {
                    window: windowHandle,
                    manager: this.locateKeyboardManager(windowHandle),
                    keyboardDom: dom,
                    component: this.locateKeyboardComponent(dom),
                };
            }
            const elapsedMs = this.clock.nowMs() - startedAtMs;
            const remainingMs = this.config.deadlineMs - elapsedMs;
            if (remainingMs <= 0) {
                return null;
            }
            await this.sleeper.sleep(Math.min(backoffMs, remainingMs));
            backoffMs = Math.min(backoffMs * 2, this.config.maxBackoffMs);
        }
    }
}

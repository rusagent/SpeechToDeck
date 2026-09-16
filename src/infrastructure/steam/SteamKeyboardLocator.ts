/**
 * SteamKeyboardLocator (spec §17).
 *
 * Locates the active Steam window, the virtual keyboard manager and the
 * keyboard DOM. Discovery is strictly bounded: attempt immediately after a
 * keyboard-open notification, retry with a short capped backoff, and stop
 * after the configured deadline (recommended maximum 1000 ms). There is no
 * endless polling loop and no periodic scanning (§61); once found, the
 * lifecycle is observed event-driven through the §15 hooks.
 */

import type { SteamDiscoveryContext } from "./profiles/SteamKeyboardProfile";
import type {
    SteamKeyboardComponent,
    SteamVirtualKeyboardManager,
    SteamWindowHandle,
} from "./SteamInternalTypes";

export interface SteamLocatorConfig {
    /** Total discovery budget in milliseconds (spec §17: 1000 ms). */
    readonly deadlineMs: number;
    readonly initialBackoffMs: number;
    readonly maxBackoffMs: number;
}

/** Spec §17 recommended maximum discovery window. */
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
 * Root selectors in §60 preference order: stable semantic attributes first,
 * accessible label as fallback. Minified class names are never primary.
 */
const KEYBOARD_ROOT_SELECTORS: readonly string[] = [
    '[data-virtualkeyboard="true"]',
    '[role="region"][aria-label="Virtual Keyboard"]',
];

/** React 17/18 attach `__reactFiber$…` / `__reactContainer$…` own keys. */
const REACT_FIBER_KEY_PATTERN = /^__react(?:Fiber|Container)\$/;

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

export class SteamKeyboardLocator {
    constructor(
        private readonly config: SteamLocatorConfig = DEFAULT_LOCATOR_CONFIG,
        private readonly clock: SteamClock = monotonicClock,
        private readonly sleeper: SteamSleeper = timerSleeper,
    ) {}

    /**
     * The Steam UI window the plugin runs in. A window qualifies only when it
     * exposes the stable `SteamUIStore` global signature; anything else is
     * reported as unreachable instead of assumed (§57/§58.1).
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
        const signature = (win as unknown as { SteamUIStore?: unknown }).SteamUIStore;
        if (!isObject(signature)) {
            return null;
        }
        return { token: "steam-ui-window", window: win, document };
    }

    /**
     * The virtual keyboard manager, only after every consumed member passed a
     * capability check (§103/§104): object present, both lifecycle methods
     * exist and are callable.
     */
    locateKeyboardManager(windowHandle: SteamWindowHandle): SteamVirtualKeyboardManager | null {
        const candidate = (windowHandle.window as unknown as { VirtualKeyboardManager?: unknown })
            .VirtualKeyboardManager;
        if (!isObject(candidate)) {
            return null;
        }
        const visible = candidate["SetVirtualKeyboardVisible"];
        const hidden = candidate["SetVirtualKeyboardHidden"];
        if (typeof visible !== "function" || typeof hidden !== "function") {
            return null;
        }
        return candidate as unknown as SteamVirtualKeyboardManager;
    }

    locateKeyboardDom(windowHandle: SteamWindowHandle): HTMLElement | null {
        for (const selector of KEYBOARD_ROOT_SELECTORS) {
            const element = windowHandle.document.querySelector<HTMLElement>(selector);
            if (element !== null) {
                return element;
            }
        }
        return null;
    }

    /**
     * Typed representation of the React-managed keyboard component. The
     * fiber key is diagnostics-only; v1 functionality never depends on it.
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
     * Bounded discovery (§17): immediate attempt, capped-backoff retries,
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

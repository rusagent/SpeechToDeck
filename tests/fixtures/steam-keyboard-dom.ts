/**
 * Steam keyboard DOM fixtures (spec §89): models of known Steam keyboard
 * markup structures. These exercise the default compatibility profile's
 * multi-evidence locators — semantic attributes as primary evidence, roles
 * and structure as confirmation, minified classes only as decoration.
 *
 * The fixtures model the structure the profile matches; live Steam behavior
 * is validated separately on hardware (Phase-0 spikes) and intentionally not
 * claimed here.
 */

import { vi } from "vitest";

export type SteamManagerStub = ReturnType<typeof createManagerStub>;

interface SteamGlobalsWindow {
    SteamUIStore?: unknown;
    VirtualKeyboardManager?: unknown;
}

function steamGlobals(): SteamGlobalsWindow {
    return window as unknown as SteamGlobalsWindow;
}

/** A lifecycle manager double with typed, callable vi.fn methods. */
export function createManagerStub(): {
    SetVirtualKeyboardVisible: ReturnType<typeof vi.fn<(...args: unknown[]) => unknown>>;
    SetVirtualKeyboardHidden: ReturnType<typeof vi.fn<(...args: unknown[]) => unknown>>;
} {
    return {
        SetVirtualKeyboardVisible: vi.fn<(...args: unknown[]) => unknown>(),
        SetVirtualKeyboardHidden: vi.fn<(...args: unknown[]) => unknown>(),
    };
}

/** Installs the stable Steam window signature + lifecycle manager stub. */
export function installSteamWindowStubs(): {
    manager: ReturnType<typeof createManagerStub>;
    restore: () => void;
} {
    const manager = createManagerStub();
    const globals = steamGlobals();
    const previous = {
        SteamUIStore: globals.SteamUIStore,
        VirtualKeyboardManager: globals.VirtualKeyboardManager,
    };
    globals.SteamUIStore = {};
    globals.VirtualKeyboardManager = manager;
    return {
        manager,
        restore: () => {
            globals.SteamUIStore = previous.SteamUIStore;
            globals.VirtualKeyboardManager = previous.VirtualKeyboardManager;
        },
    };
}

export function removeSteamWindowSignature(): void {
    delete steamGlobals().SteamUIStore;
}

export interface KeyboardFixture {
    readonly root: HTMLElement;
    readonly steamChildren: readonly Element[];
    readonly pasteCalls: Element[];
    /** Input/keydown activity recorder at document level (typing evidence). */
    readonly typedEvents: string[];
    readonly detachTypingRecorder: () => void;
}

function attachTypingRecorder(): { typedEvents: string[]; detach: () => void } {
    const typedEvents: string[] = [];
    const recordKeyDown = (event: Event): void => {
        typedEvents.push(`keydown:${(event as KeyboardEvent).key ?? ""}`);
    };
    const recordInput = (event: Event): void => {
        typedEvents.push(`input:${(event as InputEvent).data ?? ""}`);
    };
    document.addEventListener("keydown", recordKeyDown, true);
    document.addEventListener("input", recordInput, true);
    return {
        typedEvents,
        detach: () => {
            document.removeEventListener("keydown", recordKeyDown, true);
            document.removeEventListener("input", recordInput, true);
        },
    };
}

/**
 * Supported keyboard structure: semantic root attribute, key controls, and a
 * button-role native paste action control.
 */
export function mountSupportedKeyboard(): KeyboardFixture {
    const root = document.createElement("div");
    root.setAttribute("data-virtualkeyboard", "true");
    root.setAttribute("role", "region");
    root.setAttribute("aria-label", "Virtual Keyboard");
    // Secondary corroboration only: the minified-style class is not decisive.
    root.className = "vk_1a2b3c virtualkeyboard-container";

    const keyA = document.createElement("div");
    keyA.setAttribute("data-vk-key", "a");
    keyA.setAttribute("role", "button");
    keyA.setAttribute("aria-label", "a");
    const keyB = document.createElement("div");
    keyB.setAttribute("data-vk-key", "b");
    keyB.setAttribute("role", "button");
    keyB.setAttribute("aria-label", "b");

    const actions = document.createElement("div");
    const pasteButton = document.createElement("button");
    pasteButton.type = "button";
    pasteButton.setAttribute("data-vk-action", "paste");
    pasteButton.setAttribute("role", "button");
    pasteButton.setAttribute("aria-label", "Paste");
    actions.appendChild(pasteButton);

    root.appendChild(keyA);
    root.appendChild(keyB);
    root.appendChild(actions);
    document.body.appendChild(root);

    const pasteCalls: Element[] = [];
    pasteButton.addEventListener("click", () => {
        pasteCalls.push(pasteButton);
    });

    const typing = attachTypingRecorder();
    return {
        root,
        steamChildren: [keyA, keyB, actions],
        pasteCalls,
        typedEvents: typing.typedEvents,
        detachTypingRecorder: typing.detach,
    };
}

/** Keyboard root with keys but no paste control: direct insert unavailable. */
export function mountKeyboardWithoutPaste(): KeyboardFixture {
    const root = document.createElement("div");
    root.setAttribute("data-virtualkeyboard", "true");
    const keyA = document.createElement("div");
    keyA.setAttribute("data-vk-key", "a");
    keyA.setAttribute("role", "button");
    root.appendChild(keyA);
    document.body.appendChild(root);

    const typing = attachTypingRecorder();
    return {
        root,
        steamChildren: [keyA],
        pasteCalls: [],
        typedEvents: typing.typedEvents,
        detachTypingRecorder: typing.detach,
    };
}

/** Unrelated markup: no keyboard signature at all. */
export function mountUnsupportedMarkup(): void {
    const alien = document.createElement("div");
    alien.className = "some_steam_panel";
    alien.setAttribute("role", "dialog");
    document.body.appendChild(alien);
}

export function clearKeyboardFixtures(): void {
    for (const node of [...document.body.children]) {
        node.remove();
    }
}

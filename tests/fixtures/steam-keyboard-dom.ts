/**
 * Steam keyboard DOM fixtures (spec §89): models of known Steam keyboard
 * markup structures. These exercise the default compatibility profile's
 * multi-evidence locators — semantic attributes as primary evidence, roles
 * and structure as confirmation, minified classes only as decoration.
 *
 * v0.1.6: the window stubs model the LIVE-VERIFIED SharedJSContext registry —
 * `SteamUIStore.m_WindowStore.m_mapAppWindows` holds per-window instances
 * exposing `m_VirtualKeyboardManager` + `m_BrowserWindow.document` (the dead
 * `window.VirtualKeyboardManager` global from the first adapter attempt is
 * gone: live probes proved it does not exist). A second fixture models the
 * verified real keyboard signature (`[class*="virtualkeyboard"]` token +
 * "VirtualKeyboardVisible" class + role=button key controls). Live Steam
 * behavior is validated separately on hardware and intentionally not claimed
 * here.
 */

import { vi } from "vitest";

export type SteamManagerStub = ReturnType<typeof createManagerStub>;

/** One registry window instance: the live-verified object shape. */
export interface SteamUiWindowInstanceStub {
    readonly WindowName: string;
    readonly m_VirtualKeyboardManager: SteamManagerStub;
    readonly m_BrowserWindow: { document: Document };
}

interface SteamGlobalsWindow {
    SteamUIStore?: unknown;
    SteamUIWindows?: unknown;
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

/**
 * Installs the verified registry signature: `SteamUIStore.m_WindowStore.
 * m_mapAppWindows` holds one window instance ("SP") whose
 * `m_BrowserWindow.document` is the test document, so the production
 * document-accessor chain resolves and mounts land in `document.body`.
 */
export function installSteamWindowStubs(): {
    manager: ReturnType<typeof createManagerStub>;
    instance: SteamUiWindowInstanceStub;
    restore: () => void;
} {
    const manager = createManagerStub();
    const globals = steamGlobals();
    const previous = {
        SteamUIStore: globals.SteamUIStore,
        SteamUIWindows: globals.SteamUIWindows,
        VirtualKeyboardManager: globals.VirtualKeyboardManager,
    };
    const instance: SteamUiWindowInstanceStub = {
        WindowName: "SP",
        m_VirtualKeyboardManager: manager,
        m_BrowserWindow: { document },
    };
    globals.SteamUIStore = {
        m_WindowStore: {
            m_mapAppWindows: new Map([[1, instance]]),
            m_mapDesiredWindows: new Map(),
            m_mapDesiredWindowInstances: new Map(),
            m_mapOverlayPopupByPID: new Map(),
            m_setSuppressedWindowTypes: new Set(),
        },
    };
    return {
        manager,
        instance,
        restore: () => {
            globals.SteamUIStore = previous.SteamUIStore;
            globals.SteamUIWindows = previous.SteamUIWindows;
            globals.VirtualKeyboardManager = previous.VirtualKeyboardManager;
        },
    };
}

export function removeSteamWindowSignature(): void {
    delete steamGlobals().SteamUIStore;
    delete steamGlobals().SteamUIWindows;
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

function buildKeyboardFixture(
    root: HTMLElement,
    steamChildren: Element[],
    pasteButton: HTMLButtonElement | null,
): KeyboardFixture {
    const pasteCalls: Element[] = [];
    if (pasteButton !== null) {
        pasteButton.addEventListener("click", () => {
            pasteCalls.push(pasteButton);
        });
    }
    const typing = attachTypingRecorder();
    return {
        root,
        steamChildren,
        pasteCalls,
        typedEvents: typing.typedEvents,
        detachTypingRecorder: typing.detach,
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

    return buildKeyboardFixture(root, [keyA, keyB, actions], pasteButton);
}

/**
 * The v0.1.6 live-verified real keyboard signature: hash-prefixed CSS-module
 * class token + literal "VirtualKeyboardVisible" visibility class, structural
 * key controls, no semantic attributes, no recognized paste control (matching
 * the on-device scan, where the paste mechanism is still unidentified).
 */
export function mountRealSignatureKeyboard(): KeyboardFixture {
    const root = document.createElement("div");
    root.className = "_2Ze6bsh7IKjSyQRmkzuxO3 VirtualKeyboardVisible Panel";

    const container = document.createElement("div");
    container.className = "_3Xy Panel virtualkeyboard_KeyRow_1a2b";
    const keyA = document.createElement("div");
    keyA.className = "virtualkeyboard_KeyboardKey_2KhPX";
    keyA.setAttribute("role", "button");
    keyA.setAttribute("aria-label", "a");
    container.appendChild(keyA);

    root.appendChild(container);
    document.body.appendChild(root);
    return buildKeyboardFixture(root, [container, keyA], null);
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

    return buildKeyboardFixture(root, [keyA], null);
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

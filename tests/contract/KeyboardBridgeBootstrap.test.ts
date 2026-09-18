/**
 * KeyboardBridgeBootstrap contract tests (v0.1.7, Task 5a).
 *
 * Decision points (owner-approved Task 5 coverage):
 * - the injected source is VALID JavaScript and self-installs in a window
 *   (new Function compile smoke + execution in jsdom);
 * - installation is IDEMPOTENT via `__stdKbBridgeLoaded` (the 30 s re-injection
 *   and SP document reloads must never double-install);
 * - exactly ONE mic host exists while the keyboard container is visible and
 *   none while hidden;
 * - presses queue capped events; focus capture + one-payload insertion deliver
 *   the COMPLETE text with exactly one input event (§2.2/§22);
 * - the poll expression reports the bridge facts and drains the event queue.
 *
 * jsdom limitation (documented): `document.execCommand` and layout are not
 * implemented, so the contenteditable insertion branch and fixed positioning
 * math are not exercised here — and jsdom's always-0 offsetWidth IS the
 * on-device CEF condition (v0.1.8): the host must mount on the class token
 * alone. Only the poll's `v`-field test stubs offsetWidth, because `v` still
 * reports it.
 */

import { beforeEach, describe, expect, it } from "vitest";

import {
    KEYBOARD_BRIDGE_BOOTSTRAP_SOURCE,
    buildInsertExpression,
    buildPollExpression,
    buildStateExpression,
    buildTeardownExpression,
} from "../../src/infrastructure/steam/keyboardBridgeBootstrap";

interface BridgeWindow {
    __stdKbBridgeLoaded?: boolean;
    __stdKbEvaluate?: (() => void) | null;
    __stdMicEvents?: Array<{ t: number; kind: string }>;
    __stdMicFocus?: { tag: string; path: number[] } | null;
    __stdMicInsert?: (text: string) => boolean;
    __stdMicState?: (state: string) => boolean;
    __stdMicTeardown?: () => boolean;
}

const bridgeWindow = window as unknown as BridgeWindow;

/** Compile smoke + execution: an invalid source throws here. */
function installBootstrap(): void {
    expect(() => new Function(KEYBOARD_BRIDGE_BOOTSTRAP_SOURCE)).not.toThrow();
    new Function(KEYBOARD_BRIDGE_BOOTSTRAP_SOURCE)();
}

/**
 * Visible container WITHOUT an offsetWidth stub by default: jsdom reports 0 —
 * exactly the on-device CEF condition, so the class token alone must mount.
 * Only callers that assert the poll's `v` field pass an offsetWidth.
 */
function makeVisibleContainer(offsetWidth?: number): HTMLElement {
    const container = document.createElement("div");
    container.className = "hash_VirtualKeyboard__a1b2 VirtualKeyboardVisible";
    if (offsetWidth !== undefined) {
        Object.defineProperty(container, "offsetWidth", { value: offsetWidth });
    }
    document.body.appendChild(container);
    return container;
}

async function flushObservers(): Promise<void> {
    for (let hop = 0; hop < 4; hop += 1) {
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
        });
    }
}

function micHost(): HTMLElement | null {
    return document.getElementById("std-mic-host");
}

beforeEach(() => {
    // jsdom persists across tests in this file: uninstall any live bootstrap
    // instance from a previous test FIRST (disconnects its observer and
    // listeners), then wipe the document and the window surface.
    bridgeWindow.__stdMicTeardown?.();
    document.body.innerHTML = "";
    document.head.innerHTML = "";
    delete bridgeWindow.__stdKbBridgeLoaded;
    delete bridgeWindow.__stdKbEvaluate;
    delete bridgeWindow.__stdMicEvents;
    delete bridgeWindow.__stdMicFocus;
    delete bridgeWindow.__stdMicInsert;
    delete bridgeWindow.__stdMicState;
    delete bridgeWindow.__stdMicTeardown;
});

describe("KeyboardBridgeBootstrap source validity and idempotency", () => {
    it("compiles as valid JavaScript and self-installs the window surface", () => {
        installBootstrap();
        expect(bridgeWindow.__stdKbBridgeLoaded).toBe(true);
        expect(bridgeWindow.__stdMicEvents).toEqual([]);
        expect(typeof bridgeWindow.__stdKbEvaluate).toBe("function");
        expect(typeof bridgeWindow.__stdMicInsert).toBe("function");
        expect(typeof bridgeWindow.__stdMicState).toBe("function");
        expect(typeof bridgeWindow.__stdMicTeardown).toBe("function");
    });

    it("is idempotent: a second injection never resets the queue or duplicates the style", () => {
        installBootstrap();
        bridgeWindow.__stdMicEvents?.push({ t: 1, kind: "press" });
        const sameQueue = bridgeWindow.__stdMicEvents;
        installBootstrap();
        expect(bridgeWindow.__stdKbBridgeLoaded).toBe(true);
        expect(bridgeWindow.__stdMicEvents).toBe(sameQueue);
        expect(bridgeWindow.__stdMicEvents).toHaveLength(1);
        expect(document.querySelectorAll("#std-mic-style")).toHaveLength(1);
    });
});

describe("KeyboardBridgeBootstrap mic host lifecycle", () => {
    it("mounts exactly one host while visible and removes it when hidden", async () => {
        installBootstrap();
        const container = makeVisibleContainer();
        await flushObservers();

        expect(micHost()).not.toBeNull();
        expect(micHost()?.getAttribute("role")).toBe("button");
        expect(micHost()?.getAttribute("tabindex")).toBe("0");
        expect(micHost()?.getAttribute("aria-label")).toBe("SpeechToDeck dictation");
        expect(micHost()?.getAttribute("aria-pressed")).toBe("false");
        await flushObservers(); // observer reactions must not duplicate the host
        expect(document.querySelectorAll("#std-mic-host")).toHaveLength(1);

        container.className = "hash_VirtualKeyboard__a1b2"; // hidden: token gone
        await flushObservers();
        expect(micHost()).toBeNull();
    });

    it("pushes the visual state as classes and aria-pressed", async () => {
        installBootstrap();
        makeVisibleContainer();
        await flushObservers();
        const host = micHost();
        expect(host).not.toBeNull();

        expect(bridgeWindow.__stdMicState?.("recording")).toBe(true);
        expect(host?.classList.contains("std-mic-recording")).toBe(true);
        expect(host?.getAttribute("aria-pressed")).toBe("true");

        expect(bridgeWindow.__stdMicState?.("error")).toBe(true);
        expect(host?.classList.contains("std-mic-error")).toBe(true);
        expect(host?.getAttribute("aria-pressed")).toBe("false");

        expect(bridgeWindow.__stdMicState?.("idle")).toBe(true);
        expect(host?.classList.contains("std-mic-idle")).toBe(true);
    });

    it("queues capped press events from click activation", async () => {
        installBootstrap();
        makeVisibleContainer();
        await flushObservers();
        const host = micHost();
        expect(host).not.toBeNull();

        for (let press = 0; press < 12; press += 1) {
            host?.dispatchEvent(new MouseEvent("click", { bubbles: true }));
        }
        expect(bridgeWindow.__stdMicEvents).toHaveLength(10);
        expect(bridgeWindow.__stdMicEvents?.every((event) => event.kind === "press")).toBe(true);
    });
});

describe("KeyboardBridgeBootstrap focus capture and one-payload insertion", () => {
    it("inserts the COMPLETE text through the native setter with exactly one input event", async () => {
        installBootstrap();
        const field = document.createElement("input");
        field.id = "field";
        document.body.appendChild(field);
        field.focus();

        makeVisibleContainer();
        await flushObservers(); // keyboard-visible snapshot captures the focused field
        expect(bridgeWindow.__stdMicFocus?.tag).toBe("INPUT");

        const inputEvents: unknown[] = [];
        field.addEventListener("input", (event) => {
            inputEvents.push(event);
        });

        expect(bridgeWindow.__stdMicInsert?.("Hallo, Welt!")).toBe(true);
        expect(field.value).toBe("Hallo, Welt!");
        expect(inputEvents).toHaveLength(1);
    });

    it("returns false instead of throwing when no editable is captured", () => {
        installBootstrap();
        expect(bridgeWindow.__stdMicInsert?.("orphan")).toBe(false);
        expect(bridgeWindow.__stdMicInsert?.("")).toBe(false);
    });

    it("uninstalls completely and allows a clean re-install", async () => {
        installBootstrap();
        makeVisibleContainer();
        await flushObservers();
        expect(micHost()).not.toBeNull();

        expect(bridgeWindow.__stdMicTeardown?.()).toBe(true);
        expect(bridgeWindow.__stdKbBridgeLoaded).toBe(false);
        expect(bridgeWindow.__stdKbEvaluate).toBeNull(); // §83: no stale evaluate handle
        expect(micHost()).toBeNull();
        expect(document.querySelectorAll("#std-mic-style")).toHaveLength(0);
        expect(bridgeWindow.__stdMicEvents).toEqual([]);

        installBootstrap(); // e.g. the plugin is re-enabled in the same SP session
        expect(bridgeWindow.__stdKbBridgeLoaded).toBe(true);
    });
});

describe("poll, insert and state expressions", () => {
    it("reports container, visibility and bootstrap flags and drains events", () => {
        const evaluate = (): { v: boolean; c: boolean; b: boolean; ev: unknown[]; f: boolean } =>
            JSON.parse(new Function(`return (${buildPollExpression()})`)() as string);

        const before = evaluate();
        expect(before).toEqual({ v: false, c: false, b: false, ev: [], f: false });

        installBootstrap();
        // The poll's `v` field still reports offsetWidth (its semantics are
        // unchanged in v0.1.8) — only here is a width stubbed.
        makeVisibleContainer(800);
        bridgeWindow.__stdMicEvents?.push({ t: 1, kind: "press" }, { t: 2, kind: "press" });

        const first = evaluate();
        expect(first.v).toBe(true);
        expect(first.c).toBe(true);
        expect(first.b).toBe(true);
        expect(first.ev).toHaveLength(2);
        // The expression runs __stdKbEvaluate BEFORE the JSON: the host mounts
        // synchronously here (the observer has not delivered yet), the §61
        // self-heal for a missed observer event.
        expect(micHost()).not.toBeNull();

        const second = evaluate();
        expect(second.ev).toEqual([]); // drained exactly once
    });

    it("carries the complete text through JSON escaping into __stdMicInsert", () => {
        const received: string[] = [];
        (window as unknown as Record<string, unknown>).__stdMicInsert = (text: string) => {
            received.push(text);
            return true;
        };
        const tricky = 'He said "hi"\nnew line \\ end';
        const value = new Function(`return (${buildInsertExpression(tricky)})`)();
        expect(value).toBe(true);
        expect(received).toEqual([tricky]);
    });

    it("builds state and teardown expressions that no-op safely without the bootstrap", () => {
        expect(new Function(`return (${buildStateExpression("recording")})`)()).toBeUndefined();
        expect(new Function(`return (${buildTeardownExpression()})`)()).toBeUndefined();
    });
});

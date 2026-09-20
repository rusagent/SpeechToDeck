/**
 * SteamKeyboardHostAdapter contract tests.
 *
 * Decision points: hook install preconditions fail closed; the mount
 * contract (plugin-owned node only, Steam children untouched, exact
 * cleanup); a fresh context id per keyboard appearance; repeated
 * open/close cycles restore everything (spike analogue in jsdom); and
 * exception containment at the Steam callback boundary.
 */

import { describe, expect, it, vi } from "vitest";
import { SteamKeyboardHostAdapter } from "../../src/infrastructure/steam/SteamKeyboardHostAdapter";
import type { MicrophoneControlProps } from "../../src/application/ports/KeyboardHostPort";
import { DictationError } from "../../src/domain/DictationError";
import { SteamKeyboardContextFactory } from "../../src/infrastructure/steam/SteamKeyboardContext";
import { fakeRenderer } from "./helpers";
import {
    clearKeyboardFixtures,
    installSteamWindowStubs,
    mountSupportedKeyboard,
    mountKeyboardWithoutPaste,
    mountRealSignatureKeyboard,
    mountUnsupportedMarkup,
    type KeyboardFixture,
    type SteamManagerStub,
} from "../fixtures/steam-keyboard-dom";

async function flushMicrotasks(): Promise<void> {
    for (let hop = 0; hop < 4; hop += 1) {
        await Promise.resolve();
    }
}

interface Harness {
    readonly stubs: { manager: SteamManagerStub; restore: () => void };
    fixture: KeyboardFixture | null;
}

function makeAdapter(): SteamKeyboardHostAdapter {
    const { renderer } = fakeRenderer();
    return new SteamKeyboardHostAdapter({
        renderer,
        contexts: new SteamKeyboardContextFactory({
            nextId: () => Math.random().toString(36).slice(2),
        }),
    });
}

/** Simulates Steam calling SetVirtualKeyboardVisible and its notification. */
async function openKeyboard(stubs: Harness["stubs"]): Promise<void> {
    stubs.manager.SetVirtualKeyboardVisible();
    await flushMicrotasks();
}

const MIC_PROPS: MicrophoneControlProps = {
    visible: true,
    active: false,
    busy: false,
    onPress: () => undefined,
};

function ownedNodes(): HTMLElement[] {
    return [...document.body.querySelectorAll<HTMLElement>("[data-speechtodeck-root]")];
}

describe("SteamKeyboardHostAdapter", () => {
    it("fails closed at start and leaves the manager untouched when Steam is missing", async () => {
        const stubs = installSteamWindowStubs();
        stubs.restore(); // removes the Steam window signature entirely
        const originalVisible = stubs.manager.SetVirtualKeyboardVisible;
        const adapter = makeAdapter();

        await expect(adapter.start()).rejects.toBeInstanceOf(DictationError);
        await expect(adapter.start()).rejects.toMatchObject({ code: "STEAM_KEYBOARD_NOT_FOUND" });
        expect(stubs.manager.SetVirtualKeyboardVisible).toBe(originalVisible); // not patched
    });

    it("mounts the mic into a plugin-owned node and keeps Steam children intact", async () => {
        const stubs = installSteamWindowStubs();
        const adapter = makeAdapter();
        const fixture = mountSupportedKeyboard();
        try {
            await adapter.start();
            adapter.mountMicrophoneControl(MIC_PROPS);

            const childrenBefore = fixture.steamChildren.map((child) => child.outerHTML);
            await openKeyboard(stubs);

            const nodes = ownedNodes();
            expect(nodes).toHaveLength(1);
            expect(nodes[0]!.parentElement).toBe(fixture.root); // appended into the keyboard root
            expect(fixture.root.lastElementChild).toBe(nodes[0]);
            expect(fixture.steamChildren.map((child) => child.outerHTML)).toEqual(childrenBefore);
            expect(adapter.currentContext()).toMatchObject({
                visible: true,
                // The context token comes from the registry window
                // entry (WindowName "SP"), not the plugin's own window.
                windowToken: "SP",
            });
        } finally {
            await adapter.stop();
            fixture.detachTypingRecorder();
            clearKeyboardFixtures();
            stubs.restore();
        }
    });

    it("emits opened/closed with a fresh context id per appearance", async () => {
        const stubs = installSteamWindowStubs();
        const adapter = makeAdapter();
        const fixture = mountSupportedKeyboard();
        const events: string[] = [];
        adapter.subscribe((event) => {
            events.push(
                event.type === "keyboard-opened"
                    ? `open:${event.context.id}`
                    : `close:${event.contextId}`,
            );
        });
        try {
            await adapter.start();
            await openKeyboard(stubs);
            stubs.manager.SetVirtualKeyboardHidden();
            await flushMicrotasks();
            await openKeyboard(stubs);

            expect(events).toHaveLength(3);
            const firstId = events[0]!.slice("open:".length);
            const closedId = events[1]!.slice("close:".length);
            const secondId = events[2]!.slice("open:".length);
            expect(firstId).toMatch(/^vk-/);
            expect(closedId).toBe(firstId);
            expect(secondId).not.toBe(firstId); // every appearance gets a new context

            // Repeat appearance with no intervening hidden notification: the
            // stale context is closed explicitly so the closed→opened
            // sequence stays complete (review note).
            await openKeyboard(stubs);
            expect(events).toHaveLength(5);
            expect(events[3]).toBe(`close:${secondId}`);
            const thirdId = events[4]!.slice("open:".length);
            expect(thirdId).not.toBe(secondId);
        } finally {
            await adapter.stop();
            fixture.detachTypingRecorder();
            clearKeyboardFixtures();
            stubs.restore();
        }
    });

    it("repeated open/close cycles keep cleanup exact (Spike A analogue, ×10)", async () => {
        const stubs = installSteamWindowStubs();
        const adapter = makeAdapter();
        const fixture = mountSupportedKeyboard();
        try {
            await adapter.start();
            adapter.mountMicrophoneControl(MIC_PROPS);
            for (let cycle = 0; cycle < 10; cycle += 1) {
                await openKeyboard(stubs);
                expect(ownedNodes()).toHaveLength(1);
                stubs.manager.SetVirtualKeyboardHidden();
                await flushMicrotasks();
                expect(ownedNodes()).toHaveLength(0); // only the owned node is removed
                expect(adapter.currentContext()).toBeNull();
            }
            expect(fixture.steamChildren).toHaveLength(3); // keyboard never damaged
            expect(fixture.root.querySelectorAll("*").length).toBeGreaterThan(0);
        } finally {
            await adapter.stop();
            fixture.detachTypingRecorder();
            clearKeyboardFixtures();
            stubs.restore();
        }
    });

    it("restores the original manager methods on stop; stop is idempotent", async () => {
        const stubs = installSteamWindowStubs();
        const originalVisible = stubs.manager.SetVirtualKeyboardVisible;
        const originalHidden = stubs.manager.SetVirtualKeyboardHidden;
        const adapter = makeAdapter();
        const fixture = mountSupportedKeyboard();
        try {
            await adapter.start();
            expect(stubs.manager.SetVirtualKeyboardVisible).not.toBe(originalVisible);
            expect(stubs.manager.SetVirtualKeyboardHidden).not.toBe(originalHidden);

            await adapter.stop();
            await adapter.stop(); // idempotency
            expect(stubs.manager.SetVirtualKeyboardVisible).toBe(originalVisible);
            expect(stubs.manager.SetVirtualKeyboardHidden).toBe(originalHidden);
            expect(adapter.currentContext()).toBeNull();
        } finally {
            await adapter.stop();
            fixture.detachTypingRecorder();
            clearKeyboardFixtures();
            stubs.restore();
        }
    });

    it("unsupported keyboard structure: no context, no mic mount, no throw", async () => {
        const stubs = installSteamWindowStubs();
        const { rendered, renderer } = fakeRenderer();
        const adapter = new SteamKeyboardHostAdapter({
            renderer,
            contexts: new SteamKeyboardContextFactory({ nextId: () => "x" }),
        });
        mountUnsupportedMarkup();
        const events: string[] = [];
        adapter.subscribe((event) => events.push(event.type));
        try {
            await adapter.start();
            adapter.mountMicrophoneControl(MIC_PROPS);
            await openKeyboard(stubs);

            expect(events).toEqual([]); // fail closed, no guess-and-continue
            expect(rendered).toHaveLength(0);
            expect(adapter.currentContext()).toBeNull();

            stubs.manager.SetVirtualKeyboardHidden();
            await flushMicrotasks();
            expect(events).toEqual([]);
        } finally {
            await adapter.stop();
            clearKeyboardFixtures();
            stubs.restore();
        }
    });

    it("keyboard without a recognized paste control still opens (clipboard-only path)", async () => {
        const stubs = installSteamWindowStubs();
        const adapter = makeAdapter();
        const fixture = mountKeyboardWithoutPaste();
        try {
            await adapter.start();
            await openKeyboard(stubs);
            expect(adapter.currentContext()).not.toBeNull();
            expect(
                adapter.getCurrentDiscovery()?.profile.locatePasteAction(fixture.root),
            ).toBeNull();
        } finally {
            await adapter.stop();
            fixture.detachTypingRecorder();
            clearKeyboardFixtures();
            stubs.restore();
        }
    });

    it("contains exceptions from renderer and listeners at the Steam boundary", async () => {
        const stubs = installSteamWindowStubs();
        const originalVisible = stubs.manager.SetVirtualKeyboardVisible;
        const brokenRenderer = {
            render: () => {
                throw new Error("renderer exploded");
            },
        };
        const adapter = new SteamKeyboardHostAdapter({
            renderer: brokenRenderer,
            contexts: new SteamKeyboardContextFactory({ nextId: () => "x" }),
        });
        const fixture = mountSupportedKeyboard();
        const listener = vi.fn(() => {
            throw new Error("listener exploded");
        });
        adapter.subscribe(listener);
        try {
            await adapter.start();
            adapter.mountMicrophoneControl(MIC_PROPS);
            // A throwing renderer/listener must not propagate into Steam UI
            // code; the opened event is still dispatched to other consumers.
            expect(() => stubs.manager.SetVirtualKeyboardVisible("arg-preserved")).not.toThrow();
            await flushMicrotasks();

            expect(listener).toHaveBeenCalledWith(
                expect.objectContaining({ type: "keyboard-opened" }),
            );
            expect(ownedNodes()).toHaveLength(0);
            expect(originalVisible).toHaveBeenCalledWith("arg-preserved"); // Steam's own method received its args
        } finally {
            await adapter.stop();
            fixture.detachTypingRecorder();
            clearKeyboardFixtures();
            stubs.restore();
        }
    });

    // ── registry-based mount (live-probe-driven redirect) ──

    it("mounts the live-verified real-signature keyboard via catch-up at start", async () => {
        const stubs = installSteamWindowStubs();
        const adapter = makeAdapter();
        // No manager call at all: the container is permanent in its document
        // and carries the "VirtualKeyboardVisible" class (verified signature),
        // so the start-time catch-up scan mounts without a show event.
        const fixture = mountRealSignatureKeyboard();
        try {
            await adapter.start();
            adapter.mountMicrophoneControl(MIC_PROPS);

            const nodes = ownedNodes();
            expect(nodes).toHaveLength(1);
            expect(nodes[0]!.parentElement).toBe(fixture.root);
            expect(adapter.currentContext()).toMatchObject({
                visible: true,
                windowToken: "SP",
            });
            expect(adapter.getDiagnostics()).toMatchObject({
                registryFound: true,
                managersHooked: 1,
                keyboardSignatureSeen: true,
                documentResolved: true,
                reason: null,
            });
        } finally {
            await adapter.stop();
            fixture.detachTypingRecorder();
            clearKeyboardFixtures();
            stubs.restore();
        }
    });

    it("catch-up heals a transient instance that appeared after start (missed show event)", async () => {
        const stubs = installSteamWindowStubs();
        // Model the live probe: with the keyboard closed the maps exist but
        // the transient window instance is gone.
        (window as unknown as { SteamUIStore: unknown }).SteamUIStore = {
            m_WindowStore: {
                m_mapAppWindows: new Map(),
                m_mapDesiredWindows: new Map(),
                m_mapDesiredWindowInstances: new Map(),
                m_mapOverlayPopupByPID: new Map(),
                m_setSuppressedWindowTypes: new Set(),
            },
        };
        const adapter = makeAdapter();
        let fixture: KeyboardFixture | null = null;
        try {
            await adapter.start();
            adapter.mountMicrophoneControl(MIC_PROPS);
            expect(adapter.currentContext()).toBeNull();
            expect(adapter.getDiagnostics()).toMatchObject({
                registryFound: true,
                managersHooked: 0,
                reason: "manager-not-found",
            });

            // The user opens the keyboard: the transient instance appears and
            // the visible keyboard DOM mounts into the document; the poll /
            // refresh catches up and hooks the late instance.
            fixture = mountRealSignatureKeyboard();
            const store = (
                window as unknown as {
                    SteamUIStore: { m_WindowStore: { m_mapAppWindows: Map<number, unknown> } };
                }
            ).SteamUIStore.m_WindowStore;
            store.m_mapAppWindows.set(1, stubs.instance);
            adapter.refreshRegistry();
            await flushMicrotasks();

            expect(ownedNodes()).toHaveLength(1);
            expect(adapter.currentContext()).not.toBeNull();
            expect(adapter.getDiagnostics()).toMatchObject({
                managersHooked: 1,
                keyboardSignatureSeen: true,
                reason: null,
            });
        } finally {
            await adapter.stop();
            fixture?.detachTypingRecorder();
            clearKeyboardFixtures();
            stubs.restore();
        }
    });

    it("catch-up closes a context whose keyboard went hidden without a hide event", async () => {
        const stubs = installSteamWindowStubs();
        const adapter = makeAdapter();
        const fixture = mountRealSignatureKeyboard();
        const events: string[] = [];
        adapter.subscribe((event) =>
            events.push(event.type === "keyboard-opened" ? "open" : "close"),
        );
        try {
            await adapter.start();
            adapter.mountMicrophoneControl(MIC_PROPS);
            expect(adapter.currentContext()).not.toBeNull();

            // The keyboard hides without the adapter observing a hide call
            // (e.g. the instance appeared after the show): the verified
            // visibility class is the ground truth.
            fixture.root.classList.remove("VirtualKeyboardVisible");
            adapter.refreshRegistry();
            await flushMicrotasks();

            expect(events).toEqual(["open", "close"]);
            expect(adapter.currentContext()).toBeNull();
            expect(ownedNodes()).toHaveLength(0);
        } finally {
            await adapter.stop();
            fixture.detachTypingRecorder();
            clearKeyboardFixtures();
            stubs.restore();
        }
    });

    it("reports signature-not-found while the registry and manager are usable but no keyboard DOM exists", async () => {
        const stubs = installSteamWindowStubs();
        const adapter = makeAdapter();
        try {
            await adapter.start();
            expect(adapter.currentContext()).toBeNull();
            expect(adapter.getDiagnostics()).toMatchObject({
                registryFound: true,
                managersHooked: 1,
                keyboardSignatureSeen: false,
                documentResolved: true,
                reason: "signature-not-found",
            });
        } finally {
            await adapter.stop();
            clearKeyboardFixtures();
            stubs.restore();
        }
    });
});

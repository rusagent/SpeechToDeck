/**
 * SteamKeyboardHostAdapter contract tests (spec §13-§18, §89, §105/§106).
 *
 * Decision points: §104 hook preconditions fail closed; the §18 mount
 * contract (plugin-owned node only, Steam children untouched, exact
 * cleanup); a fresh context id per keyboard appearance (§7.2); repeated
 * open/close cycles restore everything (Spike A analogue in jsdom); and §106
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
    return [...document.body.querySelectorAll<HTMLElement>("[data-decky-voice-keyboard-root]")];
}

describe("SteamKeyboardHostAdapter", () => {
    it("fails closed at start and leaves the manager untouched when Steam is missing", async () => {
        const stubs = installSteamWindowStubs();
        stubs.restore(); // removes the Steam window signature entirely
        const originalVisible = stubs.manager.SetVirtualKeyboardVisible;
        const adapter = makeAdapter();

        await expect(adapter.start()).rejects.toBeInstanceOf(DictationError);
        await expect(adapter.start()).rejects.toMatchObject({ code: "STEAM_KEYBOARD_NOT_FOUND" });
        expect(stubs.manager.SetVirtualKeyboardVisible).toBe(originalVisible); // not patched (§104)
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
                windowToken: "steam-ui-window",
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
            expect(secondId).not.toBe(firstId); // every appearance gets a new context (§7.2)
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
                expect(ownedNodes()).toHaveLength(0); // only the owned node is removed (§18)
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
            await adapter.stop(); // §83 idempotency
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

            expect(events).toEqual([]); // fail closed, no guess-and-continue (§89)
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

    it("contains exceptions from renderer and listeners at the Steam boundary (§106)", async () => {
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
});

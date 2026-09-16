/**
 * SteamPasteActionAdapter contract tests (spec §26/§28 Candidate A): paste
 * discovery via the profile, exactly the native paste control activation,
 * no character typing ever, and fail-closed on context mismatch or missing
 * mechanism.
 */

import { describe, expect, it } from "vitest";
import { SteamPasteActionAdapter } from "../../src/infrastructure/steam/SteamPasteActionAdapter";
import type {
    SteamKeyboardDiscovery,
    SteamKeyboardDiscoveryProvider,
} from "../../src/infrastructure/steam/SteamKeyboardHostAdapter";
import { DefaultSteamKeyboardProfile } from "../../src/infrastructure/steam/profiles";
import { DictationError } from "../../src/domain/DictationError";
import {
    clearKeyboardFixtures,
    createManagerStub,
    installSteamWindowStubs,
    mountSupportedKeyboard,
} from "../fixtures/steam-keyboard-dom";

function providerOf(discovery: SteamKeyboardDiscovery | null): SteamKeyboardDiscoveryProvider {
    return { getCurrentDiscovery: () => discovery };
}

describe("SteamPasteActionAdapter", () => {
    it("probes available on the fixture and invokes the native paste control once", async () => {
        const stubs = installSteamWindowStubs();
        const fixture = mountSupportedKeyboard();
        const discovery: SteamKeyboardDiscovery = {
            contextId: "vk-1-abc",
            window: { token: "steam-ui-window", window, document },
            manager: stubs.manager,
            keyboardDom: fixture.root,
            component: null,
            profile: {
                id: "fixture",
                matches: () => true,
                locateMountPoint: (keyboard) => keyboard,
                locatePasteAction: (keyboard) =>
                    DefaultSteamKeyboardProfile.locatePasteAction(keyboard),
            },
        };
        const adapter = new SteamPasteActionAdapter(providerOf(discovery));
        const context = { id: "vk-1-abc", windowToken: "steam-ui-window", visible: true };
        try {
            expect(await adapter.probe(context)).toEqual({ available: true });

            await adapter.invokePaste(context);

            expect(fixture.pasteCalls).toHaveLength(1); // exactly one native paste
            expect(fixture.typedEvents).toEqual([]); // never types characters (§26)
        } finally {
            fixture.detachTypingRecorder();
            clearKeyboardFixtures();
            stubs.restore();
        }
    });

    it("fails closed on a context mismatch without invoking anything", async () => {
        const stubs = installSteamWindowStubs();
        const fixture = mountSupportedKeyboard();
        const discovery: SteamKeyboardDiscovery = {
            contextId: "vk-1-abc",
            window: { token: "steam-ui-window", window, document },
            manager: stubs.manager,
            keyboardDom: fixture.root,
            component: null,
            profile: DefaultSteamKeyboardProfile,
        };
        const adapter = new SteamPasteActionAdapter(providerOf(discovery));
        try {
            await expect(
                adapter.invokePaste({ id: "vk-2-other", windowToken: "t", visible: true }),
            ).rejects.toMatchObject({ code: "KEYBOARD_CONTEXT_CHANGED" });
            await expect(
                adapter.probe({ id: "vk-2-other", windowToken: "t", visible: true }),
            ).resolves.toEqual({
                available: false,
            });
            expect(fixture.pasteCalls).toHaveLength(0);
        } finally {
            fixture.detachTypingRecorder();
            clearKeyboardFixtures();
            stubs.restore();
        }
    });

    it("reports PASTE_ACTION_UNAVAILABLE when the profile finds no paste mechanism", async () => {
        const discovery: SteamKeyboardDiscovery = {
            contextId: "vk-1-abc",
            window: { token: "steam-ui-window", window, document },
            manager: createManagerStub(),
            keyboardDom: document.createElement("div"),
            component: null,
            profile: {
                id: "no-paste",
                matches: () => true,
                locateMountPoint: (keyboard) => keyboard,
                locatePasteAction: () => null,
            },
        };
        const adapter = new SteamPasteActionAdapter(providerOf(discovery));
        const context = { id: "vk-1-abc", windowToken: "steam-ui-window", visible: true };
        expect(await adapter.probe(context)).toEqual({ available: false });
        await expect(adapter.invokePaste(context)).rejects.toBeInstanceOf(DictationError);
        await expect(adapter.invokePaste(context)).rejects.toMatchObject({
            code: "PASTE_ACTION_UNAVAILABLE",
        });
    });
});

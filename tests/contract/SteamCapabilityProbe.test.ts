/**
 * SteamCapabilityProbe contract tests (spec §58): the checklist is reported
 * honestly per fixture state, fails closed on unsupported structures, and
 * never modifies user text (clipboard write is never invoked by probing).
 */

import { describe, expect, it, vi } from "vitest";
import { SteamCapabilityProbe } from "../../src/infrastructure/steam/SteamCapabilityProbe";
import {
    clearKeyboardFixtures,
    installSteamWindowStubs,
    mountSupportedKeyboard,
    mountKeyboardWithoutPaste,
    mountUnsupportedMarkup,
} from "../fixtures/steam-keyboard-dom";

function stubClipboard(writeText: unknown): { restore: () => void } {
    const previous = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", {
        value: { writeText },
        configurable: true,
    });
    return {
        restore: () => {
            if (previous === undefined) {
                // @ts-expect-error test cleanup of a test-installed property
                delete navigator.clipboard;
            } else {
                Object.defineProperty(navigator, "clipboard", previous);
            }
        },
    };
}

describe("SteamCapabilityProbe", () => {
    it("reports the full §58 checklist as usable on the supported fixture", () => {
        const stubs = installSteamWindowStubs();
        const writeText = vi.fn();
        const clipboard = stubClipboard(writeText);
        const fixture = mountSupportedKeyboard();
        try {
            const report = new SteamCapabilityProbe().probe();
            expect(report).toEqual({
                windowReachable: true,
                managerRecognizable: true,
                keyboardSignatureSupported: true,
                clipboardUsable: true,
                nativePasteRecognized: true,
                supported: true,
                profileId: "steam-vk-semantic-v1",
            });
            // §58: capability detection never modifies user text.
            expect(writeText).not.toHaveBeenCalled();
            expect(fixture.pasteCalls).toHaveLength(0);
        } finally {
            fixture.detachTypingRecorder();
            clearKeyboardFixtures();
            clipboard.restore();
            stubs.restore();
        }
    });

    it("reports degraded capability when the paste control is absent", () => {
        const stubs = installSteamWindowStubs();
        const clipboard = stubClipboard(vi.fn());
        const fixture = mountKeyboardWithoutPaste();
        try {
            const report = new SteamCapabilityProbe().probe();
            expect(report.keyboardSignatureSupported).toBe(true);
            expect(report.nativePasteRecognized).toBe(false);
            expect(report.clipboardUsable).toBe(true);
            expect(report.supported).toBe(true);
        } finally {
            fixture.detachTypingRecorder();
            clearKeyboardFixtures();
            clipboard.restore();
            stubs.restore();
        }
    });

    it("fails closed with unsupported:false on unrelated markup and no clipboard API", () => {
        const stubs = installSteamWindowStubs();
        const clipboard = stubClipboard(undefined); // no write mechanism
        mountUnsupportedMarkup();
        try {
            const report = new SteamCapabilityProbe().probe();
            expect(report).toMatchObject({
                windowReachable: true,
                managerRecognizable: true,
                keyboardSignatureSupported: false,
                clipboardUsable: false,
                nativePasteRecognized: false,
                supported: false,
                profileId: null,
            });
        } finally {
            clearKeyboardFixtures();
            clipboard.restore();
            stubs.restore();
        }
    });
});

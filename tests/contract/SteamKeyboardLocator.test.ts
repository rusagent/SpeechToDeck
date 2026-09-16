/**
 * SteamKeyboardLocator contract tests (spec §17/§60).
 *
 * Decision points: Steam window signature requirement (fail closed),
 * multi-evidence DOM detection on the fixture model, and the bounded
 * discovery budget — no endless polling loop (§17/§61).
 */

import { describe, expect, it } from "vitest";
import { SteamKeyboardLocator } from "../../src/infrastructure/steam/SteamKeyboardLocator";
import { DefaultSteamKeyboardProfile } from "../../src/infrastructure/steam/profiles";
import {
    clearKeyboardFixtures,
    installSteamWindowStubs,
    mountSupportedKeyboard,
    mountUnsupportedMarkup,
    removeSteamWindowSignature,
} from "../fixtures/steam-keyboard-dom";

function instantSleeper() {
    const delays: number[] = [];
    return {
        delays,
        sleeper: {
            sleep: async (ms: number) => {
                delays.push(ms);
            },
        },
    };
}

describe("SteamKeyboardLocator", () => {
    it("requires the stable Steam window signature before reporting a window", async () => {
        const stubs = installSteamWindowStubs();
        removeSteamWindowSignature();
        const { delays, sleeper } = instantSleeper();
        try {
            const locator = new SteamKeyboardLocator(undefined, undefined, sleeper);
            expect(locator.locateWindow()).toBeNull();
            expect(await locator.discoverKeyboard()).toBeNull();
            expect(delays).toEqual([]); // no polling without a Steam window
        } finally {
            clearKeyboardFixtures();
            stubs.restore();
        }
    });

    it("detects the supported fixture keyboard via multi-evidence profile match", async () => {
        const stubs = installSteamWindowStubs();
        const fixture = mountSupportedKeyboard();
        try {
            const locator = new SteamKeyboardLocator();
            const discovery = await locator.discoverKeyboard();

            expect(discovery).not.toBeNull();
            expect(discovery?.manager).not.toBeNull();
            expect(discovery?.keyboardDom).toBe(fixture.root);
            expect(DefaultSteamKeyboardProfile.matches(discovery!)).toBe(true);
            expect(DefaultSteamKeyboardProfile.locatePasteAction(fixture.root)).not.toBeNull();
        } finally {
            fixture.detachTypingRecorder();
            clearKeyboardFixtures();
            stubs.restore();
        }
    });

    it("does not match unrelated markup and stays null when no keyboard exists", async () => {
        const stubs = installSteamWindowStubs();
        const { sleeper } = instantSleeper();
        mountUnsupportedMarkup();
        try {
            const locator = new SteamKeyboardLocator(undefined, undefined, sleeper);
            const discovery = await locator.discoverKeyboard();
            expect(discovery).toBeNull(); // no primary semantic attribute anywhere
        } finally {
            clearKeyboardFixtures();
            stubs.restore();
        }
    });

    it("discovery attempts immediately when the keyboard is already present", async () => {
        const stubs = installSteamWindowStubs();
        const fixture = mountSupportedKeyboard();
        const { delays, sleeper } = instantSleeper();
        try {
            const locator = new SteamKeyboardLocator(undefined, undefined, sleeper);
            expect(await locator.discoverKeyboard()).not.toBeNull();
            expect(delays).toEqual([]);
        } finally {
            fixture.detachTypingRecorder();
            clearKeyboardFixtures();
            stubs.restore();
        }
    });

    it("retries with capped backoff and stops at the deadline, never polling forever", async () => {
        const stubs = installSteamWindowStubs();
        const { delays, sleeper } = instantSleeper();
        let nowMs = 0;
        const clock = { nowMs: () => nowMs };
        try {
            const locator = new SteamKeyboardLocator(
                { deadlineMs: 1000, initialBackoffMs: 50, maxBackoffMs: 200 },
                clock,
                sleeper,
            );
            const promise = locator.discoverKeyboard();
            // Each sleep advances the fake clock until the budget is spent.
            const drain = async (): Promise<void> => {
                for (let hop = 0; hop < 50; hop += 1) {
                    nowMs += 60;
                    await Promise.resolve();
                }
            };
            const [result] = await Promise.all([promise, drain()]);

            expect(result).toBeNull();
            expect(delays.length).toBeLessThan(25); // bounded attempts, no endless loop
            expect(delays.length).toBeGreaterThan(1); // bounded retries happened
            const totalSlept = delays.reduce((sum, ms) => sum + ms, 0);
            expect(delays.every((ms) => ms <= 200)).toBe(true); // capped backoff
            expect(delays[0]).toBe(50); // §17: immediate attempt, then short backoff
            expect(totalSlept).toBeGreaterThan(0);
        } finally {
            clearKeyboardFixtures();
            stubs.restore();
        }
    });
});

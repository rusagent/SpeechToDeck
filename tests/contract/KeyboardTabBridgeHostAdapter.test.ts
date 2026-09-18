/**
 * SteamKeyboardTabBridgeHostAdapter contract tests (v0.1.7, Task 3/5).
 *
 * Decision points (owner-approved Task 5 coverage):
 * - poll visibility reaches consumers as keyboard-opened/keyboard-closed port
 *   events (the controller's existing §13 subscription stays authoritative);
 * - the §75-true model visual maps onto the in-window __stdMicState pushes
 *   (recording → recording, error → error, everything else → idle);
 * - the §58-shaped diagnostics mapping degrades the capability honestly
 *   (reason null only when transport + bootstrap + container are all proven);
 * - stop tears the in-window surface down and rejects later mounts (§83).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SteamKeyboardTabBridgeHostAdapter } from "../../src/infrastructure/steam/KeyboardTabBridgeHostAdapter";

interface PollPayloadShape {
    v: boolean;
    c: boolean;
    b: boolean;
    ev: Array<{ t: number; kind: string }>;
    f: boolean;
}

function createAdapterHarness() {
    const calls: { tab: string; runAsync: boolean; code: string }[] = [];
    let nextPoll: PollPayloadShape = { v: false, c: true, b: true, ev: [], f: false };
    const presses: number[] = [];
    const adapter = new SteamKeyboardTabBridgeHostAdapter({
        executor: async (tab, runAsync, code) => {
            calls.push({ tab, runAsync, code });
            // The poll expression references __stdKbBridgeLoaded too (the b
            // flag) — the poll shape must be matched first. v0.1.8: the poll
            // leads with the §61 __stdKbEvaluate self-heal call, so match on
            // the JSON.stringify({ payload wrapper, not the prefix.
            if (code.includes("JSON.stringify({")) {
                return { success: true, result: JSON.stringify(nextPoll) };
            }
            if (code.includes("__stdKbBridgeLoaded")) {
                return { success: true, result: true };
            }
            return { success: true, result: true };
        },
        onPress: () => {
            presses.push(presses.length + 1);
        },
    });
    return {
        adapter,
        calls,
        presses,
        setNextPoll(payload: PollPayloadShape): void {
            nextPoll = payload;
        },
    };
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("SteamKeyboardTabBridgeHostAdapter port events", () => {
    it("forwards poll visibility as keyboard-opened/keyboard-closed (§13)", async () => {
        const harness = createAdapterHarness();
        const events: string[] = [];
        harness.adapter.subscribe((event) => {
            events.push(event.type);
        });
        await harness.adapter.start();

        harness.setNextPoll({ v: true, c: true, b: true, ev: [], f: false });
        await vi.advanceTimersByTimeAsync(250);
        harness.setNextPoll({ v: false, c: true, b: true, ev: [], f: false });
        await vi.advanceTimersByTimeAsync(250);

        expect(events).toEqual(["keyboard-opened", "keyboard-closed"]);
        expect(harness.adapter.currentContext()).toBeNull();

        harness.adapter.dispose();
    });

    it("drains press events to the press callback", async () => {
        const harness = createAdapterHarness();
        await harness.adapter.start();
        harness.setNextPoll({
            v: true,
            c: true,
            b: true,
            ev: [{ t: 1, kind: "press" }],
            f: false,
        });
        await vi.advanceTimersByTimeAsync(250);
        expect(harness.presses).toEqual([1]);
        await harness.adapter.stop();
    });
});

describe("SteamKeyboardTabBridgeHostAdapter microphone control (§75 mapping)", () => {
    it("pushes the exact §75-true visual into the keyboard document", async () => {
        const harness = createAdapterHarness();
        await harness.adapter.start();
        harness.calls.length = 0;

        const mount = harness.adapter.mountMicrophoneControl({
            visible: true,
            active: false,
            busy: true,
            visual: "recording",
            onPress: () => undefined,
        });
        harness.adapter.mountMicrophoneControl({
            visible: true,
            active: false,
            busy: false,
            visual: "processing",
            onPress: () => undefined,
        });
        harness.adapter.mountMicrophoneControl({
            visible: true,
            active: false,
            busy: false,
            visual: "error",
            onPress: () => undefined,
        });
        mount.dispose();

        const stateCalls = harness.calls.filter((call) => call.code.includes("__stdMicState"));
        expect(stateCalls.map((call) => call.code)).toEqual([
            'window.__stdMicState && window.__stdMicState("recording")',
            'window.__stdMicState && window.__stdMicState("idle")', // processing → not active (§75)
            'window.__stdMicState && window.__stdMicState("error")',
            'window.__stdMicState && window.__stdMicState("idle")', // mount disposed → neutral
        ]);
        await harness.adapter.stop();
    });

    it("rejects mounts after stop (§83)", async () => {
        const harness = createAdapterHarness();
        await harness.adapter.start();
        await harness.adapter.stop();
        harness.calls.length = 0;

        const mount = harness.adapter.mountMicrophoneControl({
            visible: true,
            active: false,
            busy: false,
            visual: "error",
            onPress: () => undefined,
        });
        mount.dispose();
        expect(harness.calls).toEqual([]);
    });
});

describe("SteamKeyboardTabBridgeHostAdapter diagnostics (§57/§105)", () => {
    it("claims the hook only when transport, bootstrap and container are proven", async () => {
        const harness = createAdapterHarness();
        await harness.adapter.start();

        expect(harness.adapter.getDiagnostics()).toEqual({
            registryFound: true,
            managersHooked: 0,
            keyboardSignatureSeen: true,
            documentResolved: true,
            reason: null,
        });
        expect(harness.adapter.getBridgeDiagnostics()).toEqual({
            injected: true,
            keyboardSeen: true,
            pressChannelLive: true,
            reason: null,
        });
        await harness.adapter.stop();
    });

    it("degrades with sp-target-not-found when the transport never succeeds", async () => {
        const failing = new SteamKeyboardTabBridgeHostAdapter({
            executor: () => Promise.reject(new Error("down")),
            onPress: () => undefined,
        });
        await failing.start();
        expect(failing.getDiagnostics().reason).toBe("sp-target-not-found");
        expect(failing.getBridgeDiagnostics().keyboardSeen).toBe(false);
        await failing.stop();
    });

    it("degrades separately when the bootstrap flag is not read back", async () => {
        const harness = createAdapterHarness();
        harness.setNextPoll({ v: false, c: true, b: false, ev: [], f: false });
        await harness.adapter.start();
        expect(harness.adapter.getDiagnostics().reason).toBe("bridge-not-injected");
        expect(harness.adapter.getBridgeDiagnostics().injected).toBe(false);
        await harness.adapter.stop();
    });
});

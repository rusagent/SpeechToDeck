/**
 * KeyboardTabBridge contract tests (v0.1.7, Task 5b/5d).
 *
 * Decision points (owner-approved Task 5 coverage):
 * - the poll loop drains press events to the press callback (two presses in
 *   one batch → two callbacks; the §10 machine deduplicates downstream);
 * - visibility drives the keyboard context lifecycle with a FRESH context id
 *   per appearance (§7.2);
 * - the capability facts are observed, never assumed (§57): transport round
 *   trip, in-window bootstrap flag, container presence;
 * - executor failures drive a BOUNDED exponential backoff, and a context
 *   whose document stays unreachable is closed (§12 stays truthful);
 * - insertion/state/teardown operations are contained and fail as values.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
    KeyboardTabBridge,
    parsePollPayload,
} from "../../src/infrastructure/steam/KeyboardTabBridge";
import type {
    KeyboardTabBridgeOptions,
    TabExecutionResult,
    TabExecutor,
} from "../../src/infrastructure/steam/KeyboardTabBridge";
import type { KeyboardContext } from "../../src/domain/DictationSession";
import { FakeIdGenerator } from "../frontend/fakes/FakeIdGenerator";
import { SteamKeyboardContextFactory } from "../../src/infrastructure/steam/SteamKeyboardContext";

interface RecordedCall {
    readonly tab: string;
    readonly runAsync: boolean;
    readonly code: string;
    /** Fake-timer Date.now() at invocation — the backoff assertions read these. */
    readonly at: number;
}

interface PollPayloadShape {
    v: boolean;
    c: boolean;
    b: boolean;
    ev: Array<{ t: number; kind: string }>;
    f: boolean;
}

class ScriptedTransport {
    readonly calls: RecordedCall[] = [];
    /** Swappable behavior; the bridge keeps calling the stable `executor`. */
    impl: TabExecutor;

    constructor(handler: (call: RecordedCall) => TabExecutionResult) {
        this.impl = async (tab, runAsync, code) => handler({ tab, runAsync, code, at: 0 });
    }

    /** Makes every subsequent call throw (loader transport outage). */
    failAll(): void {
        this.impl = () => Promise.reject(new Error("transport down"));
    }

    executor: TabExecutor = async (tab, runAsync, code) => {
        const call = { tab, runAsync, code, at: Date.now() };
        this.calls.push(call);
        return this.impl(tab, runAsync, code);
    };
}

function isPoll(call: RecordedCall): boolean {
    // The poll leads with the __stdKbEvaluate self-heal call (§61, v0.1.8) and
    // wraps the payload in JSON.stringify — no other expression contains both.
    return call.code.includes("JSON.stringify({");
}

function isInjection(call: RecordedCall): boolean {
    // The poll expression ALSO references __stdKbBridgeLoaded (the b flag),
    // so the poll shape must be tested first.
    return !isPoll(call) && call.code.includes("__stdKbBridgeLoaded");
}

function pollPayloadWith(payload: PollPayloadShape): TabExecutionResult {
    return { success: true, result: JSON.stringify(payload) };
}

interface BridgeHarness {
    transport: ScriptedTransport;
    bridge: KeyboardTabBridge;
    presses: number[];
    opened: KeyboardContext[];
    closed: string[];
    setNextPoll(payload: PollPayloadShape): void;
}

function createHarness(overrides?: {
    backoffBaseMs?: number;
    backoffMaxMs?: number;
    isEnabled?: () => boolean;
}): BridgeHarness {
    const presses: number[] = [];
    const opened: KeyboardContext[] = [];
    const closed: string[] = [];
    let nextPoll: PollPayloadShape = { v: false, c: true, b: true, ev: [], f: false };
    const transport = new ScriptedTransport((call) => {
        if (isPoll(call)) {
            return pollPayloadWith(nextPoll);
        }
        if (isInjection(call)) {
            return { success: true, result: true };
        }
        return { success: true, result: true };
    });
    const options: KeyboardTabBridgeOptions = {
        executor: transport.executor,
        onPress: () => {
            presses.push(presses.length + 1);
        },
        onKeyboardOpened: (context) => {
            opened.push(context);
        },
        onKeyboardClosed: (contextId) => {
            closed.push(contextId);
        },
        contexts: new SteamKeyboardContextFactory(new FakeIdGenerator()),
    };
    if (overrides?.backoffBaseMs !== undefined) {
        options.backoffBaseMs = overrides.backoffBaseMs;
    }
    if (overrides?.backoffMaxMs !== undefined) {
        options.backoffMaxMs = overrides.backoffMaxMs;
    }
    if (overrides?.isEnabled !== undefined) {
        options.isEnabled = overrides.isEnabled;
    }
    const bridge = new KeyboardTabBridge(options);
    return {
        transport,
        bridge,
        presses,
        opened,
        closed,
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

describe("KeyboardTabBridge capability facts (§57 observed, never assumed)", () => {
    it("settles transport, bootstrap and container facts with the first poll", async () => {
        const harness = createHarness();
        await harness.bridge.start();
        await vi.advanceTimersByTimeAsync(0);

        const facts = harness.bridge.getFacts();
        expect(facts.transportOk).toBe(true);
        expect(facts.bootstrapInjected).toBe(true);
        expect(facts.keyboardSeen).toBe(true);
        expect(facts.reason).toBeNull();
        await harness.bridge.stop();
    });

    it("reports sp-target-not-found while no round trip has succeeded", async () => {
        const harness = createHarness();
        harness.transport.failAll();
        await harness.bridge.start();
        expect(harness.bridge.getFacts().reason).toBe("sp-target-not-found");
        expect(harness.bridge.getFacts().transportOk).toBe(false);
        await harness.bridge.stop();
    });

    it("requires the in-window flag before claiming the bootstrap (bridge-not-injected)", async () => {
        const harness = createHarness();
        harness.setNextPoll({ v: false, c: true, b: false, ev: [], f: false });
        await harness.bridge.start();

        const facts = harness.bridge.getFacts();
        expect(facts.transportOk).toBe(true);
        expect(facts.bootstrapInjected).toBe(false);
        expect(facts.reason).toBe("bridge-not-injected");
        await harness.bridge.stop();
    });
});

describe("KeyboardTabBridge press channel and keyboard lifecycle", () => {
    it("drains every queued press in one poll batch", async () => {
        const harness = createHarness();
        await harness.bridge.start();
        harness.setNextPoll({
            v: false,
            c: true,
            b: true,
            ev: [
                { t: 1, kind: "press" },
                { t: 2, kind: "press" },
            ],
            f: false,
        });
        await vi.advanceTimersByTimeAsync(250);
        expect(harness.presses).toEqual([1, 2]);
        await harness.bridge.stop();
    });

    it("creates a fresh context per appearance and closes it on v:false (§7.2)", async () => {
        const harness = createHarness();
        await harness.bridge.start();
        expect(harness.bridge.currentContext()).toBeNull();

        harness.setNextPoll({ v: true, c: true, b: true, ev: [], f: false });
        await vi.advanceTimersByTimeAsync(250);
        expect(harness.opened).toHaveLength(1);
        expect(harness.bridge.currentContext()?.id).toBe(harness.opened[0]?.id);
        expect(harness.bridge.currentContext()?.visible).toBe(true);

        harness.setNextPoll({ v: false, c: true, b: true, ev: [], f: false });
        await vi.advanceTimersByTimeAsync(250);
        expect(harness.closed).toEqual([harness.opened[0]?.id]);
        expect(harness.bridge.currentContext()).toBeNull();

        harness.setNextPoll({ v: true, c: true, b: true, ev: [], f: false });
        await vi.advanceTimersByTimeAsync(250);
        expect(harness.opened).toHaveLength(2);
        expect(harness.opened[1]?.id).not.toBe(harness.opened[0]?.id);
        await harness.bridge.stop();
    });

    it("does not poll while the plugin is disabled", async () => {
        const harness = createHarness({ isEnabled: () => false });
        await harness.bridge.start();
        await vi.advanceTimersByTimeAsync(1000);
        expect(harness.transport.calls).toHaveLength(0);
        expect(harness.bridge.getFacts().reason).toBe("sp-target-not-found");
        await harness.bridge.stop();
    });
});

describe("KeyboardTabBridge poll-driven self-heal (§61, v0.1.8 on-device regression)", () => {
    it("mounts the mic host and OPENS the context through one real inject+poll tick while offsetWidth stays 0", async () => {
        // REAL in-tab evaluation: the fake executeInTab transport evaluates
        // every code string against the jsdom document. jsdom's offsetWidth is
        // always 0 — the exact on-device CEF condition — so a mounted host AND
        // an opened context prove the class-token visibility decision end to
        // end through the engine (inject → poll expression → __stdKbEvaluate →
        // ensureHost → v:true → context lifecycle).
        const container = document.createElement("div");
        container.className = "hash_VirtualKeyboard__a1b2 VirtualKeyboardVisible";
        document.body.appendChild(container);

        const opened: KeyboardContext[] = [];
        const executor: TabExecutor = async (tab, runAsync, code) => {
            expect(tab).toBe("Steam Big Picture Mode");
            expect(runAsync).toBe(false);
            // eval, not new Function: the completion value IS the payload
            // contract (Runtime.evaluate semantics; new Function returns
            // undefined for the bootstrap IIFE and the poll statements).
            return { success: true, result: eval(code) };
        };
        const bridge = new KeyboardTabBridge({
            executor,
            onPress: () => undefined,
            onKeyboardOpened: (context) => {
                opened.push(context);
            },
            onKeyboardClosed: () => undefined,
            contexts: new SteamKeyboardContextFactory(new FakeIdGenerator()),
        });

        await bridge.start();
        await vi.advanceTimersByTimeAsync(0);

        expect(bridge.getFacts().bootstrapInjected).toBe(true);
        expect(document.getElementById("std-mic-host")).not.toBeNull();
        // The poll's `v` gate trusts the class token alone (offsetWidth 0): the
        // context opens on the first tick — pre-fix this stayed v:false and the
        // context never opened on device.
        expect(opened).toHaveLength(1);
        expect(bridge.currentContext()?.id).toBe(opened[0]?.id);
        expect(bridge.currentContext()?.visible).toBe(true);

        await bridge.stop(); // pushes the real in-window teardown through the executor
        document.body.innerHTML = "";
        const residue = window as unknown as Record<string, unknown>;
        for (const key of [
            "__stdKbBridgeLoaded",
            "__stdKbEvaluate",
            "__stdMicEvents",
            "__stdMicFocus",
            "__stdMicInsert",
            "__stdMicPaste",
            "__stdMicState",
            "__stdMicTeardown",
        ]) {
            delete residue[key];
        }
    });
});

describe("KeyboardTabBridge transport failure containment (§106/§61)", () => {
    it("backs off boundedly after failures instead of tight error loops", async () => {
        const harness = createHarness({ backoffBaseMs: 500, backoffMaxMs: 2000 });
        harness.transport.failAll();
        await harness.bridge.start();
        const stamps = harness.transport.calls.map((call) => call.at);
        expect(stamps).toHaveLength(1); // t=0: inject attempt failed, gate until 500

        await vi.advanceTimersByTimeAsync(250); // t=250: still inside the gate
        expect(harness.transport.calls).toHaveLength(1);

        await vi.advanceTimersByTimeAsync(250); // t=500: gate passed, retry fails, gate until 1500
        expect(harness.transport.calls).toHaveLength(2);

        await vi.advanceTimersByTimeAsync(999); // t=1499: exponential window held
        expect(harness.transport.calls).toHaveLength(2);

        await vi.advanceTimersByTimeAsync(1); // t=1500: retry fails, cap reached (gate 2000)
        expect(harness.transport.calls).toHaveLength(3);

        // Bounded: over the next minute the retries respect the 2000 ms cap.
        const beforeMinute = harness.transport.calls.length;
        await vi.advanceTimersByTimeAsync(60_000);
        const growth = harness.transport.calls.length - beforeMinute;
        expect(growth).toBeGreaterThanOrEqual(20); // it keeps retrying
        expect(growth).toBeLessThanOrEqual(31); // never tighter than the cap
        await harness.bridge.stop();
    });

    it("closes an open context after sustained transport failure (§12 stays truthful)", async () => {
        const harness = createHarness({ backoffBaseMs: 10, backoffMaxMs: 20 });
        await harness.bridge.start();

        harness.setNextPoll({ v: true, c: true, b: true, ev: [], f: false });
        await vi.advanceTimersByTimeAsync(250);
        expect(harness.opened).toHaveLength(1);

        harness.transport.failAll();
        await vi.advanceTimersByTimeAsync(1250); // four consecutive failed ticks
        expect(harness.closed).toEqual([harness.opened[0]?.id]);
        expect(harness.bridge.currentContext()).toBeNull();
        await harness.bridge.stop();
    });

    it("counts a malformed poll payload as transport failure, not evidence", async () => {
        let rawResult: unknown = { success: true, result: "not-json" };
        const presses: number[] = [];
        const transport = new ScriptedTransport((call) => {
            if (isInjection(call)) {
                return { success: true, result: true };
            }
            if (isPoll(call)) {
                return rawResult as TabExecutionResult;
            }
            return { success: true, result: true };
        });
        const bridge = new KeyboardTabBridge({
            executor: transport.executor,
            onPress: () => {
                presses.push(1);
            },
            onKeyboardOpened: () => undefined,
            onKeyboardClosed: () => undefined,
        });
        await bridge.start();

        // The inject round trip succeeded (transportOk is sticky), but the
        // malformed poll result must NOT be absorbed as bridge evidence.
        expect(bridge.getFacts().bootstrapInjected).toBe(false);
        expect(bridge.getFacts().keyboardSeen).toBe(false);
        rawResult = { success: false, result: "tab not found" };
        await vi.advanceTimersByTimeAsync(2000);
        expect(bridge.getFacts().bootstrapInjected).toBe(false);
        expect(bridge.getFacts().pressesSeen).toBe(0);
        expect(presses).toEqual([]);
        await bridge.stop();
    });
});

describe("KeyboardTabBridge insertion and visual operations", () => {
    it("inserts only when the in-window call reports success", async () => {
        const harness = createHarness();
        await harness.bridge.start();

        harness.transport.calls.length = 0;
        let insertResult: TabExecutionResult = { success: true, result: true };
        harness.transport.impl = async (tab, runAsync, code) => {
            if (code.includes("__stdMicInsert")) {
                return insertResult;
            }
            void tab;
            void runAsync;
            return { success: true, result: true };
        };

        expect(await harness.bridge.insertText("Hallo")).toBe(true);
        insertResult = { success: true, result: false };
        expect(await harness.bridge.insertText("Hallo")).toBe(false);
        insertResult = { success: false, result: null };
        expect(await harness.bridge.insertText("Hallo")).toBe(false);

        const insertCalls = harness.transport.calls.filter((call) =>
            call.code.includes("__stdMicInsert"),
        );
        expect(insertCalls.every((call) => call.tab === "Steam Big Picture Mode")).toBe(true);
        expect(insertCalls[0]?.code).toBe('window.__stdMicInsert("Hallo")');
        await harness.bridge.stop();
    });

    it("maps insert failures and rejections to false and pushes state fire-and-forget", async () => {
        const harness = createHarness();
        await harness.bridge.start();
        harness.transport.calls.length = 0;
        harness.transport.impl = async (_tab, _runAsync, code) => {
            if (code.includes("__stdMicInsert")) {
                throw new Error("transport down");
            }
            return { success: true, result: true };
        };

        expect(await harness.bridge.insertText("Hallo")).toBe(false);
        harness.bridge.pushState("recording");
        await vi.advanceTimersByTimeAsync(0);
        expect(
            harness.transport.calls.some(
                (call) => call.code === 'window.__stdMicState && window.__stdMicState("recording")',
            ),
        ).toBe(true);
        await harness.bridge.stop();
    });

    it("sends the full in-window teardown on stop (§83) exactly once", async () => {
        const harness = createHarness();
        await harness.bridge.start();
        await harness.bridge.stop();
        // The bootstrap SOURCE defines __stdMicTeardown — match the invocation
        // expression, not the definition.
        const teardowns = harness.transport.calls.filter((call) =>
            call.code.startsWith("window.__stdMicTeardown"),
        );
        expect(teardowns).toHaveLength(1);
        const callsAfterStop = harness.transport.calls.length;
        await vi.advanceTimersByTimeAsync(1000);
        expect(harness.transport.calls.length).toBe(callsAfterStop); // loop is down
        await harness.bridge.stop(); // idempotent
    });
});

describe("parsePollPayload boundary guard (§99)", () => {
    it("accepts only the exact bridge payload shape", () => {
        expect(parsePollPayload(42)).toBeNull();
        expect(parsePollPayload("not json")).toBeNull();
        expect(parsePollPayload("{}")).toBeNull();
        expect(
            parsePollPayload(
                '{"v":true,"c":true,"b":true,"f":false,"ev":[{"t":1,"kind":"press"}]}',
            ),
        ).toEqual({
            v: true,
            c: true,
            b: true,
            f: false,
            ev: [{ t: 1, kind: "press" }],
        });
        expect(parsePollPayload('{"v":"yes","c":true,"b":true,"f":false,"ev":[]}')).toBeNull();
        expect(
            parsePollPayload('{"v":true,"c":true,"b":true,"f":false,"ev":[{"t":1,"kind":2}]}'),
        ).toEqual({ v: true, c: true, b: true, f: false, ev: [] });
    });
});

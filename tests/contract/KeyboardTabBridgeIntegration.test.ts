/**
 * KeyboardTabBridge INTEGRATION test (validation requirement).
 *
 * The full press → transcript → insert sequence through the REAL
 * DictationController, the REAL KeyboardTabBridge engine, the REAL host
 * adapter, the REAL composite inserter and the REAL presenter — with only the
 * `executeInTab` transport faked. Decision points:
 * - a bridge press starts the existing controller session (existing press
 *   semantics, no new state machine path);
 * - the transcript reaches the keyboard document as ONE `__stdMicInsert`
 *   payload, complete and exactly once, with the fallback
 *   never touched;
 * - v:false mid-transcription suppresses insertion and RETAINS the
 *   transcript;
 * - double presses in one batch are deduplicated by the existing machine.
 *
 * Offline fake-path evidence: the transport is a fake; on-device behavior is
 * covered by the on-device evidence chain.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DictationController } from "../../src/application/DictationController";
import { KeyboardBridgeInserter } from "../../src/infrastructure/steam/KeyboardBridgeInserter";
import { SteamKeyboardTabBridgeHostAdapter } from "../../src/infrastructure/steam/KeyboardTabBridgeHostAdapter";
import type { TabExecutor } from "../../src/infrastructure/steam/KeyboardTabBridge";
import { FakeBulkTextInserter } from "../frontend/fakes/FakeBulkTextInserter";
import { FakeClock } from "../frontend/fakes/FakeClock";
import { FakeIdGenerator } from "../frontend/fakes/FakeIdGenerator";
import { FakeSettingsPort } from "../frontend/fakes/FakeSettingsPort";
import { FakeSpeechPort } from "../frontend/fakes/FakeSpeechPort";
import { MicrophoneControlPresenter } from "../../src/presentation/keyboard/MicrophoneButtonMount";

const INSERT_PREFIX = "window.__stdMicInsert(";
const SP_CONTEXT_PREFIX = "vk-1-"; // first SteamKeyboardContextFactory sequence

interface BridgeSimulationState {
    visible: boolean;
    events: Array<{ t: number; kind: string }>;
    inserts: string[];
    states: string[];
    teardowns: number;
}

function createRig() {
    const state: BridgeSimulationState = {
        visible: false,
        events: [],
        inserts: [],
        states: [],
        teardowns: 0,
    };

    const executor: TabExecutor = async (tab, runAsync, code) => {
        expect(tab).toBe("Steam Big Picture Mode");
        expect(runAsync).toBe(false);
        // The poll wraps its payload in JSON.stringify({ (after the
        // __stdKbEvaluate self-heal call) — match the poll shape FIRST, it
        // also references __stdKbBridgeLoaded (the b flag).
        if (code.includes("JSON.stringify({")) {
            return {
                success: true,
                result: JSON.stringify({
                    v: state.visible,
                    c: true,
                    b: true,
                    ev: state.events.splice(0, 9),
                    f: false,
                }),
            };
        }
        if (code.includes("__stdKbBridgeLoaded")) {
            return { success: true, result: true }; // bootstrap injection
        }
        if (code.includes(INSERT_PREFIX)) {
            state.inserts.push(code);
            return { success: true, result: true };
        }
        if (code.includes("__stdMicState(")) {
            state.states.push(code);
            return { success: true, result: true };
        }
        if (code.includes("__stdMicTeardown")) {
            state.teardowns += 1;
            return { success: true, result: true };
        }
        return { success: true, result: true };
    };

    const speech = new FakeSpeechPort();
    const settings = new FakeSettingsPort();
    const fallback = new FakeBulkTextInserter();

    let controller: DictationController | null = null;
    const adapter = new SteamKeyboardTabBridgeHostAdapter({
        executor,
        onPress: () => {
            void controller?.handleMicrophonePressed();
        },
        isEnabled: () => {
            const snapshot = controller?.getSnapshot();
            return !(snapshot?.kind === "unavailable" && snapshot.reason === "PLUGIN_DISABLED");
        },
    });
    const inserter = new KeyboardBridgeInserter(adapter.bridge, fallback);
    controller = new DictationController(
        speech,
        adapter,
        inserter,
        settings,
        new FakeClock(),
        new FakeIdGenerator(),
    );
    const presenter = new MicrophoneControlPresenter(controller, adapter, () => {
        void controller?.handleMicrophonePressed();
    });

    /** Flush microtask chains and pending 0-ms timers deterministically. */
    const settle = async (): Promise<void> => {
        for (let hop = 0; hop < 6; hop += 1) {
            await vi.advanceTimersByTimeAsync(1);
        }
    };

    return { state, speech, settings, fallback, adapter, presenter, controller, settle };
}

beforeEach(() => {
    vi.useFakeTimers();
});

afterEach(() => {
    vi.useRealTimers();
});

describe("tab bridge end to end (press → transcript → insert)", () => {
    it("reaches ready with proven bridge facts and pushes the neutral visual", async () => {
        const rig = createRig();
        rig.presenter.start();
        await rig.controller.start();
        expect(rig.controller.getSnapshot().kind).toBe("ready"); // keyboardHookAvailable proven
        expect(rig.state.states).toEqual([
            'window.__stdMicState && window.__stdMicState("idle")', // presenter mount on ready
        ]);
        expect(rig.adapter.bridge.currentContext()).toBeNull(); // keyboard hidden at boot
        await rig.controller.dispose();
        await rig.adapter.stop();
    });

    it("delivers the complete transcript as exactly one __stdMicInsert payload", async () => {
        const rig = createRig();
        rig.presenter.start();
        await rig.controller.start();

        // Open the keyboard and press the in-window button.
        rig.state.visible = true;
        rig.state.events.push({ t: Date.now(), kind: "press" });
        await vi.advanceTimersByTimeAsync(250);
        await rig.settle();
        expect(rig.controller.getSnapshot().kind).toBe("starting");
        rig.speech.resolveStart("id-1");
        await rig.settle();
        expect(rig.controller.getSnapshot().kind).toBe("recording");
        expect(rig.state.states).toContain(
            'window.__stdMicState && window.__stdMicState("recording")', // after the start ack
        );

        // Second press stops; the stop ack moves to transcribing.
        rig.state.events.push({ t: Date.now(), kind: "press" });
        await vi.advanceTimersByTimeAsync(250);
        await rig.settle();
        rig.speech.resolveStop("id-1");
        await rig.settle();
        expect(rig.controller.getSnapshot().kind).toBe("transcribing");

        // transcript_ready flows through the existing effects into ONE payload.
        rig.speech.emitTranscript("id-1", "Hallo, Welt!");
        await rig.settle();

        expect(rig.state.inserts).toEqual(['window.__stdMicInsert("Hallo, Welt!")']);
        expect(rig.fallback.insertCalls).toEqual([]); // fallback untouched
        expect(rig.controller.getSnapshot().kind).toBe("ready");
        expect(rig.state.states).toContain('window.__stdMicState && window.__stdMicState("idle")');
        expect(rig.adapter.bridge.currentContext()?.id.startsWith(SP_CONTEXT_PREFIX)).toBe(true);

        await rig.controller.dispose();
        await rig.adapter.stop();
    });

    it("suppresses insertion and retains the transcript when v:false arrives mid-transcription", async () => {
        const rig = createRig();
        rig.presenter.start();
        await rig.controller.start();

        rig.state.visible = true;
        rig.state.events.push({ t: Date.now(), kind: "press" });
        await vi.advanceTimersByTimeAsync(250);
        await rig.settle();
        rig.speech.resolveStart("id-1");
        await rig.settle();

        rig.state.events.push({ t: Date.now(), kind: "press" });
        await vi.advanceTimersByTimeAsync(250);
        await rig.settle();
        rig.speech.resolveStop("id-1");
        await rig.settle();
        expect(rig.controller.getSnapshot().kind).toBe("transcribing");
        const insertsBefore = rig.state.inserts.length;

        rig.state.visible = false; // keyboard closed before the result arrives
        await vi.advanceTimersByTimeAsync(250);
        await rig.settle();

        rig.speech.emitTranscript("id-1", "zu spät");
        await rig.settle();

        expect(rig.state.inserts).toHaveLength(insertsBefore); // no insert attempted
        expect(rig.fallback.insertCalls).toEqual([]);
        expect(rig.controller.getSnapshot().kind).toBe("ready");
        expect(rig.controller.getLastSuppressedTranscript()).toBe("zu spät");
        await rig.controller.dispose();
        await rig.adapter.stop();
    });

    it("deduplicates two presses arriving in one poll batch (machine unchanged)", async () => {
        const rig = createRig();
        rig.presenter.start();
        await rig.controller.start();

        rig.state.visible = true;
        rig.state.events.push({ t: Date.now(), kind: "press" }, { t: Date.now(), kind: "press" });
        await vi.advanceTimersByTimeAsync(250);
        await rig.settle();

        expect(rig.speech.startCalls).toEqual(["id-1"]); // one session, no stop queued
        expect(rig.speech.stopCalls).toEqual([]);
        expect(rig.controller.getSnapshot().kind).toBe("starting");

        await rig.controller.dispose();
        await rig.adapter.stop();
    });

    it("uninstalls the in-window bridge exactly once on teardown", async () => {
        const rig = createRig();
        rig.presenter.start();
        await rig.controller.start();
        await rig.controller.dispose();
        await rig.adapter.stop();
        expect(rig.state.teardowns).toBe(1);
        await rig.adapter.stop(); // idempotent
        expect(rig.state.teardowns).toBe(1);
    });
});

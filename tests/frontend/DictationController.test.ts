/**
 * DictationController behavioral tests.
 *
 * All infrastructure is in-memory fakes; no network and no microphone. The
 * oracle is the product contract: acknowledgements gate the active indicator,
 * stale results are never injected, suppression follows keyboard-context
 * loss, and validation governs empty speech and oversized input. (The
 * recording cap was removed — recordings are unlimited on the FE side; the
 * former watchdog suite went with it.)
 */

import { describe, expect, it } from "vitest";

import { DictationController } from "../../src/application/DictationController";
import type { StartupTimerSeam } from "../../src/application/DictationController";
import type { SpeechCapabilities } from "../../src/application/ports/SpeechPort";
import { DictationError, MAX_TRANSCRIPT_UTF8_BYTES } from "../../src/domain/DictationError";
import { Deferred } from "../../src/shared/Deferred";
import { Logger, nullSink } from "../../src/shared/Logger";
import { FakeBulkTextInserter } from "./fakes/FakeBulkTextInserter";
import { FakeClock } from "./fakes/FakeClock";
import { FakeIdGenerator } from "./fakes/FakeIdGenerator";
import { FakeKeyboardHost } from "./fakes/FakeKeyboardHost";
import { FakeSettingsPort } from "./fakes/FakeSettingsPort";
import { ALL_CAPABILITIES, FakeSpeechPort } from "./fakes/FakeSpeechPort";
import {
    createTestRig,
    flush,
    startRecording,
    startReady,
    startTranscribing,
    type TestRig,
} from "./fakes/TestRig";

describe("startup", () => {
    it("reaches ready and probes insertion against the open context", async () => {
        const rig = createTestRig();
        rig.keyboard.open();
        await rig.controller.start();

        expect(rig.controller.getSnapshot().kind).toBe("ready");
        expect(rig.trace).toContain("keyboard.start");
        expect(rig.trace).toContain("speech.initialize");
        expect(rig.inserter.probeCalls).toEqual([rig.keyboard.currentContext()?.id]);
    });

    it("installs the keyboard hook before initializing speech (hook never waits for the model)", async () => {
        const rig = createTestRig();
        rig.keyboard.open();
        await rig.controller.start();

        const hookIndex = rig.trace.indexOf("keyboard.start");
        const speechIndex = rig.trace.indexOf("speech.initialize");
        expect(hookIndex).toBeGreaterThanOrEqual(0);
        expect(speechIndex).toBeGreaterThan(hookIndex);
    });

    it("reports SETTINGS_LOAD_FAILED when settings cannot load", async () => {
        const rig = createTestRig();
        rig.settings.loadError = new Error("boom");
        await rig.controller.start();

        expect(rig.controller.getSnapshot()).toEqual({
            kind: "unavailable",
            reason: "SETTINGS_LOAD_FAILED",
        });
        expect(rig.trace).not.toContain("speech.initialize");
    });

    it("keeps starting the runtime when the keyboard hook fails (QAM decoupling)", async () => {
        // The QAM flow has no keyboard-hook dependency: a failed hook leaves
        // the in-keyboard button dormant and degrades through the hook
        // diagnostics — it never blocks the dictation flow.
        const rig = createTestRig();
        rig.keyboard.startError = new Error("no hook");
        rig.keyboard.open();
        await rig.controller.start();

        expect(rig.controller.getSnapshot().kind).toBe("ready");
        expect(rig.trace).toContain("keyboard.start");
        expect(rig.trace).toContain("speech.initialize");
    });

    it("keeps the flow ready while keyboard hook diagnostics degrade (QAM decoupling)", async () => {
        // Honesty stays in the capability report (keyboardHookAvailable
        // still derives from the host's hook diagnostics); the flow gate no
        // longer consumes it — keyboard facets never make dictation
        // unavailable.
        const degraded = createTestRig();
        degraded.keyboard.diagnostics = {
            registryFound: true,
            managersHooked: 0,
            keyboardSignatureSeen: false,
            documentResolved: false,
            reason: "manager-not-found",
        };
        degraded.keyboard.open();
        await degraded.controller.start();
        expect(degraded.controller.getSnapshot().kind).toBe("ready");

        // A fully available hook report also keeps the plugin ready.
        const healthy = createTestRig();
        healthy.keyboard.diagnostics = {
            registryFound: true,
            managersHooked: 1,
            keyboardSignatureSeen: true,
            documentResolved: true,
            reason: null,
        };
        healthy.keyboard.open();
        await healthy.controller.start();
        expect(healthy.controller.getSnapshot().kind).toBe("ready");
    });

    it("reports SPEECH_RUNTIME_UNAVAILABLE when initialize fails", async () => {
        const rig = createTestRig();
        rig.speech.initializeError = new Error("daemon down");
        rig.keyboard.open();
        await rig.controller.start();

        expect(rig.controller.getSnapshot()).toEqual({
            kind: "unavailable",
            reason: "SPEECH_RUNTIME_UNAVAILABLE",
        });
    });

    it("reports PLUGIN_DISABLED through the capability report when settings disable the plugin", async () => {
        const rig = createTestRig({ enabled: false });
        rig.keyboard.open();
        await rig.controller.start();

        expect(rig.controller.getSnapshot()).toEqual({
            kind: "unavailable",
            reason: "PLUGIN_DISABLED",
        });
    });
});

describe("happy path (flow, one-shot insertion)", () => {
    it("press → acknowledged recording → stop → transcript → single insertion → ready", async () => {
        const rig = createTestRig();
        await startReady(rig);
        const contextId = rig.keyboard.currentContext()?.id;

        const sessionId = await startRecording(rig);
        expect(rig.speech.startCalls).toEqual([sessionId]);

        await rig.controller.handleMicrophonePressed();
        await flush();
        expect(rig.controller.getSnapshot().kind).toBe("stopping");
        rig.speech.resolveStop(sessionId);
        await flush();
        expect(rig.controller.getSnapshot().kind).toBe("transcribing");

        rig.inserter.insertGate = new Deferred<void>();
        rig.speech.emitTranscript(sessionId, "hello world");
        await flush();
        expect(rig.controller.getSnapshot()).toMatchObject({
            kind: "inserting",
            transcript: "hello world",
        });

        rig.inserter.releaseInsert();
        await flush();
        expect(rig.controller.getSnapshot().kind).toBe("ready");
        expect(rig.inserter.insertCalls).toEqual([{ contextId, text: "hello world" }]);
    });

    it("ignores a press when no keyboard context exists", async () => {
        const rig = createTestRig();
        await rig.controller.start(); // startup with no keyboard context opened

        await rig.controller.handleMicrophonePressed();
        await flush();

        expect(rig.controller.getSnapshot().kind).toBe("ready");
        expect(rig.speech.startCalls).toEqual([]);
    });
});

describe("duplicate presses while pending", () => {
    it("does not start parallel recordings and queues no stop", async () => {
        const rig = createTestRig();
        await startReady(rig);

        await rig.controller.handleMicrophonePressed();
        await flush();
        expect(rig.controller.getSnapshot().kind).toBe("starting");

        await rig.controller.handleMicrophonePressed();
        await rig.controller.handleMicrophonePressed();
        await flush();

        expect(rig.speech.startCalls).toHaveLength(1);
        expect(rig.speech.stopCalls).toEqual([]);
        expect(rig.controller.getSnapshot().kind).toBe("starting");

        rig.speech.resolveStart("id-1");
        await flush();
        expect(rig.controller.getSnapshot().kind).toBe("recording");
    });
});

describe("stale session handling", () => {
    it("discards a transcript whose session no longer matches", async () => {
        const rig = createTestRig();
        await startReady(rig);
        const sessionId = await startRecording(rig);

        await rig.controller.requestCancel();
        await flush();
        expect(rig.controller.getSnapshot().kind).toBe("ready");
        expect(rig.speech.cancelCalls).toEqual([sessionId]);

        rig.speech.emitTranscript(sessionId, "too late");
        await flush();

        expect(rig.controller.getSnapshot().kind).toBe("ready");
        expect(rig.inserter.insertCalls).toEqual([]);
    });

    it("discards a transcript for an unknown session while another could be active", async () => {
        const rig = createTestRig();
        await startReady(rig);
        await startRecording(rig);

        rig.speech.emitTranscript("not-the-session", "stale");
        await flush();

        expect(rig.controller.getSnapshot().kind).toBe("recording");
        expect(rig.inserter.insertCalls).toEqual([]);
    });
});

describe("keyboard context changes", () => {
    it("suppresses insertion when the context changed during transcription and retains the transcript", async () => {
        const rig = createTestRig();
        await startReady(rig);
        const sessionId = await startTranscribing(rig);

        rig.keyboard.close();
        await flush();
        expect(rig.controller.getSnapshot().kind).toBe("transcribing"); // may finish

        rig.keyboard.open(); // a new context id
        rig.speech.emitTranscript(sessionId, "for the old field");
        await flush();

        expect(rig.controller.getSnapshot().kind).toBe("ready");
        expect(rig.inserter.insertCalls).toEqual([]);
        expect(rig.controller.getLastSuppressedTranscript()).toBe("for the old field");
    });

    it("cancels the recording when the keyboard closes mid-recording and is ready for the next keyboard", async () => {
        const rig = createTestRig();
        await startReady(rig);
        const sessionId = await startRecording(rig);

        rig.keyboard.close();
        await flush();

        expect(rig.controller.getSnapshot().kind).toBe("ready");
        expect(rig.speech.cancelCalls).toEqual([sessionId]);
        expect(rig.speech.stopCalls).toEqual([]);

        rig.keyboard.open();
        await rig.controller.handleMicrophonePressed();
        await flush();
        expect(rig.controller.getSnapshot().kind).toBe("starting");
    });
});

describe("cancellation", () => {
    it("cancel during recording stops capture, discards the result and inserts nothing", async () => {
        const rig = createTestRig();
        await startReady(rig);
        const sessionId = await startRecording(rig);

        await rig.controller.requestCancel();
        await flush();

        expect(rig.controller.getSnapshot().kind).toBe("ready");
        expect(rig.speech.cancelCalls).toEqual([sessionId]);

        rig.speech.emitTranscript(sessionId, "discarded");
        await flush();
        expect(rig.inserter.insertCalls).toEqual([]);
    });

    it("cancel during transcription cancels the session and drops the late result", async () => {
        const rig = createTestRig();
        await startReady(rig);
        const sessionId = await startTranscribing(rig);

        await rig.controller.requestCancel();
        await flush();
        expect(rig.controller.getSnapshot().kind).toBe("ready");
        expect(rig.speech.cancelCalls).toEqual([sessionId]);

        rig.speech.emitTranscript(sessionId, "late");
        await flush();
        expect(rig.inserter.insertCalls).toEqual([]);
    });
});

describe("insertion failure → recoverable error", () => {
    it("surfaces a recoverable error with the stable code and recovers on dismissal", async () => {
        const rig = createTestRig();
        await startReady(rig);
        const sessionId = await startTranscribing(rig);
        rig.inserter.failNextWith(new DictationError("CLIPBOARD_WRITE_FAILED"));

        rig.speech.emitTranscript(sessionId, "will fail");
        await flush();

        expect(rig.controller.getSnapshot()).toMatchObject({
            kind: "error",
            recoverable: true,
            error: { code: "CLIPBOARD_WRITE_FAILED" },
        });

        rig.controller.dismissError();
        expect(rig.controller.getSnapshot().kind).toBe("ready");
    });
});

describe("empty speech", () => {
    it("returns to ready with no clipboard write and no paste", async () => {
        const rig = createTestRig();
        await startReady(rig);
        const sessionId = await startTranscribing(rig);

        rig.speech.emitTranscript(sessionId, "   \n\t ");
        await flush();

        expect(rig.controller.getSnapshot().kind).toBe("ready");
        expect(rig.inserter.insertCalls).toEqual([]);
    });
});

describe("transcript validation", () => {
    it("rejects a transcript above 16 KiB UTF-8 with TRANSCRIPT_TOO_LARGE", async () => {
        const rig = createTestRig();
        await startReady(rig);
        const sessionId = await startTranscribing(rig);

        rig.speech.emitTranscript(sessionId, "é".repeat(MAX_TRANSCRIPT_UTF8_BYTES / 2 + 1));
        await flush();

        expect(rig.controller.getSnapshot()).toMatchObject({
            kind: "error",
            recoverable: true,
            error: { code: "TRANSCRIPT_TOO_LARGE" },
        });
        expect(rig.inserter.insertCalls).toEqual([]);
    });

    it("accepts a transcript of exactly 16 KiB UTF-8 (boundary is exclusive)", async () => {
        const rig = createTestRig();
        await startReady(rig);
        const sessionId = await startTranscribing(rig);

        rig.speech.emitTranscript(sessionId, "é".repeat(MAX_TRANSCRIPT_UTF8_BYTES / 2));
        await flush();

        expect(rig.controller.getSnapshot().kind).toBe("ready");
        expect(rig.inserter.insertCalls).toHaveLength(1);
    });

    it("rejects transcripts containing NUL with TRANSCRIPT_INVALID", async () => {
        const rig = createTestRig();
        await startReady(rig);
        const sessionId = await startTranscribing(rig);

        rig.speech.emitTranscript(sessionId, "bad\0text");
        await flush();

        expect(rig.controller.getSnapshot()).toMatchObject({
            kind: "error",
            recoverable: true,
            error: { code: "TRANSCRIPT_INVALID" },
        });
        expect(rig.inserter.insertCalls).toEqual([]);
    });
});

describe("speech failures during a session", () => {
    it("maps a transcription failure to a recoverable error and cleans up", async () => {
        const rig = createTestRig();
        await startReady(rig);
        const sessionId = await startRecording(rig);

        rig.speech.emitError(new DictationError("TRANSCRIPTION_FAILED"), sessionId);
        await flush();

        expect(rig.controller.getSnapshot()).toMatchObject({
            kind: "error",
            recoverable: true,
            error: { code: "TRANSCRIPTION_FAILED" },
        });
        expect(rig.speech.cancelCalls).toEqual([sessionId]);
    });

    it("maps a runtime crash to a fatal error that dismissal cannot clear", async () => {
        const rig = createTestRig();
        await startReady(rig);
        await startRecording(rig);

        rig.speech.emitStatus("crashed");
        await flush();
        expect(rig.controller.getSnapshot()).toMatchObject({
            kind: "error",
            recoverable: false,
            error: { code: "RUNTIME_CRASHED" },
        });

        rig.controller.dismissError();
        expect(rig.controller.getSnapshot().kind).toBe("error");
    });

    it("maps a start failure to a recoverable error", async () => {
        const rig = createTestRig();
        await startReady(rig);

        await rig.controller.handleMicrophonePressed();
        await flush();
        rig.speech.rejectStart("id-1", new Error("mic busy"));
        await flush();

        expect(rig.controller.getSnapshot()).toMatchObject({
            kind: "error",
            recoverable: true,
            error: { code: "RECORDING_START_FAILED" },
        });

        rig.controller.dismissError();
        expect(rig.controller.getSnapshot().kind).toBe("ready");
    });
});

describe("stale error auto-clear on runtime ready (on-device 2026-09-19)", () => {
    // On-device defect: a press during a daemon restart window left a
    // standing recoverable error on the card even after the runtime was
    // ready again; nothing ever cleared it.
    async function pressFailureError(rig: TestRig): Promise<void> {
        await startReady(rig);
        await rig.controller.handleMicrophonePressed();
        await flush();
        rig.speech.rejectStart("id-1", new Error("daemon restarting"));
        await flush();
        expect(rig.controller.getSnapshot()).toMatchObject({
            kind: "error",
            recoverable: true,
            error: { code: "RECORDING_START_FAILED" },
        });
    }

    it("clears a standing recoverable error when the runtime reports ready again", async () => {
        const rig = createTestRig();
        await pressFailureError(rig);

        rig.speech.emitStatus("ready");
        await flush();
        expect(rig.controller.getSnapshot().kind).toBe("ready");

        // Only the STALE error clears: a NEW failing press produces its own
        // error state again (never honesty).
        await rig.controller.handleMicrophonePressed();
        await flush();
        rig.speech.rejectStart("id-2", new Error("still broken"));
        await flush();
        expect(rig.controller.getSnapshot()).toMatchObject({
            kind: "error",
            recoverable: true,
            error: { code: "RECORDING_START_FAILED" },
        });
    });

    it("keeps a fatal error when the runtime reports ready again", async () => {
        const rig = createTestRig();
        await startReady(rig);
        await startRecording(rig);
        rig.speech.emitStatus("crashed");
        await flush();
        expect(rig.controller.getSnapshot()).toMatchObject({
            kind: "error",
            recoverable: false,
            error: { code: "RUNTIME_CRASHED" },
        });

        rig.speech.emitStatus("ready");
        await flush();
        expect(rig.controller.getSnapshot().kind).toBe("error");
    });

    it("keeps the standing error while no ready event arrives", async () => {
        const rig = createTestRig();
        await pressFailureError(rig);

        await flush();
        expect(rig.controller.getSnapshot().kind).toBe("error");
    });
});

describe("state store and dispose", () => {
    function withSubscription(rig: TestRig): { states: string[]; unsubscribe: () => void } {
        const states: string[] = [];
        const unsubscribe = rig.controller.subscribe(() => {
            states.push(rig.controller.getSnapshot().kind);
        });
        return { states, unsubscribe };
    }

    it("notifies subscribers only on applied transitions and supports unsubscribe", async () => {
        const rig = createTestRig();
        await startReady(rig);
        const { states, unsubscribe } = withSubscription(rig);

        await startRecording(rig);
        expect(states).toEqual(["starting", "recording"]);

        unsubscribe();
        await rig.controller.requestCancel();
        await flush();
        expect(states).toEqual(["starting", "recording"]);
    });

    it("dispose cancels the active recording, and a second dispose is a no-op", async () => {
        const rig = createTestRig();
        await startReady(rig);
        const sessionId = await startRecording(rig);

        await rig.controller.dispose();
        expect(rig.speech.cancelCalls).toEqual([sessionId]);

        await rig.controller.dispose();
        expect(rig.speech.cancelCalls).toEqual([sessionId]);
    });

    it("ignores microphone presses after dispose", async () => {
        const rig = createTestRig();
        await startReady(rig);
        await rig.controller.dispose();

        await rig.controller.handleMicrophonePressed();
        await flush();

        expect(rig.speech.startCalls).toEqual([]);
        expect(rig.controller.getSnapshot().kind).toBe("ready");
    });
});

describe("panel dictation flow (owner pivot)", () => {
    it("panel press starts a clipboard-flow session with every keyboard capability false (on-device regression)", async () => {
        // On device the probe reported `[steam.capability] supported=false
        // profileId=none` and the old keyboard gating made every QAM press
        // dead. The flow needs only runtime + model + enabled (availability
        // is reported, never assumed): with
        // the hook failed, diagnostics degraded and no insertion facets,
        // the press must still start recording.
        const rig = createTestRig();
        rig.keyboard.startError = new Error("no hook");
        rig.keyboard.diagnostics = {
            registryFound: false,
            managersHooked: 0,
            keyboardSignatureSeen: false,
            documentResolved: false,
            reason: "registry-not-found",
        };
        await rig.controller.start(); // no keyboard context exists
        expect(rig.controller.getSnapshot().kind).toBe("ready");

        await rig.controller.handlePanelMicrophonePressed();
        await flush();
        expect(rig.controller.getSnapshot()).toMatchObject({
            kind: "starting",
            session: { sessionId: "id-1", keyboardContextId: null },
        });
        expect(rig.speech.startCalls).toEqual(["id-1"]);
    });

    it("starts a clipboard-flow session from the panel without any keyboard context", async () => {
        const rig = createTestRig();
        await rig.controller.start(); // no keyboard context exists
        expect(rig.controller.getSnapshot().kind).toBe("ready");

        await rig.controller.handlePanelMicrophonePressed();
        await flush();
        expect(rig.controller.getSnapshot()).toMatchObject({
            kind: "starting",
            session: { sessionId: "id-1", keyboardContextId: null },
        });
        expect(rig.speech.startCalls).toEqual(["id-1"]);

        rig.speech.resolveStart("id-1");
        await flush();
        expect(rig.controller.getSnapshot().kind).toBe("recording");
    });

    it("suppresses and retains a panel-session transcript instead of inserting it", async () => {
        const rig = createTestRig();
        await rig.controller.start(); // no keyboard context
        await rig.controller.handlePanelMicrophonePressed();
        await flush();
        rig.speech.resolveStart("id-1");
        await flush();

        // Stop → transcribing → transcript for the null-context session.
        await rig.controller.handlePanelMicrophonePressed();
        await flush();
        rig.speech.resolveStop("id-1");
        await flush();
        rig.speech.emitTranscript("id-1", "für das Panel");
        await flush();

        // Suppression: no insertion; the transcript is retained so the
        // panel card can offer copy; the flow settles back to ready.
        expect(rig.inserter.insertCalls).toEqual([]);
        expect(rig.controller.getLastSuppressedTranscript()).toBe("für das Panel");
        expect(rig.controller.getSnapshot().kind).toBe("ready");
    });

    it("a keyboard opening/closing never switches or cancels a panel session", async () => {
        const rig = createTestRig();
        await rig.controller.start();
        await rig.controller.handlePanelMicrophonePressed();
        await flush();
        rig.speech.resolveStart("id-1");
        await flush();
        expect(rig.controller.getSnapshot().kind).toBe("recording");

        // A keyboard appearing and disappearing mid-recording belongs to no
        // panel session context (null matches nothing): recording continues.
        rig.keyboard.open();
        rig.keyboard.close();
        await flush();
        expect(rig.controller.getSnapshot().kind).toBe("recording");
    });

    it("panel presses during recording stop it; pending presses stay serialized", async () => {
        const rig = createTestRig();
        await rig.controller.start();
        await rig.controller.handlePanelMicrophonePressed();
        await flush();
        expect(rig.controller.getSnapshot().kind).toBe("starting");

        // Duplicate press while pending: ignored, no queued stop.
        await rig.controller.handlePanelMicrophonePressed();
        await flush();
        expect(rig.controller.getSnapshot().kind).toBe("starting");
        expect(rig.speech.stopCalls).toEqual([]);

        rig.speech.resolveStart("id-1");
        await flush();
        await rig.controller.handlePanelMicrophonePressed();
        await flush();
        expect(rig.controller.getSnapshot().kind).toBe("stopping");
        expect(rig.speech.stopCalls).toEqual(["id-1"]);
    });
});

describe("on-device event ordering (deck 2026-09-18): transcript precedes the stop acknowledgement", () => {
    it("keyboard flow: outcome during stopping still inserts exactly once and settles ready", async () => {
        const rig = createTestRig();
        await startReady(rig);
        const contextId = rig.keyboard.currentContext()?.id;
        const sessionId = await startRecording(rig);

        await rig.controller.handleMicrophonePressed();
        await flush();
        expect(rig.controller.getSnapshot().kind).toBe("stopping");

        // Real decky FIFO order: the backend emits transcript_ready inside the
        // stop_recording callable, before its response resolves the await.
        rig.speech.emitTranscript(sessionId, "hello world");
        rig.speech.resolveStop(sessionId);
        await flush();

        expect(rig.controller.getSnapshot().kind).toBe("ready");
        expect(rig.inserter.insertCalls).toEqual([{ contextId, text: "hello world" }]);
    });

    it("panel flow: outcome during stopping suppresses, retains and settles ready — never stuck transcribing", async () => {
        const rig = createTestRig();
        await rig.controller.start(); // no keyboard context
        await rig.controller.handlePanelMicrophonePressed();
        await flush();
        rig.speech.resolveStart("id-1");
        await flush();

        await rig.controller.handlePanelMicrophonePressed();
        await flush();
        rig.speech.emitTranscript("id-1", "für das Panel");
        rig.speech.resolveStop("id-1");
        await flush();

        expect(rig.controller.getSnapshot().kind).toBe("ready");
        expect(rig.inserter.insertCalls).toEqual([]);
        expect(rig.controller.getLastSuppressedTranscript()).toBe("für das Panel");
    });
});

// ── boot watchdog (no startup wait is unbounded) ────────────────────────────

type TimeoutHandle = ReturnType<typeof setTimeout>;

/** Manual scheduler: expiry fires only when the test calls fire() — no sleeps. */
class ManualStartupTimer {
    cancelCount = 0;
    private handler: (() => void) | null = null;

    readonly seam: StartupTimerSeam = {
        timeoutMs: 5_000,
        schedule: (handler: () => void): TimeoutHandle => {
            this.handler = handler;
            return {} as unknown as TimeoutHandle;
        },
        cancel: (): void => {
            this.cancelCount += 1;
            this.handler = null;
        },
    };

    get armed(): boolean {
        return this.handler !== null;
    }

    fire(): void {
        const handler = this.handler;
        this.handler = null;
        handler?.();
    }
}

/** Torn-loader stand-in: the initialize callable never resolves on its own. */
class HangingInitializeSpeechPort extends FakeSpeechPort {
    private readonly gate = new Deferred<void>();

    constructor(trace: string[] = []) {
        super(trace);
    }

    resolveInitialize(): void {
        this.gate.resolve();
    }

    override async initialize(): Promise<SpeechCapabilities> {
        this.trace.push("speech.initialize");
        await this.gate.promise;
        return { ...ALL_CAPABILITIES };
    }
}

function createWatchdogRig(speechPort?: (trace: string[]) => FakeSpeechPort): {
    rig: TestRig;
    timer: ManualStartupTimer;
} {
    const trace: string[] = [];
    const speech = speechPort ? speechPort(trace) : new FakeSpeechPort(trace);
    const keyboard = new FakeKeyboardHost(trace);
    const inserter = new FakeBulkTextInserter(trace);
    const settings = new FakeSettingsPort();
    const clock = new FakeClock();
    const ids = new FakeIdGenerator();
    const timer = new ManualStartupTimer();
    const controller = new DictationController(
        speech,
        keyboard,
        inserter,
        settings,
        clock,
        ids,
        new Logger("dictation.session", nullSink),
        timer.seam,
    );
    return { rig: { controller, speech, keyboard, inserter, settings, clock, ids, trace }, timer };
}

describe("startup watchdog (a torn loader registration must not wedge booting)", () => {
    it("expires into the existing SPEECH_RUNTIME_UNAVAILABLE path and ignores a late resolution", async () => {
        const { rig, timer } = createWatchdogRig((trace) => new HangingInitializeSpeechPort(trace));
        rig.keyboard.open();
        void rig.controller.start(); // parked inside the hanging initialize
        await flush();
        expect(rig.trace).toContain("speech.initialize");
        expect(rig.controller.getSnapshot().kind).toBe("booting");
        expect(timer.armed).toBe(true);

        timer.fire();
        await flush();
        expect(rig.controller.getSnapshot()).toEqual({
            kind: "unavailable",
            reason: "SPEECH_RUNTIME_UNAVAILABLE",
        });

        // The torn callable resolves late: the state must not flip back.
        (rig.speech as HangingInitializeSpeechPort).resolveInitialize();
        await flush();
        expect(rig.controller.getSnapshot()).toEqual({
            kind: "unavailable",
            reason: "SPEECH_RUNTIME_UNAVAILABLE",
        });
    });

    it("clears the watchdog when startup completes, so expiry cannot fire afterwards", async () => {
        const { rig, timer } = createWatchdogRig();
        rig.keyboard.open();
        await rig.controller.start();
        expect(rig.controller.getSnapshot().kind).toBe("ready");
        expect(timer.cancelCount).toBe(1);
        expect(timer.armed).toBe(false);

        timer.fire(); // no handler left: a cleared watchdog cannot fire
        await flush();
        expect(rig.controller.getSnapshot().kind).toBe("ready");
    });
});

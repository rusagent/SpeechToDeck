/**
 * DictationController behavioral tests (spec §9-§12, §76-§78, §87).
 *
 * All infrastructure is in-memory fakes; no network and no microphone. The
 * oracle is the spec: acknowledgements gate the active indicator (§75), stale
 * results are never injected (§11), suppression follows keyboard-context loss
 * (§12), and §76-§78 govern auto-stop, empty speech and validation.
 */

import { describe, expect, it, vi } from "vitest";

import { Deferred } from "../../src/shared/Deferred";
import { DictationError, MAX_TRANSCRIPT_UTF8_BYTES } from "../../src/domain/DictationError";
import {
    createTestRig,
    flush,
    startRecording,
    startReady,
    startTranscribing,
    type TestRig,
} from "./fakes/TestRig";

describe("startup (§82)", () => {
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

    it("keeps starting the runtime when the keyboard hook fails (v0.2.2 QAM decoupling)", async () => {
        // The QAM flow has no keyboard-hook dependency: a failed hook leaves
        // the in-keyboard button dormant and degrades through the §58
        // diagnostics — it never blocks the dictation flow (§105).
        const rig = createTestRig();
        rig.keyboard.startError = new Error("no hook");
        rig.keyboard.open();
        await rig.controller.start();

        expect(rig.controller.getSnapshot().kind).toBe("ready");
        expect(rig.trace).toContain("keyboard.start");
        expect(rig.trace).toContain("speech.initialize");
    });

    it("keeps the flow ready while keyboard hook diagnostics degrade (v0.2.2 QAM decoupling)", async () => {
        // §57 honesty stays in the capability report (keyboardHookAvailable
        // still derives from the host's §58 diagnostics); the flow gate no
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

describe("happy path (§8 flow, §21 one-shot insertion)", () => {
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

describe("duplicate presses while pending (§10)", () => {
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

describe("stale session handling (§11)", () => {
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

describe("keyboard context changes (§7.2/§12)", () => {
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

describe("cancellation (§72)", () => {
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

describe("insertion failure → recoverable error (§69)", () => {
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

describe("empty speech (§77)", () => {
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

describe("transcript validation (§78)", () => {
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

describe("maximum recording duration (§76)", () => {
    it("automatically stops recording at the configured maximum and transcribes", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
            const rig = createTestRig({ maxRecordingSeconds: 2 });
            rig.keyboard.open();
            await rig.controller.start();
            await rig.controller.handleMicrophonePressed();
            await vi.advanceTimersByTimeAsync(0);
            expect(rig.controller.getSnapshot().kind).toBe("starting");

            rig.speech.resolveStart("id-1");
            await vi.advanceTimersByTimeAsync(0);
            expect(rig.controller.getSnapshot().kind).toBe("recording");

            await vi.advanceTimersByTimeAsync(1_999);
            expect(rig.controller.getSnapshot().kind).toBe("recording");

            rig.clock.advance(2_000);
            await vi.advanceTimersByTimeAsync(1);
            expect(rig.controller.getSnapshot().kind).toBe("stopping");
            expect(rig.speech.stopCalls).toEqual(["id-1"]);

            rig.speech.resolveStop("id-1");
            await vi.advanceTimersByTimeAsync(0);
            expect(rig.controller.getSnapshot().kind).toBe("transcribing");

            // The automatic stop itself never submits text (§76).
            expect(rig.inserter.insertCalls).toEqual([]);
        } finally {
            vi.useRealTimers();
        }
    });
});

describe("speech failures during a session (§68/§69)", () => {
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

describe("state store (§102) and dispose (§83)", () => {
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

describe("panel dictation flow (v0.2 owner pivot)", () => {
    it("panel press starts a clipboard-flow session with every keyboard capability false (on-device v0.2.2 regression)", async () => {
        // On device the probe reported `[steam.capability] supported=false
        // profileId=none` and the old keyboard gating made every QAM press
        // dead. The flow needs only runtime + model + enabled (§57): with
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

        // §12 suppression: no insertion; the transcript is retained so the
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

    it("panel presses during recording stop it; pending presses stay serialized (§10)", async () => {
        const rig = createTestRig();
        await rig.controller.start();
        await rig.controller.handlePanelMicrophonePressed();
        await flush();
        expect(rig.controller.getSnapshot().kind).toBe("starting");

        // Duplicate press while pending: ignored, no queued stop (§10).
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

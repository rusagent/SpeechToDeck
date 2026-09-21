import { describe, expect, it } from "vitest";

import { DictationController } from "../../src/application/DictationController";
import type { StartupTimerSeam } from "../../src/application/DictationController";
import type { SpeechCapabilities } from "../../src/application/ports/SpeechPort";
import { DictationError, MAX_TRANSCRIPT_UTF8_BYTES } from "../../src/domain/DictationError";
import { Deferred } from "../../src/shared/Deferred";
import { Logger, nullSink } from "../../src/shared/Logger";
import { FakeClock } from "./fakes/FakeClock";
import { FakeClipboardPort } from "./fakes/FakeClipboardPort";
import { FakeIdGenerator } from "./fakes/FakeIdGenerator";
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
    it("reaches ready", async () => {
        const rig = createTestRig();
        await rig.controller.start();

        expect(rig.controller.getSnapshot().kind).toBe("ready");
        expect(rig.trace).toContain("speech.initialize");
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

    it("reports SPEECH_RUNTIME_UNAVAILABLE when initialize fails", async () => {
        const rig = createTestRig();
        rig.speech.initializeError = new Error("daemon down");
        await rig.controller.start();

        expect(rig.controller.getSnapshot()).toEqual({
            kind: "unavailable",
            reason: "SPEECH_RUNTIME_UNAVAILABLE",
        });
    });

    it("reports PLUGIN_DISABLED through the capability report when settings disable the plugin", async () => {
        const rig = createTestRig({ enabled: false });
        await rig.controller.start();

        expect(rig.controller.getSnapshot()).toEqual({
            kind: "unavailable",
            reason: "PLUGIN_DISABLED",
        });
    });
});

describe("happy path (flow, one-shot clipboard write)", () => {
    it("press → acknowledged recording → stop → transcript → single clipboard write → ready", async () => {
        const rig = createTestRig();
        await startReady(rig);

        const sessionId = await startRecording(rig);
        expect(rig.speech.startCalls).toEqual([sessionId]);

        await rig.controller.handlePanelMicrophonePressed();
        await flush();
        expect(rig.controller.getSnapshot().kind).toBe("stopping");
        rig.speech.resolveStop(sessionId);
        await flush();
        expect(rig.controller.getSnapshot().kind).toBe("transcribing");

        rig.clipboard.writeGate = new Deferred<void>();
        rig.speech.emitTranscript(sessionId, "hello world");
        await flush();
        expect(rig.controller.getSnapshot()).toMatchObject({
            kind: "inserting",
            transcript: "hello world",
        });

        rig.clipboard.releaseWrite();
        await flush();
        expect(rig.controller.getSnapshot().kind).toBe("ready");
        expect(rig.clipboard.writtenTexts).toEqual(["hello world"]);
        expect(rig.clipboard.writeCalls).toHaveLength(1);
    });
});

describe("duplicate presses while pending", () => {
    it("does not start parallel recordings and queues no stop", async () => {
        const rig = createTestRig();
        await startReady(rig);

        await rig.controller.handlePanelMicrophonePressed();
        await flush();
        expect(rig.controller.getSnapshot().kind).toBe("starting");

        await rig.controller.handlePanelMicrophonePressed();
        await rig.controller.handlePanelMicrophonePressed();
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
        expect(rig.clipboard.writeCalls).toEqual([]);
    });

    it("discards a transcript for an unknown session while another could be active", async () => {
        const rig = createTestRig();
        await startReady(rig);
        await startRecording(rig);

        rig.speech.emitTranscript("not-the-session", "stale");
        await flush();

        expect(rig.controller.getSnapshot().kind).toBe("recording");
        expect(rig.clipboard.writeCalls).toEqual([]);
    });
});

describe("cancellation", () => {
    it("cancel during recording stops capture, discards the result and copies nothing", async () => {
        const rig = createTestRig();
        await startReady(rig);
        const sessionId = await startRecording(rig);

        await rig.controller.requestCancel();
        await flush();

        expect(rig.controller.getSnapshot().kind).toBe("ready");
        expect(rig.speech.cancelCalls).toEqual([sessionId]);

        rig.speech.emitTranscript(sessionId, "discarded");
        await flush();
        expect(rig.clipboard.writeCalls).toEqual([]);
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
        expect(rig.clipboard.writeCalls).toEqual([]);
    });
});

describe("clipboard write failure → recoverable error", () => {
    it("surfaces a recoverable error with the stable code and recovers on dismissal", async () => {
        const rig = createTestRig();
        await startReady(rig);
        const sessionId = await startTranscribing(rig);
        rig.clipboard.writeError = new DictationError("CLIPBOARD_WRITE_FAILED");

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

    it("maps an escaping non-copied error onto the stable clipboard code", async () => {
        const rig = createTestRig();
        await startReady(rig);
        const sessionId = await startTranscribing(rig);
        rig.clipboard.writeError = new Error("mechanism exploded");

        rig.speech.emitTranscript(sessionId, "will fail");
        await flush();

        expect(rig.controller.getSnapshot()).toMatchObject({
            kind: "error",
            recoverable: true,
            error: { code: "CLIPBOARD_WRITE_FAILED" },
        });
    });
});

describe("empty speech", () => {
    it("returns to ready with no clipboard write", async () => {
        const rig = createTestRig();
        await startReady(rig);
        const sessionId = await startTranscribing(rig);

        rig.speech.emitTranscript(sessionId, "   \n\t ");
        await flush();

        expect(rig.controller.getSnapshot().kind).toBe("ready");
        expect(rig.clipboard.writeCalls).toEqual([]);
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
        expect(rig.clipboard.writeCalls).toEqual([]);
    });

    it("accepts a transcript of exactly 16 KiB UTF-8 (boundary is exclusive)", async () => {
        const rig = createTestRig();
        await startReady(rig);
        const sessionId = await startTranscribing(rig);

        rig.speech.emitTranscript(sessionId, "é".repeat(MAX_TRANSCRIPT_UTF8_BYTES / 2));
        await flush();

        expect(rig.controller.getSnapshot().kind).toBe("ready");
        expect(rig.clipboard.writeCalls).toHaveLength(1);
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
        expect(rig.clipboard.writeCalls).toEqual([]);
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

        await rig.controller.handlePanelMicrophonePressed();
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

describe("stale error auto-clear on runtime ready (observed on device)", () => {
    async function pressFailureError(rig: TestRig): Promise<void> {
        await startReady(rig);
        await rig.controller.handlePanelMicrophonePressed();
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

        await rig.controller.handlePanelMicrophonePressed();
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

        await rig.controller.handlePanelMicrophonePressed();
        await flush();

        expect(rig.speech.startCalls).toEqual([]);
        expect(rig.controller.getSnapshot().kind).toBe("ready");
    });
});

describe("on-device event ordering: transcript precedes the stop acknowledgement", () => {
    it("outcome during stopping still copies exactly once and settles ready", async () => {
        const rig = createTestRig();
        await startReady(rig);
        const sessionId = await startRecording(rig);

        await rig.controller.handlePanelMicrophonePressed();
        await flush();
        expect(rig.controller.getSnapshot().kind).toBe("stopping");

        rig.speech.emitTranscript(sessionId, "hello world");
        rig.speech.resolveStop(sessionId);
        await flush();

        expect(rig.controller.getSnapshot().kind).toBe("ready");
        expect(rig.clipboard.writtenTexts).toEqual(["hello world"]);
    });
});

type TimeoutHandle = ReturnType<typeof setTimeout>;

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
    const clipboard = new FakeClipboardPort(trace);
    const settings = new FakeSettingsPort();
    const clock = new FakeClock();
    const ids = new FakeIdGenerator();
    const timer = new ManualStartupTimer();
    const controller = new DictationController(
        speech,
        clipboard,
        settings,
        clock,
        ids,
        new Logger("dictation.session", nullSink),
        timer.seam,
    );
    return { rig: { controller, speech, clipboard, settings, clock, ids, trace }, timer };
}

describe("startup watchdog (a torn loader registration must not wedge booting)", () => {
    it("expires into the existing SPEECH_RUNTIME_UNAVAILABLE path and ignores a late resolution", async () => {
        const { rig, timer } = createWatchdogRig((trace) => new HangingInitializeSpeechPort(trace));
        void rig.controller.start();
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

        (rig.speech as HangingInitializeSpeechPort).resolveInitialize();
        await flush();
        expect(rig.controller.getSnapshot()).toEqual({
            kind: "unavailable",
            reason: "SPEECH_RUNTIME_UNAVAILABLE",
        });
    });

    it("clears the watchdog when startup completes, so expiry cannot fire afterwards", async () => {
        const { rig, timer } = createWatchdogRig();
        await rig.controller.start();
        expect(rig.controller.getSnapshot().kind).toBe("ready");
        expect(timer.cancelCount).toBe(1);
        expect(timer.armed).toBe(false);

        timer.fire();
        await flush();
        expect(rig.controller.getSnapshot().kind).toBe("ready");
    });
});

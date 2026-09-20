/**
 * Pure state machine tests.
 *
 * Oracle: the documented transition table and forbidden-transition list — not
 * implementation constants. Valid edges are exercised with the state kinds and
 * payloads the table requires; forbidden edges must be rejected by returning
 * the current state unchanged with no effects.
 */

import { describe, expect, it } from "vitest";

import type { RuntimeCapabilities } from "../../src/domain/Capability";
import { DictationError } from "../../src/domain/DictationError";
import type { DictationSession } from "../../src/domain/DictationSession";
import type { DictationState } from "../../src/domain/DictationState";
import {
    isFatalDictationError,
    transition,
    type DictationEvent,
} from "../../src/application/DictationStateMachine";

const SESSION: DictationSession = {
    sessionId: "s-1",
    startedAtMonotonicMs: 1_000,
};

const OTHER_SESSION: DictationSession = { ...SESSION, sessionId: "s-2" };

const READY_CAPABILITIES: RuntimeCapabilities = {
    speechRuntimeAvailable: true,
    microphoneAvailable: true,
    cpuAvailable: true,
    vulkanAvailable: true,
    modelInstalled: true,
};

const sessionState = (
    kind: "starting" | "recording" | "stopping" | "transcribing",
): DictationState => ({
    kind,
    session: SESSION,
});

const INSERTING: DictationState = {
    kind: "inserting",
    session: SESSION,
    transcript: "hello",
};

const RECOVERABLE_ERROR: DictationState = {
    kind: "error",
    error: new DictationError("TRANSCRIPTION_FAILED"),
    recoverable: true,
};

const FATAL_ERROR: DictationState = {
    kind: "error",
    error: new DictationError("RUNTIME_CRASHED"),
    recoverable: false,
};

function applied(result: { state: DictationState; effects: readonly unknown[] }): void {
    expect(result.effects).toEqual([]);
}

/** Asserts a rejected (forbidden or inapplicable) edge: same state, no effects. */
function rejected(current: DictationState, event: DictationEvent): void {
    const result = transition(current, event);
    expect(result.state).toBe(current);
    expect(result.effects).toEqual([]);
}

describe("state transition table (valid normal flow)", () => {
    it("booting → ready on a complete startup report", () => {
        const result = transition(
            { kind: "booting" },
            { type: "STARTUP_COMPLETED", capabilities: READY_CAPABILITIES, enabled: true },
        );
        expect(result.state).toEqual({ kind: "ready" });
        applied(result);
    });

    it("booting → unavailable per capability check (model not installed)", () => {
        const result = transition(
            { kind: "booting" },
            {
                type: "STARTUP_COMPLETED",
                capabilities: { ...READY_CAPABILITIES, modelInstalled: false },
                enabled: true,
            },
        );
        expect(result.state).toEqual({ kind: "unavailable", reason: "MODEL_NOT_INSTALLED" });
    });

    it("booting → unavailable when the plugin is disabled", () => {
        const result = transition(
            { kind: "booting" },
            { type: "STARTUP_COMPLETED", capabilities: READY_CAPABILITIES, enabled: false },
        );
        expect(result.state).toEqual({ kind: "unavailable", reason: "PLUGIN_DISABLED" });
    });

    it("booting → unavailable on startup failure", () => {
        const result = transition(
            { kind: "booting" },
            { type: "STARTUP_FAILED", reason: "SPEECH_RUNTIME_UNAVAILABLE" },
        );
        expect(result.state).toEqual({ kind: "unavailable", reason: "SPEECH_RUNTIME_UNAVAILABLE" });
    });

    it("ready → starting on press, emitting START_RECORDING", () => {
        const result = transition(
            { kind: "ready" },
            { type: "MICROPHONE_PRESSED", session: SESSION },
        );
        expect(result.state).toEqual({ kind: "starting", session: SESSION });
        expect(result.effects).toEqual([{ type: "START_RECORDING", sessionId: "s-1" }]);
    });

    it("starting → recording on the start acknowledgement", () => {
        const result = transition(sessionState("starting"), {
            type: "RECORDING_STARTED",
            sessionId: "s-1",
        });
        expect(result.state).toEqual({ kind: "recording", session: SESSION });
        applied(result);
    });

    it("recording → stopping on press, emitting STOP_RECORDING", () => {
        const result = transition(sessionState("recording"), { type: "MICROPHONE_PRESSED" });
        expect(result.state).toEqual({ kind: "stopping", session: SESSION });
        expect(result.effects).toEqual([{ type: "STOP_RECORDING", sessionId: "s-1" }]);
    });

    it("stopping → transcribing on the stop acknowledgement", () => {
        const result = transition(sessionState("stopping"), {
            type: "RECORDING_STOPPED",
            sessionId: "s-1",
        });
        expect(result.state).toEqual({ kind: "transcribing", session: SESSION });
        applied(result);
    });

    it("transcribing → inserting on the transcript, trimmed, emitting INSERT_TEXT", () => {
        const result = transition(sessionState("transcribing"), {
            type: "TRANSCRIPT_READY",
            sessionId: "s-1",
            transcript: "  hello world  ",
        });
        expect(result.state).toEqual({
            kind: "inserting",
            session: SESSION,
            transcript: "hello world",
        });
        expect(result.effects).toEqual([
            { type: "INSERT_TEXT", sessionId: "s-1", text: "hello world" },
        ]);
    });

    it("inserting → ready on insertion success", () => {
        const result = transition(INSERTING, { type: "INSERTION_SUCCEEDED", sessionId: "s-1" });
        expect(result.state).toEqual({ kind: "ready" });
        applied(result);
    });
});

describe("forbidden transitions", () => {
    it("ready → transcribing (via TRANSCRIPT_READY) is rejected", () => {
        rejected(
            { kind: "ready" },
            { type: "TRANSCRIPT_READY", sessionId: "s-1", transcript: "hello" },
        );
    });

    it("recording → inserting (via TRANSCRIPT_READY) is rejected", () => {
        rejected(sessionState("recording"), {
            type: "TRANSCRIPT_READY",
            sessionId: "s-1",
            transcript: "hello",
        });
    });

    it("inserting → recording (via MICROPHONE_PRESSED) is rejected", () => {
        rejected(INSERTING, { type: "MICROPHONE_PRESSED", session: OTHER_SESSION });
    });

    it("error → recording (via MICROPHONE_PRESSED) is rejected", () => {
        rejected(RECOVERABLE_ERROR, { type: "MICROPHONE_PRESSED", session: OTHER_SESSION });
    });
});

describe("duplicate presses while an operation is pending", () => {
    it("press during starting is ignored", () => {
        rejected(sessionState("starting"), { type: "MICROPHONE_PRESSED", session: OTHER_SESSION });
    });

    it("press during transcribing is ignored", () => {
        rejected(sessionState("transcribing"), {
            type: "MICROPHONE_PRESSED",
            session: OTHER_SESSION,
        });
    });

    it("press during inserting is ignored", () => {
        rejected(INSERTING, { type: "MICROPHONE_PRESSED", session: OTHER_SESSION });
    });

    it("press without a session in ready is rejected (controller always supplies one)", () => {
        rejected({ kind: "ready" }, { type: "MICROPHONE_PRESSED" });
    });
});

describe("stale results and mismatched sessions", () => {
    it("start acknowledgement for another session is ignored", () => {
        rejected(sessionState("starting"), { type: "RECORDING_STARTED", sessionId: "other" });
    });

    it("stop acknowledgement for another session is ignored", () => {
        rejected(sessionState("stopping"), { type: "RECORDING_STOPPED", sessionId: "other" });
    });

    it("transcript for another session is ignored", () => {
        rejected(sessionState("transcribing"), {
            type: "TRANSCRIPT_READY",
            sessionId: "other",
            transcript: "hello",
        });
    });

    it("speech failure for another session is ignored", () => {
        rejected(sessionState("recording"), {
            type: "SPEECH_FAILED",
            sessionId: "other",
            error: new DictationError("TRANSCRIPTION_FAILED"),
        });
    });

    it("insertion outcome for another session is ignored", () => {
        rejected(INSERTING, { type: "INSERTION_SUCCEEDED", sessionId: "other" });
        rejected(INSERTING, {
            type: "INSERTION_FAILED",
            sessionId: "other",
            error: new DictationError("CLIPBOARD_WRITE_FAILED"),
        });
    });
});

describe("cancellation", () => {
    it("cancel during recording → ready, emitting CANCEL_RECORDING", () => {
        const result = transition(sessionState("recording"), { type: "CANCEL_REQUESTED" });
        expect(result.state).toEqual({ kind: "ready" });
        expect(result.effects).toEqual([{ type: "CANCEL_RECORDING", sessionId: "s-1" }]);
    });

    it("cancel during transcription → ready, emitting CANCEL_RECORDING", () => {
        const result = transition(sessionState("transcribing"), { type: "CANCEL_REQUESTED" });
        expect(result.state).toEqual({ kind: "ready" });
        expect(result.effects).toEqual([{ type: "CANCEL_RECORDING", sessionId: "s-1" }]);
    });

    it("cancel during starting and stopping → ready, emitting CANCEL_RECORDING", () => {
        for (const kind of ["starting", "stopping"] as const) {
            const result = transition(sessionState(kind), { type: "CANCEL_REQUESTED" });
            expect(result.state).toEqual({ kind: "ready" });
            expect(result.effects).toEqual([{ type: "CANCEL_RECORDING", sessionId: "s-1" }]);
        }
    });

    it("cancel in ready has no effect", () => {
        rejected({ kind: "ready" }, { type: "CANCEL_REQUESTED" });
    });
});

describe("empty speech and transcript rejection", () => {
    it("empty transcript → ready with no effects: no clipboard write", () => {
        const result = transition(sessionState("transcribing"), {
            type: "TRANSCRIPT_READY",
            sessionId: "s-1",
            transcript: "   ",
        });
        expect(result.state).toEqual({ kind: "ready" });
        expect(result.effects).toEqual([]);
    });

    it("oversized transcript → recoverable TRANSCRIPT_TOO_LARGE error", () => {
        const result = transition(sessionState("transcribing"), {
            type: "TRANSCRIPT_READY",
            sessionId: "s-1",
            transcript: "x".repeat(16 * 1024 + 1),
        });
        expect(result.state.kind).toBe("error");
        expect(result.state).toMatchObject({
            kind: "error",
            recoverable: true,
            error: { code: "TRANSCRIPT_TOO_LARGE" },
        });
    });

    it("transcript with a NUL byte → recoverable TRANSCRIPT_INVALID error", () => {
        const result = transition(sessionState("transcribing"), {
            type: "TRANSCRIPT_READY",
            sessionId: "s-1",
            transcript: "hello\0world",
        });
        expect(result.state).toMatchObject({
            kind: "error",
            recoverable: true,
            error: { code: "TRANSCRIPT_INVALID" },
        });
    });
});

describe("insertion failure and recovery", () => {
    it("inserting → recoverable error on insertion failure", () => {
        const result = transition(INSERTING, {
            type: "INSERTION_FAILED",
            sessionId: "s-1",
            error: new DictationError("CLIPBOARD_WRITE_FAILED"),
        });
        expect(result.state).toMatchObject({
            kind: "error",
            recoverable: true,
            error: { code: "CLIPBOARD_WRITE_FAILED" },
        });
        applied(result);
    });

    it("dismiss a recoverable error → ready", () => {
        const result = transition(RECOVERABLE_ERROR, { type: "ERROR_DISMISSED" });
        expect(result.state).toEqual({ kind: "ready" });
    });

    it("a fatal error is not dismissible: explicit restart action required", () => {
        rejected(FATAL_ERROR, { type: "ERROR_DISMISSED" });
        expect(isFatalDictationError(FATAL_ERROR.error)).toBe(true);
        expect(isFatalDictationError(RECOVERABLE_ERROR.error)).toBe(false);
    });

    it("a fresh startup report recovers from error (restart path)", () => {
        const result = transition(FATAL_ERROR, {
            type: "STARTUP_COMPLETED",
            capabilities: READY_CAPABILITIES,
            enabled: true,
        });
        expect(result.state).toEqual({ kind: "ready" });
    });
});

describe("speech failures during a session", () => {
    it("transcription failure → recoverable error, emitting CANCEL_RECORDING as cleanup", () => {
        const result = transition(sessionState("recording"), {
            type: "SPEECH_FAILED",
            sessionId: "s-1",
            error: new DictationError("TRANSCRIPTION_FAILED"),
        });
        expect(result.state).toMatchObject({ kind: "error", recoverable: true });
        expect(result.effects).toEqual([{ type: "CANCEL_RECORDING", sessionId: "s-1" }]);
    });

    it("a global (session-less) speech failure hits the active session", () => {
        const result = transition(sessionState("starting"), {
            type: "SPEECH_FAILED",
            sessionId: null,
            error: new DictationError("MICROPHONE_UNAVAILABLE"),
        });
        expect(result.state).toMatchObject({ kind: "error", recoverable: true });
    });

    it("a runtime crash is fatal", () => {
        const result = transition(sessionState("transcribing"), {
            type: "SPEECH_FAILED",
            sessionId: "s-1",
            error: new DictationError("RUNTIME_CRASHED"),
        });
        expect(result.state).toMatchObject({ kind: "error", recoverable: false });
    });
});

describe("purity", () => {
    it("never mutates the current state and returns fresh state objects", () => {
        const current = sessionState("recording");
        const snapshot = structuredClone(current);
        const result = transition(current, { type: "CANCEL_REQUESTED" });
        expect(result.state).not.toBe(current);
        expect(current).toEqual(snapshot);
    });

    it("rejections return the identical state object with no effects", () => {
        const current = sessionState("recording");
        const result = transition(current, {
            type: "TRANSCRIPT_READY",
            sessionId: "s-1",
            transcript: "x",
        });
        expect(result.state).toBe(current);
        expect(result.effects).toHaveLength(0);
    });
});

describe("on-device outcome ordering: outcome lands during stopping", () => {
    // The real backend emits transcript_ready INSIDE the stop_recording
    // callable window, before the callable response travels back over the
    // single FIFO decky socket — so the frontend processes the outcome event
    // while the machine is still in `stopping`. An outcome rejected there is
    // lost forever and the card sits in `transcribing` (on-device finding).
    it("stopping → inserting on TRANSCRIPT_READY, trimmed, emitting INSERT_TEXT", () => {
        const result = transition(sessionState("stopping"), {
            type: "TRANSCRIPT_READY",
            sessionId: "s-1",
            transcript: "  hello world  ",
        });
        expect(result.state).toEqual({
            kind: "inserting",
            session: SESSION,
            transcript: "hello world",
        });
        expect(result.effects).toEqual([
            { type: "INSERT_TEXT", sessionId: "s-1", text: "hello world" },
        ]);
    });

    it("empty speech during stopping returns to ready without inserting", () => {
        const result = transition(sessionState("stopping"), {
            type: "TRANSCRIPT_READY",
            sessionId: "s-1",
            transcript: "   ",
        });
        expect(result.state).toEqual({ kind: "ready" });
        applied(result);
    });

    it("stale session ids stay rejected during stopping", () => {
        rejected(sessionState("stopping"), {
            type: "TRANSCRIPT_READY",
            sessionId: "s-2",
            transcript: "hello",
        });
    });
});

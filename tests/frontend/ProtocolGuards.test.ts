/**
 * Boundary type-guard tests (spec §99): backend JSON and settings payloads are
 * validated manually before use; no blind casts.
 */

import { describe, expect, it } from "vitest";

import { DICTATION_ERROR_CODES, isDictationErrorCode } from "../../src/domain/DictationError";
import { isRuntimeCapabilities } from "../../src/domain/Capability";
import {
    isCdpDiagnosticsReport,
    isDictationFlowReport,
    isRuntimeStatusReport,
} from "../../src/application/ports/SpeechPort";
import {
    isSpeechCapabilities,
    isSpeechRuntimeStatus,
    isTranscriptClipboardStatus,
    isTranscriptReadyPayload,
    type TranscriptReadyPayload,
} from "../../src/application/ports/SpeechPort";
import { isRecordingLevelPayload } from "../../src/application/ports/LevelMeterPort";
import { isPluginSettings, type PluginSettings } from "../../src/application/ports/SettingsPort";

const VALID_PAYLOAD: TranscriptReadyPayload = {
    protocolVersion: 1,
    sessionId: "s-1",
    text: "hello",
    metrics: {
        audioDurationMs: 1500,
        transcriptionDurationMs: 320,
        modelId: "base",
        computeBackend: "cpu",
    },
};

const VALID_SETTINGS: PluginSettings = {
    schemaVersion: 1,
    enabled: true,
    computeBackend: "auto",
    modelId: "base",
    language: "system",
    maxRecordingSeconds: 60,
    vadEnabled: true,
    outputMode: "direct-insert",
};

describe("isTranscriptReadyPayload (§67)", () => {
    it("accepts a valid versioned payload", () => {
        expect(isTranscriptReadyPayload(structuredClone(VALID_PAYLOAD))).toBe(true);
    });

    it("rejects wrong or missing protocol version", () => {
        expect(isTranscriptReadyPayload({ ...VALID_PAYLOAD, protocolVersion: 2 })).toBe(false);
        const withoutVersion: Record<string, unknown> = { ...VALID_PAYLOAD };
        delete withoutVersion["protocolVersion"];
        expect(isTranscriptReadyPayload(withoutVersion)).toBe(false);
    });

    it("rejects bad session ids, text and metrics", () => {
        expect(isTranscriptReadyPayload({ ...VALID_PAYLOAD, sessionId: 7 })).toBe(false);
        expect(isTranscriptReadyPayload({ ...VALID_PAYLOAD, text: null })).toBe(false);
        expect(isTranscriptReadyPayload({ ...VALID_PAYLOAD, metrics: null })).toBe(false);
        expect(
            isTranscriptReadyPayload({
                ...VALID_PAYLOAD,
                metrics: { ...VALID_PAYLOAD.metrics, computeBackend: "gpu" },
            }),
        ).toBe(false);
        expect(
            isTranscriptReadyPayload({
                ...VALID_PAYLOAD,
                metrics: { ...VALID_PAYLOAD.metrics, audioDurationMs: "1500" },
            }),
        ).toBe(false);
    });

    it("rejects non-objects", () => {
        expect(isTranscriptReadyPayload(null)).toBe(false);
        expect(isTranscriptReadyPayload("payload")).toBe(false);
        expect(isTranscriptReadyPayload(undefined)).toBe(false);
    });

    it("accepts the additive v0.2 clipboard field when valid and rejects it when not", () => {
        for (const clipboard of ["ok", "failed", "skipped"] as const) {
            expect(isTranscriptReadyPayload({ ...VALID_PAYLOAD, clipboard })).toBe(true);
        }
        expect(isTranscriptClipboardStatus("ok")).toBe(true);
        expect(isTranscriptClipboardStatus("maybe")).toBe(false);
        // §99: an unknown clipboard outcome is a boundary violation.
        expect(isTranscriptReadyPayload({ ...VALID_PAYLOAD, clipboard: "maybe" })).toBe(false);
        expect(isTranscriptReadyPayload({ ...VALID_PAYLOAD, clipboard: 1 })).toBe(false);
    });
});

describe("isRecordingLevelPayload + isDictationFlowReport (v0.2, §67/§99)", () => {
    it("accepts a valid recording_level vector", () => {
        expect(
            isRecordingLevelPayload({
                protocolVersion: 1,
                kind: "recording_level",
                seq: 4294967290,
                frames: [
                    [-0.5, 0.5, -6.021],
                    [0, 0, -120],
                ],
            }),
        ).toBe(true);
    });

    it("rejects malformed level vectors", () => {
        expect(
            isRecordingLevelPayload({
                protocolVersion: 1,
                kind: "recording_level",
                seq: -1,
                frames: [],
            }),
        ).toBe(false);
        expect(
            isRecordingLevelPayload({
                protocolVersion: 1,
                kind: "recording_level",
                seq: 1,
                frames: [[0, 0]],
            }),
        ).toBe(false);
        expect(
            isRecordingLevelPayload({
                protocolVersion: 1,
                kind: "recording_level",
                seq: 1,
                frames: [[Number.NaN, 0, 0]],
            }),
        ).toBe(false);
        expect(isRecordingLevelPayload({ protocolVersion: 1 })).toBe(false);
    });

    it("accepts a valid dictationFlow report and rejects malformed ones", () => {
        expect(isDictationFlowReport({ backendRunning: true, clipboard: "xclip" })).toBe(true);
        expect(isDictationFlowReport({ backendRunning: false, clipboard: "unavailable" })).toBe(
            true,
        );
        expect(isDictationFlowReport({ backendRunning: "yes", clipboard: "xclip" })).toBe(false);
        expect(isDictationFlowReport({ backendRunning: true, clipboard: "wl-copy" })).toBe(false);
        expect(isDictationFlowReport(null)).toBe(false);
    });

    it("validates the additive dictationFlow field on the status report only when present", () => {
        const base = {
            protocolVersion: 1,
            runtime: {
                running: true,
                state: "running",
                restartAttempts: 0,
                enabled: true,
                lastFailure: null,
            },
            modelDownloadInProgress: false,
        };
        expect(isRuntimeStatusReport(base)).toBe(true); // older backend
        expect(
            isRuntimeStatusReport({
                ...base,
                dictationFlow: { backendRunning: true, clipboard: "xclip" },
            }),
        ).toBe(true);
        expect(isRuntimeStatusReport({ ...base, dictationFlow: { backendRunning: true } })).toBe(
            false,
        );
    });
});

describe("isSpeechCapabilities and status (§57/§30)", () => {
    it("accepts a full capability report", () => {
        expect(
            isSpeechCapabilities({
                speechRuntimeAvailable: true,
                microphoneAvailable: true,
                cpuAvailable: true,
                vulkanAvailable: false,
                modelInstalled: true,
            }),
        ).toBe(true);
    });

    it("rejects missing or non-boolean fields", () => {
        expect(isSpeechCapabilities({ speechRuntimeAvailable: true })).toBe(false);
        expect(
            isSpeechCapabilities({
                speechRuntimeAvailable: "yes",
                microphoneAvailable: true,
                cpuAvailable: true,
                vulkanAvailable: true,
                modelInstalled: true,
            }),
        ).toBe(false);
    });

    it("validates runtime status values", () => {
        for (const status of ["starting", "ready", "unavailable", "crashed"] as const) {
            expect(isSpeechRuntimeStatus(status)).toBe(true);
        }
        expect(isSpeechRuntimeStatus("exploded")).toBe(false);
    });
});

describe("isRuntimeStatusReport + isCdpDiagnosticsReport (v0.1.6, §67/§99)", () => {
    const base = {
        protocolVersion: 1,
        runtime: {
            running: false,
            state: "stopped",
            restartAttempts: 0,
            enabled: true,
            lastFailure: null,
        },
        modelDownloadInProgress: false,
    };

    it("accepts the report without the optional cdpDiagnostics field (older backend)", () => {
        expect(isRuntimeStatusReport(base)).toBe(true);
    });

    it("accepts and preserves a valid cdpDiagnostics report", () => {
        const payload = {
            ...base,
            cdpDiagnostics: {
                cdpAvailable: false,
                spTargetSeen: true,
                keyboardSeen: true,
                keyboardVisible: false,
                reason: "remote-cdp-disabled",
            },
        };
        expect(isRuntimeStatusReport(payload)).toBe(true);
        expect(payload.cdpDiagnostics.reason).toBe("remote-cdp-disabled");
        expect(isCdpDiagnosticsReport(payload.cdpDiagnostics)).toBe(true);
    });

    it("rejects a malformed cdpDiagnostics field (§99)", () => {
        expect(
            isRuntimeStatusReport({
                ...base,
                cdpDiagnostics: { cdpAvailable: "yes", reason: null },
            }),
        ).toBe(false);
        expect(isCdpDiagnosticsReport({ cdpAvailable: true, reason: 42 })).toBe(false);
    });
});

describe("isPluginSettings (§54)", () => {
    it("accepts the §54 defaults", () => {
        expect(isPluginSettings(structuredClone(VALID_SETTINGS))).toBe(true);
    });

    it("rejects unknown union values, bad versions and invalid durations", () => {
        expect(isPluginSettings({ ...VALID_SETTINGS, schemaVersion: 2 })).toBe(false);
        expect(isPluginSettings({ ...VALID_SETTINGS, computeBackend: "quantum" })).toBe(false);
        expect(isPluginSettings({ ...VALID_SETTINGS, modelId: "large" })).toBe(false);
        expect(isPluginSettings({ ...VALID_SETTINGS, outputMode: "stream" })).toBe(false);
        expect(isPluginSettings({ ...VALID_SETTINGS, maxRecordingSeconds: 0 })).toBe(false);
        expect(isPluginSettings({ ...VALID_SETTINGS, maxRecordingSeconds: Number.NaN })).toBe(
            false,
        );
        expect(isPluginSettings({ ...VALID_SETTINGS, language: 1 })).toBe(false);
    });
});

describe("isRuntimeCapabilities (§57)", () => {
    it("accepts a complete boolean report", () => {
        expect(
            isRuntimeCapabilities({
                speechRuntimeAvailable: true,
                microphoneAvailable: true,
                cpuAvailable: true,
                vulkanAvailable: true,
                modelInstalled: true,
                keyboardHookAvailable: true,
                clipboardAvailable: true,
                nativePasteAvailable: true,
                directInsertAvailable: true,
            }),
        ).toBe(true);
    });

    it("rejects reports missing a field or with non-boolean values", () => {
        expect(
            isRuntimeCapabilities({
                speechRuntimeAvailable: true,
                microphoneAvailable: true,
                cpuAvailable: true,
                vulkanAvailable: true,
                modelInstalled: true,
                keyboardHookAvailable: true,
                clipboardAvailable: true,
                nativePasteAvailable: true,
            }),
        ).toBe(false);
        expect(isRuntimeCapabilities({ ...VALID_SETTINGS })).toBe(false);
    });
});

describe("isDictationErrorCode (§68)", () => {
    it("accepts every listed code and rejects unknown strings", () => {
        for (const code of DICTATION_ERROR_CODES) {
            expect(isDictationErrorCode(code)).toBe(true);
        }
        expect(isDictationErrorCode("SOMETHING_ELSE")).toBe(false);
        expect(isDictationErrorCode(42)).toBe(false);
    });
});

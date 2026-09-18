/**
 * Boundary type-guard tests (spec §99): backend JSON and settings payloads are
 * validated manually before use; no blind casts.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

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
import {
    isCatalogModel,
    isModelCatalogPayload,
    isModelDownloadCompletePayload,
    isModelDownloadProgressPayload,
} from "../../src/application/ports/ModelCatalogPort";
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
        // Regression (on-device 2026-09-18): the backend never emitted
        // `backendRunning` — its v0.2 dictationFlow is clipboard-only — so the
        // guard rejected every real get_status payload and the panel lost its
        // status feed. The field is additive-optional (§99), validated only
        // when present.
        expect(isDictationFlowReport({ clipboard: "unavailable" })).toBe(true);
        expect(isDictationFlowReport({ clipboard: "xclip" })).toBe(true);
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

    it("accepts the additive backendVersion only as a string, and accepts its absence (§99)", () => {
        const base = {
            speechRuntimeAvailable: true,
            microphoneAvailable: true,
            cpuAvailable: true,
            vulkanAvailable: true,
            modelInstalled: true,
        };
        expect(isSpeechCapabilities(base)).toBe(true); // older backend: field omitted
        expect(isSpeechCapabilities({ ...base, backendVersion: "0.2.3" })).toBe(true);
        expect(isSpeechCapabilities({ ...base, backendVersion: 42 })).toBe(false);
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

    it("accepts the verbatim on-device get_status payload (2026-09-18 boundary failure)", () => {
        // Production defect: SharedJSContext logged "dropped get_status payload:
        // boundary guard failed" because the real v0.2.0 backend emits
        // dictationFlow.clipboard only, while the guard required a
        // dictationFlow.backendRunning boolean the backend never sent. The
        // captured payload (tests/fixtures/status/get_status_real.json, origin
        // in its _captureOrigin key) must pass the guard as-is — unknown extra
        // keys like _captureOrigin are ignored (§99).
        const payload: unknown = JSON.parse(
            readFileSync(join(process.cwd(), "tests/fixtures/status/get_status_real.json"), "utf8"),
        );
        expect(isRuntimeStatusReport(payload)).toBe(true);
    });
});

describe("isPluginSettings (§54)", () => {
    it("accepts the §54 defaults", () => {
        expect(isPluginSettings(structuredClone(VALID_SETTINGS))).toBe(true);
    });

    it("accepts any well-formed curated catalog model id (ADR-011)", () => {
        expect(
            isPluginSettings({
                ...VALID_SETTINGS,
                modelId: "whisper-large-v3-turbo-q5_0",
            }),
        ).toBe(true);
        expect(isPluginSettings({ ...VALID_SETTINGS, modelId: "kotoba-whisper-v2.0-f16" })).toBe(
            true,
        );
    });

    it("rejects unknown union values, bad versions and invalid durations", () => {
        expect(isPluginSettings({ ...VALID_SETTINGS, schemaVersion: 2 })).toBe(false);
        expect(isPluginSettings({ ...VALID_SETTINGS, computeBackend: "quantum" })).toBe(false);
        expect(isPluginSettings({ ...VALID_SETTINGS, modelId: "Base;rm" })).toBe(false);
        expect(isPluginSettings({ ...VALID_SETTINGS, modelId: "" })).toBe(false);
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

describe("model catalog guards (§99, ADR-011)", () => {
    const VALID_MODEL = {
        id: "distil-small-en",
        engine: "whisper",
        multilingual: false,
        filename: "ggml-distil-small.en.bin",
        installed: false,
        sizeBytes: 336191657,
        languages: ["en"],
        description: "English-only distilled model with the lowest latency.",
    };

    it("accepts a full catalog entry and entries without additive fields", () => {
        expect(isCatalogModel(structuredClone(VALID_MODEL))).toBe(true);
        expect(isCatalogModel({ ...VALID_MODEL, sizeBytes: undefined })).toBe(true);
        expect(
            isCatalogModel({
                id: "base",
                engine: "whisper",
                multilingual: true,
                filename: "ggml-base.bin",
                installed: true,
            }),
        ).toBe(true);
    });

    it("rejects malformed catalog entries", () => {
        expect(isCatalogModel(null)).toBe(false);
        expect(isCatalogModel({ ...VALID_MODEL, id: "" })).toBe(false);
        expect(isCatalogModel({ ...VALID_MODEL, installed: "yes" })).toBe(false);
        expect(isCatalogModel({ ...VALID_MODEL, sizeBytes: "big" })).toBe(false);
        expect(isCatalogModel({ ...VALID_MODEL, languages: "en" })).toBe(false);
        expect(isCatalogModel({ ...VALID_MODEL, languages: [1] })).toBe(false);
        expect(isCatalogModel({ ...VALID_MODEL, description: 42 })).toBe(false);
    });

    it("accepts a versioned list_models payload and rejects malformed ones", () => {
        expect(isModelCatalogPayload({ protocolVersion: 1, models: [VALID_MODEL] })).toBe(true);
        expect(isModelCatalogPayload({ protocolVersion: 2, models: [VALID_MODEL] })).toBe(false);
        expect(isModelCatalogPayload({ protocolVersion: 1, models: "all" })).toBe(false);
        expect(isModelCatalogPayload({ protocolVersion: 1, models: [{ id: 1 }] })).toBe(false);
    });

    it("guards model_download_progress payloads (totalBytes may be null)", () => {
        expect(
            isModelDownloadProgressPayload({
                protocolVersion: 1,
                modelId: "base",
                bytesReceived: 1024,
                totalBytes: 147951465,
            }),
        ).toBe(true);
        expect(
            isModelDownloadProgressPayload({
                protocolVersion: 1,
                modelId: "base",
                bytesReceived: 0,
                totalBytes: null,
            }),
        ).toBe(true);
        expect(
            isModelDownloadProgressPayload({
                protocolVersion: 1,
                modelId: "base",
                bytesReceived: 0,
            }),
        ).toBe(false);
        expect(
            isModelDownloadProgressPayload({
                protocolVersion: 1,
                modelId: "",
                bytesReceived: 0,
                totalBytes: null,
            }),
        ).toBe(false);
    });

    it("guards model_download_complete payloads (sizeBytes optional/null)", () => {
        expect(isModelDownloadCompletePayload({ protocolVersion: 1, modelId: "base" })).toBe(true);
        expect(
            isModelDownloadCompletePayload({
                protocolVersion: 1,
                modelId: "base",
                sizeBytes: null,
            }),
        ).toBe(true);
        expect(
            isModelDownloadCompletePayload({ protocolVersion: 1, modelId: "base", sizeBytes: 12 }),
        ).toBe(true);
        expect(
            isModelDownloadCompletePayload({
                protocolVersion: 1,
                modelId: "base",
                sizeBytes: "12",
            }),
        ).toBe(false);
        expect(isModelDownloadCompletePayload({ protocolVersion: 1 })).toBe(false);
    });
});

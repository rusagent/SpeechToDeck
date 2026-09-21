import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { DICTATION_ERROR_CODES, isDictationErrorCode } from "../../src/domain/DictationError";
import { isRuntimeCapabilities } from "../../src/domain/Capability";
import {
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
};

describe("isTranscriptReadyPayload", () => {
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

    it("accepts the additive clipboard field when valid and rejects it when not", () => {
        for (const clipboard of ["ok", "failed", "skipped"] as const) {
            expect(isTranscriptReadyPayload({ ...VALID_PAYLOAD, clipboard })).toBe(true);
        }
        expect(isTranscriptClipboardStatus("ok")).toBe(true);
        expect(isTranscriptClipboardStatus("maybe")).toBe(false);
        expect(isTranscriptReadyPayload({ ...VALID_PAYLOAD, clipboard: "maybe" })).toBe(false);
        expect(isTranscriptReadyPayload({ ...VALID_PAYLOAD, clipboard: 1 })).toBe(false);
    });
});

describe("isRecordingLevelPayload + isDictationFlowReport", () => {
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
        expect(isRuntimeStatusReport(base)).toBe(true);
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

describe("isSpeechCapabilities and status", () => {
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

    it("accepts the additive backendVersion only as a string, and accepts its absence", () => {
        const base = {
            speechRuntimeAvailable: true,
            microphoneAvailable: true,
            cpuAvailable: true,
            vulkanAvailable: true,
            modelInstalled: true,
        };
        expect(isSpeechCapabilities(base)).toBe(true);
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

describe("isRuntimeStatusReport", () => {
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

    it("accepts the minimal report (additive fields absent)", () => {
        expect(isRuntimeStatusReport(base)).toBe(true);
    });

    it("accepts the verbatim on-device get_status payload (past boundary failure)", () => {
        const payload: unknown = JSON.parse(
            readFileSync(join(process.cwd(), "tests/fixtures/status/get_status_real.json"), "utf8"),
        );
        expect(isRuntimeStatusReport(payload)).toBe(true);
    });
});

describe("isPluginSettings", () => {
    it("accepts the documented defaults", () => {
        expect(isPluginSettings(structuredClone(VALID_SETTINGS))).toBe(true);
    });

    it("accepts any well-formed curated catalog model id", () => {
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

    it("rejects unknown union values and bad versions", () => {
        expect(isPluginSettings({ ...VALID_SETTINGS, schemaVersion: 2 })).toBe(false);
        expect(isPluginSettings({ ...VALID_SETTINGS, computeBackend: "quantum" })).toBe(false);
        expect(isPluginSettings({ ...VALID_SETTINGS, modelId: "Base;rm" })).toBe(false);
        expect(isPluginSettings({ ...VALID_SETTINGS, modelId: "" })).toBe(false);
        expect(isPluginSettings({ ...VALID_SETTINGS, language: 1 })).toBe(false);
    });

    it("tolerates the removed legacy keys (superset accepted, never rejected)", () => {
        expect(
            isPluginSettings({ ...VALID_SETTINGS, maxRecordingSeconds: 110, vadEnabled: true }),
        ).toBe(true);
    });
});

describe("isRuntimeCapabilities", () => {
    it("accepts a complete boolean report", () => {
        expect(
            isRuntimeCapabilities({
                speechRuntimeAvailable: true,
                microphoneAvailable: true,
                cpuAvailable: true,
                vulkanAvailable: true,
                modelInstalled: true,
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
            }),
        ).toBe(false);
        expect(isRuntimeCapabilities({ ...VALID_SETTINGS })).toBe(false);
    });
});

describe("isDictationErrorCode", () => {
    it("accepts every listed code and rejects unknown strings", () => {
        for (const code of DICTATION_ERROR_CODES) {
            expect(isDictationErrorCode(code)).toBe(true);
        }
        expect(isDictationErrorCode("SOMETHING_ELSE")).toBe(false);
        expect(isDictationErrorCode(42)).toBe(false);
    });
});

describe("model catalog guards", () => {
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

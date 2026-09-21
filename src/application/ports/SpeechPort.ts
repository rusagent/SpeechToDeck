import type { DictationError } from "../../domain/DictationError";
import type { Disposable } from "../../shared/Disposable";

export interface SpeechCapabilities {
    readonly speechRuntimeAvailable: boolean;
    readonly microphoneAvailable: boolean;
    readonly cpuAvailable: boolean;
    readonly vulkanAvailable: boolean;
    readonly modelInstalled: boolean;
    readonly backendVersion?: string;
}

export interface TranscriptionMetrics {
    readonly audioDurationMs: number;
    readonly transcriptionDurationMs: number;
    readonly modelId: string;
    readonly computeBackend: "cpu" | "vulkan";
}

export type TranscriptClipboardStatus = "ok" | "failed" | "skipped";

export interface TranscriptReadyPayload {
    readonly protocolVersion: 1;
    readonly sessionId: string;
    readonly text: string;
    readonly metrics: TranscriptionMetrics;
    readonly clipboard?: TranscriptClipboardStatus;
}

export type SpeechRuntimeStatus = "starting" | "ready" | "unavailable" | "crashed";

export interface RuntimeFailureRecord {
    readonly code: string;
    readonly stepIndex: number;
}

export interface DictationFlowReport {
    readonly backendRunning?: boolean;
    readonly clipboard: "xclip" | "unavailable";
}

export function isDictationFlowReport(value: unknown): value is DictationFlowReport {
    if (!isRecord(value)) {
        return false;
    }
    const backendRunning = value["backendRunning"];
    if (backendRunning !== undefined && typeof backendRunning !== "boolean") {
        return false;
    }
    return value["clipboard"] === "xclip" || value["clipboard"] === "unavailable";
}

export interface RuntimeStatusReport {
    readonly protocolVersion: 1;
    readonly runtime: {
        readonly running: boolean;
        readonly state: string;
        readonly restartAttempts: number;
        readonly enabled: boolean;
        readonly lastFailure: RuntimeFailureRecord | null;
    };
    readonly modelDownloadInProgress: boolean;
    readonly dictationFlow?: DictationFlowReport;
}

export function isRuntimeStatusReport(value: unknown): value is RuntimeStatusReport {
    if (!isRecord(value) || value["protocolVersion"] !== 1) {
        return false;
    }
    const runtime = value["runtime"];
    if (!isRecord(runtime)) {
        return false;
    }
    if (
        typeof runtime["running"] !== "boolean" ||
        typeof runtime["state"] !== "string" ||
        typeof runtime["restartAttempts"] !== "number" ||
        typeof runtime["enabled"] !== "boolean"
    ) {
        return false;
    }
    const failure = runtime["lastFailure"];
    if (
        failure !== null &&
        (!isRecord(failure) ||
            typeof failure["code"] !== "string" ||
            failure["code"].length === 0 ||
            typeof failure["stepIndex"] !== "number")
    ) {
        return false;
    }
    const flow = value["dictationFlow"];
    if (flow !== undefined && !isDictationFlowReport(flow)) {
        return false;
    }
    return typeof value["modelDownloadInProgress"] === "boolean";
}

export type SpeechEvent =
    | { readonly type: "transcript-ready"; readonly payload: TranscriptReadyPayload }
    | {
          readonly type: "speech-error";
          readonly error: DictationError;
          readonly sessionId: string | null;
      }
    | { readonly type: "runtime-status"; readonly status: SpeechRuntimeStatus };

export type SpeechEventListener = (event: SpeechEvent) => void;

export interface SpeechPort {
    initialize(): Promise<SpeechCapabilities>;

    startRecording(sessionId: string): Promise<void>;

    stopRecording(sessionId: string): Promise<void>;

    cancelRecording(sessionId: string): Promise<void>;

    subscribe(listener: SpeechEventListener): Disposable;

    shutdown(): Promise<void>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

export function isSpeechCapabilities(value: unknown): value is SpeechCapabilities {
    if (!isRecord(value)) {
        return false;
    }
    const backendVersion = value["backendVersion"];
    if (backendVersion !== undefined && typeof backendVersion !== "string") {
        return false;
    }
    return (
        typeof value["speechRuntimeAvailable"] === "boolean" &&
        typeof value["microphoneAvailable"] === "boolean" &&
        typeof value["cpuAvailable"] === "boolean" &&
        typeof value["vulkanAvailable"] === "boolean" &&
        typeof value["modelInstalled"] === "boolean"
    );
}

function isTranscriptionMetrics(value: unknown): value is TranscriptionMetrics {
    if (!isRecord(value)) {
        return false;
    }
    return (
        typeof value["audioDurationMs"] === "number" &&
        typeof value["transcriptionDurationMs"] === "number" &&
        typeof value["modelId"] === "string" &&
        (value["computeBackend"] === "cpu" || value["computeBackend"] === "vulkan")
    );
}

export function isTranscriptReadyPayload(value: unknown): value is TranscriptReadyPayload {
    if (!isRecord(value)) {
        return false;
    }
    const clipboard = value["clipboard"];
    if (clipboard !== undefined && !isTranscriptClipboardStatus(clipboard)) {
        return false;
    }
    return (
        value["protocolVersion"] === 1 &&
        typeof value["sessionId"] === "string" &&
        typeof value["text"] === "string" &&
        isTranscriptionMetrics(value["metrics"])
    );
}

export function isTranscriptClipboardStatus(value: unknown): value is TranscriptClipboardStatus {
    return value === "ok" || value === "failed" || value === "skipped";
}

export function isSpeechRuntimeStatus(value: unknown): value is SpeechRuntimeStatus {
    return (
        value === "starting" || value === "ready" || value === "unavailable" || value === "crashed"
    );
}

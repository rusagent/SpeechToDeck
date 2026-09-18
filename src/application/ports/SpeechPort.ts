/**
 * Frontend speech contract (spec §29) plus the versioned backend protocol
 * payloads it pushes (spec §67) with their manual boundary type guards (§99).
 */

import type { DictationError } from "../../domain/DictationError";
import type { Disposable } from "../../shared/Disposable";

/** Startup report of the speech runtime (speech-side fields of spec §57). */
export interface SpeechCapabilities {
    readonly speechRuntimeAvailable: boolean;
    readonly microphoneAvailable: boolean;
    readonly cpuAvailable: boolean;
    readonly vulkanAvailable: boolean;
    readonly modelInstalled: boolean;
    /**
     * Additive diagnostics fact (§67/§99): the backend plugin version, read
     * once from package.json at composition and rendered by the diagnostics
     * panel when present. Older backends omit the field.
     */
    readonly backendVersion?: string;
}

/**
 * Transcription metrics (spec §67). Contain no spoken content beyond the
 * transcript delivered locally with them.
 */
export interface TranscriptionMetrics {
    readonly audioDurationMs: number;
    readonly transcriptionDurationMs: number;
    readonly modelId: string;
    readonly computeBackend: "cpu" | "vulkan";
}

/**
 * Versioned `transcript_ready` payload (spec §67). `clipboard` is additive
 * since v0.2: outcome of the backend's best-effort system-clipboard write —
 * "ok" (written), "failed" (attempted, not written), "skipped" (not
 * attempted; the frontend copy is primary). Older backends omit it.
 */
export type TranscriptClipboardStatus = "ok" | "failed" | "skipped";

export interface TranscriptReadyPayload {
    readonly protocolVersion: 1;
    readonly sessionId: string;
    readonly text: string;
    readonly metrics: TranscriptionMetrics;
    readonly clipboard?: TranscriptClipboardStatus;
}

/** Runtime status reported by the backend (`speech_status`/`runtime_status`, spec §30). */
export type SpeechRuntimeStatus = "starting" | "ready" | "unavailable" | "crashed";

/** Stored last §82 startup failure in the `get_status` report (§68 code). */
export interface RuntimeFailureRecord {
    readonly code: string;
    readonly stepIndex: number;
}

/**
 * Optional v0.1.6 cross-view diagnostics report (additive `get_status` field,
 * §67): read-only CDP facts behind the user's "Allow Remote CEF Debugging"
 * toggle. `reason` is a stable lowercase code (never UI text).
 */
export interface CdpDiagnosticsReport {
    readonly cdpAvailable: boolean;
    readonly spTargetSeen: boolean;
    readonly keyboardSeen: boolean;
    readonly keyboardVisible: boolean;
    readonly reason: string | null;
}

export function isCdpDiagnosticsReport(value: unknown): value is CdpDiagnosticsReport {
    if (!isRecord(value)) {
        return false;
    }
    return (
        typeof value["cdpAvailable"] === "boolean" &&
        typeof value["spTargetSeen"] === "boolean" &&
        typeof value["keyboardSeen"] === "boolean" &&
        typeof value["keyboardVisible"] === "boolean" &&
        (value["reason"] === null || typeof value["reason"] === "string")
    );
}

/**
 * Additive v0.2 dictation-flow facts (optional `get_status` field): which
 * clipboard backend is active — "xclip" (backend writer ready) or
 * "unavailable" (the frontend copy is primary). `clipboard` is always
 * present; `backendRunning` is additive and validated only when present
 * (§99): the shipped v0.2.0 backend reports the clipboard fact only, so the
 * panel derives the running/stopped fact from the same report's
 * `runtime.running`.
 */
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

/**
 * Versioned `get_status` response (spec §30/§67), fields the frontend
 * consumes. `runtime.lastFailure` is the backend's stored §82 startup
 * failure (or null) and drives the setup panel's failure hydration.
 * `cdpDiagnostics` is additive since v0.1.6 and validated only when present
 * (§99: older backends omit it).
 */
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
    readonly cdpDiagnostics?: CdpDiagnosticsReport;
    /** Additive since v0.2 (§99: validated only when present). */
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
    const cdp = value["cdpDiagnostics"];
    if (cdp !== undefined && !isCdpDiagnosticsReport(cdp)) {
        return false;
    }
    const flow = value["dictationFlow"];
    if (flow !== undefined && !isDictationFlowReport(flow)) {
        return false;
    }
    return typeof value["modelDownloadInProgress"] === "boolean";
}

/** Events pushed by the speech port (spec §29/§30). */
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
    // Additive since v0.2.4 (§99): validated only when present, so older
    // backend payloads without backendVersion stay valid.
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

export function isTranscriptionMetrics(value: unknown): value is TranscriptionMetrics {
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

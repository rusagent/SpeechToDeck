/**
 * DeckySpeechAdapter (spec §29/§30) — maps the application SpeechPort onto
 * the frozen §30 Decky callables and backend events. No domain logic: every
 * payload crossing the boundary is validated with the §99 type guards before
 * it is emitted into the application; unvalidated payloads are dropped with
 * a warning instead of being passed on.
 */

import { DictationError, isDictationErrorCode } from "../../domain/DictationError";
import type { DictationErrorCode } from "../../domain/DictationError";
import type { Disposable } from "../../shared/Disposable";
import { Logger } from "../../shared/Logger";
import type {
    SpeechCapabilities,
    SpeechEvent,
    SpeechEventListener,
    SpeechPort,
    SpeechRuntimeStatus,
} from "../../application/ports/SpeechPort";
import {
    isRuntimeStatusReport,
    isSpeechCapabilities,
    isSpeechRuntimeStatus,
    isTranscriptReadyPayload,
} from "../../application/ports/SpeechPort";
import type { SetupProgressSnapshot } from "../../application/ports/SetupProgressPort";
import {
    SetupProgressStore,
    isSetupProgressSnapshot,
} from "../../application/ports/SetupProgressPort";
import type { DeckyBackendClient } from "./DeckyBackendClient";

/**
 * Frozen §30 callable and event names (the Python backend lane implements
 * the same names in parallel).
 */
export const SPEECH_CALLABLES = {
    getCapabilities: "get_capabilities",
    getStatus: "get_status",
    startRecording: "start_recording",
    stopRecording: "stop_recording",
    cancelRecording: "cancel_recording",
} as const;

export const SPEECH_EVENTS = {
    speechStatus: "speech_status",
    transcriptReady: "transcript_ready",
    speechError: "speech_error",
    runtimeStatus: "runtime_status",
    setupProgress: "setup_progress",
} as const;

/** The four setup steps of the frozen `setup_progress` contract. */
const SETUP_TOTAL_STEPS = 4;

/** Versioned `speech_error` backend payload (§67): stable code, no parsing. */
export interface SpeechErrorPayload {
    readonly code: DictationErrorCode;
    readonly message?: string;
    readonly sessionId?: string | null;
}

function isSpeechErrorPayload(value: unknown): value is SpeechErrorPayload {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const record = value as Record<string, unknown>;
    if (!isDictationErrorCode(record["code"])) {
        return false;
    }
    const message = record["message"];
    const sessionId = record["sessionId"];
    if (message !== undefined && typeof message !== "string") {
        return false;
    }
    if (sessionId !== undefined && sessionId !== null && typeof sessionId !== "string") {
        return false;
    }
    return true;
}

/**
 * Versioned backend `runtime_status` payload (§67): the supervisor (§37) and
 * the status monitor (§41) publish `{protocolVersion, state, ...}` with the
 * supervisor states (starting/stopped/crashed/unavailable/restarted) and the
 * daemon states (idle/recording/transcribing/error/stopped).
 */
interface BackendRuntimeStatusPayload {
    readonly protocolVersion: unknown;
    readonly state: string;
}

function isBackendRuntimeStatusPayload(value: unknown): value is BackendRuntimeStatusPayload {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const record = value as Record<string, unknown>;
    return record["protocolVersion"] === 1 && typeof record["state"] === "string";
}

/**
 * Maps the backend's versioned payload onto the application runtime status
 * (§99: unknown states are dropped, never guessed).
 */
function mapBackendRuntimeStatus(payload: BackendRuntimeStatusPayload): SpeechRuntimeStatus | null {
    switch (payload.state) {
        case "starting":
            return "starting";
        case "restarted":
        case "idle":
        case "recording":
        case "transcribing":
            return "ready";
        case "crashed":
        case "error":
            return "crashed";
        case "stopped":
        case "unavailable":
        case "unknown":
            return "unavailable";
        default:
            return null;
    }
}

export class DeckySpeechAdapter implements SpeechPort {
    private readonly listeners = new Set<SpeechEventListener>();
    private backendEventDisposables: Disposable[] = [];
    /** Dropped `setup_progress` payloads for the count-logged boundary guard (§99). */
    private droppedSetupProgress = 0;

    /**
     * Latest guarded `setup_progress` snapshot for the plugin panel. Setup
     * progress is transport-level UI state and stays out of the dictation
     * events on purpose (§102: consumers subscribe only to relevant state).
     */
    readonly setupProgress = new SetupProgressStore();

    constructor(
        private readonly backend: DeckyBackendClient,
        private readonly logger: Logger = new Logger("speech.runtime"),
    ) {}

    async initialize(): Promise<SpeechCapabilities> {
        const payload = await this.backend.call(SPEECH_CALLABLES.getCapabilities);
        if (!isSpeechCapabilities(payload)) {
            throw new DictationError(
                "RUNTIME_START_FAILED",
                "get_capabilities returned an unexpected payload",
            );
        }
        return payload;
    }

    async startRecording(sessionId: string): Promise<void> {
        await this.backend.call(SPEECH_CALLABLES.startRecording, sessionId);
    }

    async stopRecording(sessionId: string): Promise<void> {
        await this.backend.call(SPEECH_CALLABLES.stopRecording, sessionId);
    }

    async cancelRecording(sessionId: string): Promise<void> {
        await this.backend.call(SPEECH_CALLABLES.cancelRecording, sessionId);
    }

    subscribe(listener: SpeechEventListener): Disposable {
        this.listeners.add(listener);
        this.ensureBackendEventSubscriptions();
        return {
            dispose: () => {
                this.listeners.delete(listener);
            },
        };
    }

    /**
     * Unsubscribes the backend events (§83). Idempotent; the v1 frontend maps
     * `runtime_status` and `setup_progress`; `speech_status` carries no
     * distinct v1 consumer and is not subscribed.
     */
    async shutdown(): Promise<void> {
        for (const disposable of this.backendEventDisposables) {
            disposable.dispose();
        }
        this.backendEventDisposables = [];
        this.listeners.clear();
    }

    private ensureBackendEventSubscriptions(): void {
        if (this.backendEventDisposables.length > 0) {
            return;
        }
        this.backendEventDisposables = [
            this.backend.subscribe(SPEECH_EVENTS.transcriptReady, (payload) =>
                this.onTranscriptReady(payload),
            ),
            this.backend.subscribe(SPEECH_EVENTS.speechError, (payload) =>
                this.onSpeechError(payload),
            ),
            this.backend.subscribe(SPEECH_EVENTS.runtimeStatus, (payload) =>
                this.onRuntimeStatus(payload),
            ),
            this.backend.subscribe(SPEECH_EVENTS.setupProgress, (payload) =>
                this.onSetupProgress(payload),
            ),
        ];
    }

    private onTranscriptReady(payload: unknown): void {
        if (!isTranscriptReadyPayload(payload)) {
            this.logger.warn("dropped transcript_ready payload: boundary guard failed");
            return;
        }
        this.dispatch({ type: "transcript-ready", payload });
    }

    private onSpeechError(payload: unknown): void {
        if (!isSpeechErrorPayload(payload)) {
            this.logger.warn("dropped speech_error payload: boundary guard failed");
            return;
        }
        this.dispatch({
            type: "speech-error",
            error: new DictationError(payload.code, payload.message),
            sessionId: payload.sessionId ?? null,
        });
    }

    private onRuntimeStatus(payload: unknown): void {
        // Canonical backend form is the versioned payload; a bare status
        // string is also accepted (both are guarded, §99).
        let status: SpeechRuntimeStatus | null = null;
        if (isBackendRuntimeStatusPayload(payload)) {
            status = mapBackendRuntimeStatus(payload);
        } else if (isSpeechRuntimeStatus(payload)) {
            status = payload;
        }
        if (status === null) {
            this.logger.warn("dropped runtime_status payload: boundary guard failed");
            return;
        }
        this.dispatch({ type: "runtime-status", status });
    }

    private onSetupProgress(payload: unknown): void {
        if (!isSetupProgressSnapshot(payload)) {
            this.droppedSetupProgress += 1;
            this.logger.warn("dropped setup_progress payload: boundary guard failed", {
                dropped: this.droppedSetupProgress,
            });
            return;
        }
        this.setupProgress.publish(payload);
    }

    /**
     * Hydrates the setup store from the §30 status report so a startup
     * failure that fired before this frontend subscribed still surfaces
     * (on-device v0.1.3 finding: the terminal `failed` event preceded the
     * panel mount and was never seen again). Runtime down with a stored last
     * failure and no download in flight → synthesized terminal `failed`
     * view with the failing step from the report (0 when absent). Live wins:
     * an existing snapshot — a live event or an earlier hydration — is never
     * overwritten, and any later live `setup_progress` event replaces it.
     */
    async hydrateSetupFromStatus(): Promise<void> {
        if (this.setupProgress.getSnapshot() !== null) {
            return;
        }
        let payload: unknown;
        try {
            payload = await this.backend.call(SPEECH_CALLABLES.getStatus);
        } catch (error) {
            this.logger.warn("setup hydration call failed", {
                detail: error instanceof Error ? error.message : String(error),
            });
            return;
        }
        if (!isRuntimeStatusReport(payload)) {
            this.logger.warn("dropped get_status payload: boundary guard failed");
            return;
        }
        const { runtime, modelDownloadInProgress } = payload;
        const failure = runtime.lastFailure;
        if (runtime.running || modelDownloadInProgress || !runtime.enabled || failure === null) {
            return;
        }
        const stepIndex =
            Number.isInteger(failure.stepIndex) &&
            failure.stepIndex >= 0 &&
            failure.stepIndex <= SETUP_TOTAL_STEPS
                ? failure.stepIndex
                : 0;
        const synthesized: SetupProgressSnapshot = {
            protocolVersion: 1,
            step: "failed",
            labelKey: "setup.state.failed",
            stepIndex,
            totalSteps: SETUP_TOTAL_STEPS,
            percent: 0,
            indeterminate: false,
            error: { code: failure.code },
        };
        if (isSetupProgressSnapshot(synthesized)) {
            this.setupProgress.publish(synthesized);
        }
    }

    private dispatch(event: SpeechEvent): void {
        for (const listener of [...this.listeners]) {
            try {
                listener(event);
            } catch (error) {
                this.logger.error("speech listener failed", {
                    eventType: event.type,
                    detail: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }
}

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
    isSpeechCapabilities,
    isSpeechRuntimeStatus,
    isTranscriptReadyPayload,
} from "../../application/ports/SpeechPort";
import type { DeckyBackendClient } from "./DeckyBackendClient";

/**
 * Frozen §30 callable and event names (the Python backend lane implements
 * the same names in parallel).
 */
export const SPEECH_CALLABLES = {
    getCapabilities: "get_capabilities",
    startRecording: "start_recording",
    stopRecording: "stop_recording",
    cancelRecording: "cancel_recording",
} as const;

export const SPEECH_EVENTS = {
    speechStatus: "speech_status",
    transcriptReady: "transcript_ready",
    speechError: "speech_error",
    runtimeStatus: "runtime_status",
} as const;

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
     * `runtime_status`; `speech_status` carries no distinct v1 consumer and is
     * not subscribed.
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

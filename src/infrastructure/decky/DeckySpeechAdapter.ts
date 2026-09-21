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
import { LevelMeterStore, isRecordingLevelPayload } from "../../application/ports/LevelMeterPort";
import type { CatalogModel } from "../../application/ports/ModelCatalogPort";
import {
    ModelCatalogStore,
    isModelCatalogPayload,
    isModelDownloadCompletePayload,
    isModelDownloadProgressPayload,
} from "../../application/ports/ModelCatalogPort";
import { PanelTranscriptStore } from "../../application/ports/PanelTranscriptPort";
import type { DeckyBackendClient } from "./DeckyBackendClient";

export const SPEECH_CALLABLES = {
    getCapabilities: "get_capabilities",
    getStatus: "get_status",
    startRecording: "start_recording",
    stopRecording: "stop_recording",
    cancelRecording: "cancel_recording",
    listModels: "list_models",
    downloadModel: "download_model",
    cancelModelDownload: "cancel_model_download",
    deleteModel: "delete_model",
} as const;

const SPEECH_EVENTS = {
    speechStatus: "speech_status",
    transcriptReady: "transcript_ready",
    speechError: "speech_error",
    runtimeStatus: "runtime_status",
    setupProgress: "setup_progress",
    recordingLevel: "recording_level",
    modelDownloadProgress: "model_download_progress",
    modelDownloadComplete: "model_download_complete",
} as const;

const SETUP_TOTAL_STEPS = 4;

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
    private droppedSetupProgress = 0;
    private droppedRecordingLevel = 0;
    private droppedModelDownload = 0;

    readonly setupProgress = new SetupProgressStore();

    readonly levelMeter = new LevelMeterStore();

    readonly panelTranscript = new PanelTranscriptStore();

    readonly modelCatalog = new ModelCatalogStore();

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

    async listModels(): Promise<readonly CatalogModel[]> {
        const payload = await this.backend.call(SPEECH_CALLABLES.listModels);
        if (!isModelCatalogPayload(payload)) {
            throw new DictationError(
                "INTERNAL_ERROR",
                "list_models returned an unexpected payload",
            );
        }
        this.modelCatalog.setModels(payload.models);
        return payload.models;
    }

    async downloadModel(modelId: string): Promise<void> {
        this.modelCatalog.clearFailure();
        try {
            await this.backend.call(SPEECH_CALLABLES.downloadModel, modelId);
        } catch (error) {
            const code = error instanceof DictationError ? error.code : undefined;
            if (code === "MODEL_DOWNLOAD_CANCELLED") {
                this.logger.info("model download cancelled", { modelId });
                this.modelCatalog.clearDownload();
                return;
            }
            this.modelCatalog.publishFailure(
                modelId,
                error instanceof Error && error.message.length > 0 ? error.message : null,
            );
            throw error;
        }
    }

    async cancelModelDownload(): Promise<void> {
        await this.backend.call(SPEECH_CALLABLES.cancelModelDownload);
    }

    async deleteModel(modelId: string): Promise<void> {
        await this.backend.call(SPEECH_CALLABLES.deleteModel, modelId);
        this.modelCatalog.markDeleted(modelId);
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
            this.backend.subscribe(SPEECH_EVENTS.recordingLevel, (payload) =>
                this.onRecordingLevel(payload),
            ),
            this.backend.subscribe(SPEECH_EVENTS.modelDownloadProgress, (payload) =>
                this.onModelDownloadProgress(payload),
            ),
            this.backend.subscribe(SPEECH_EVENTS.modelDownloadComplete, (payload) =>
                this.onModelDownloadComplete(payload),
            ),
        ];
    }

    private onTranscriptReady(payload: unknown): void {
        if (!isTranscriptReadyPayload(payload)) {
            this.logger.warn("dropped transcript_ready payload: boundary guard failed");
            return;
        }
        if (payload.text.trim().length > 0) {
            this.panelTranscript.publish({
                sessionId: payload.sessionId,
                text: payload.text,
                clipboard: payload.clipboard ?? "skipped",
            });
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

    private onRecordingLevel(payload: unknown): void {
        if (!isRecordingLevelPayload(payload)) {
            this.droppedRecordingLevel += 1;
            this.logger.warn("dropped recording_level payload: boundary guard failed", {
                dropped: this.droppedRecordingLevel,
            });
            return;
        }
        this.levelMeter.publish(payload);
    }

    private onModelDownloadProgress(payload: unknown): void {
        if (!isModelDownloadProgressPayload(payload)) {
            this.droppedModelDownload += 1;
            this.logger.warn("dropped model_download_progress payload: boundary guard failed", {
                dropped: this.droppedModelDownload,
            });
            return;
        }
        this.modelCatalog.publishProgress(payload);
    }

    private onModelDownloadComplete(payload: unknown): void {
        if (!isModelDownloadCompletePayload(payload)) {
            this.droppedModelDownload += 1;
            this.logger.warn("dropped model_download_complete payload: boundary guard failed", {
                dropped: this.droppedModelDownload,
            });
            return;
        }
        this.modelCatalog.publishComplete(payload);
    }

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

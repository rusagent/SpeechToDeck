import { Deferred } from "../../../src/shared/Deferred";
import type { Disposable } from "../../../src/shared/Disposable";
import type { DictationError } from "../../../src/domain/DictationError";
import type {
    SpeechCapabilities,
    SpeechEventListener,
    SpeechPort,
    SpeechRuntimeStatus,
} from "../../../src/application/ports/SpeechPort";
import type { TranscriptionMetrics } from "../../../src/application/ports/SpeechPort";

export const TEST_METRICS: TranscriptionMetrics = {
    audioDurationMs: 1500,
    transcriptionDurationMs: 320,
    modelId: "base",
    computeBackend: "cpu",
};

export const ALL_CAPABILITIES: SpeechCapabilities = {
    speechRuntimeAvailable: true,
    microphoneAvailable: true,
    cpuAvailable: true,
    vulkanAvailable: true,
    modelInstalled: true,
};

/**
 * In-memory SpeechPort fake. `startRecording`/`stopRecording` stay pending
 * until the test resolves or rejects them, modelling the acknowledgement
 * boundary (spec §75).
 */
export class FakeSpeechPort implements SpeechPort {
    readonly trace: string[];
    readonly startCalls: string[] = [];
    readonly stopCalls: string[] = [];
    readonly cancelCalls: string[] = [];

    initializeResult: SpeechCapabilities = { ...ALL_CAPABILITIES };
    initializeError: Error | null = null;

    private listener: SpeechEventListener | null = null;
    private readonly pendingStarts = new Map<string, Deferred<void>>();
    private readonly pendingStops = new Map<string, Deferred<void>>();

    constructor(trace: string[] = []) {
        this.trace = trace;
    }

    async initialize(): Promise<SpeechCapabilities> {
        this.trace.push("speech.initialize");
        if (this.initializeError !== null) {
            throw this.initializeError;
        }
        return this.initializeResult;
    }

    async startRecording(sessionId: string): Promise<void> {
        this.trace.push(`speech.startRecording:${sessionId}`);
        this.startCalls.push(sessionId);
        const deferred = new Deferred<void>();
        this.pendingStarts.set(sessionId, deferred);
        await deferred.promise;
    }

    async stopRecording(sessionId: string): Promise<void> {
        this.trace.push(`speech.stopRecording:${sessionId}`);
        this.stopCalls.push(sessionId);
        const deferred = new Deferred<void>();
        this.pendingStops.set(sessionId, deferred);
        await deferred.promise;
    }

    async cancelRecording(sessionId: string): Promise<void> {
        this.trace.push(`speech.cancelRecording:${sessionId}`);
        this.cancelCalls.push(sessionId);
        // Cancellation resolves immediately and emits no transcript (§72).
        this.pendingStarts.get(sessionId)?.resolve(undefined);
        this.pendingStops.get(sessionId)?.resolve(undefined);
    }

    async shutdown(): Promise<void> {
        this.trace.push("speech.shutdown");
    }

    subscribe(listener: SpeechEventListener): Disposable {
        this.listener = listener;
        return {
            dispose: () => {
                this.listener = null;
            },
        };
    }

    // ── test controls ──

    resolveStart(sessionId: string): void {
        const deferred = this.pendingStarts.get(sessionId);
        if (deferred !== undefined) {
            this.pendingStarts.delete(sessionId);
            deferred.resolve(undefined);
        }
    }

    rejectStart(sessionId: string, error: unknown): void {
        const deferred = this.pendingStarts.get(sessionId);
        if (deferred !== undefined) {
            this.pendingStarts.delete(sessionId);
            deferred.reject(error);
        }
    }

    resolveStop(sessionId: string): void {
        const deferred = this.pendingStops.get(sessionId);
        if (deferred !== undefined) {
            this.pendingStops.delete(sessionId);
            deferred.resolve(undefined);
        }
    }

    emitTranscript(sessionId: string, text: string): void {
        this.listener?.({
            type: "transcript-ready",
            payload: {
                protocolVersion: 1,
                sessionId,
                text,
                metrics: TEST_METRICS,
            },
        });
    }

    emitError(error: DictationError, sessionId: string | null): void {
        this.listener?.({ type: "speech-error", error, sessionId });
    }

    emitStatus(status: SpeechRuntimeStatus): void {
        this.listener?.({ type: "runtime-status", status });
    }
}

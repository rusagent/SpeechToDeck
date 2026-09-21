import type { RuntimeCapabilities } from "../domain/Capability";
import { DictationError } from "../domain/DictationError";
import type { DictationErrorCode } from "../domain/DictationError";
import type { DictationState } from "../domain/DictationState";
import { extractSession } from "../domain/DictationState";
import type { Disposable } from "../shared/Disposable";
import { Logger, nullSink } from "../shared/Logger";
import { Mutex } from "../shared/Mutex";
import { assertNever } from "../shared/assertNever";
import { transition } from "./DictationStateMachine";
import type { DictationEffect, TransitionResult } from "./DictationStateMachine";
import type { ClipboardPort } from "./ports/ClipboardPort";
import type { ClockPort } from "./ports/ClockPort";
import type { IdGeneratorPort } from "./ports/IdGeneratorPort";
import type { PluginSettings, SettingsPort } from "./ports/SettingsPort";
import type {
    SpeechCapabilities,
    SpeechEvent,
    SpeechPort,
    SpeechRuntimeStatus,
    TranscriptReadyPayload,
} from "./ports/SpeechPort";

export interface StateStore<T> {
    getSnapshot(): T;

    subscribe(listener: () => void): () => void;
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export type TimeoutHandle = ReturnType<typeof setTimeout>;

const STARTUP_WATCHDOG_MS = 10_000;

export interface StartupTimerSeam {
    readonly timeoutMs: number;
    schedule(handler: () => void, timeoutMs: number): TimeoutHandle;
    cancel(handle: TimeoutHandle): void;
}

const defaultStartupTimer: StartupTimerSeam = {
    timeoutMs: STARTUP_WATCHDOG_MS,
    schedule: (handler, timeoutMs) => setTimeout(handler, timeoutMs),
    cancel: (handle) => clearTimeout(handle),
};

export class DictationController implements Disposable, StateStore<DictationState> {
    private readonly mutex = new Mutex();
    private readonly listeners = new Set<() => void>();

    private state: DictationState = { kind: "booting" };
    private speechEvents: Disposable | null = null;
    private startupWatchdog: TimeoutHandle | null = null;
    private startupExpired = false;
    private started = false;
    private disposed = false;

    constructor(
        private readonly speech: SpeechPort,
        private readonly clipboard: ClipboardPort,
        private readonly settings: SettingsPort,
        private readonly clock: ClockPort,
        private readonly ids: IdGeneratorPort,
        private readonly logger: Logger = new Logger("dictation.session", nullSink),
        private readonly startupTimer: StartupTimerSeam = defaultStartupTimer,
    ) {}

    getSnapshot(): DictationState {
        return this.state;
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    async start(): Promise<void> {
        if (this.started || this.disposed) {
            return;
        }
        this.started = true;

        this.startupExpired = false;
        this.startupWatchdog = this.startupTimer.schedule(() => {
            this.startupWatchdog = null;
            this.startupExpired = true;
            this.logger.error("startup watchdog expired; reporting runtime unavailable");
            this.apply({ type: "STARTUP_FAILED", reason: "SPEECH_RUNTIME_UNAVAILABLE" });
        }, this.startupTimer.timeoutMs);

        try {
            this.speechEvents = this.speech.subscribe((event) => this.onSpeechEvent(event));

            let loadedSettings: PluginSettings;
            try {
                loadedSettings = await this.settings.load();
            } catch (error) {
                this.logger.error("settings load failed", { detail: describeError(error) });
                this.applyStartupOutcome({
                    type: "STARTUP_FAILED",
                    reason: "SETTINGS_LOAD_FAILED",
                });
                return;
            }

            let capabilities: SpeechCapabilities;
            try {
                capabilities = await this.speech.initialize();
            } catch (error) {
                this.logger.error("speech runtime initialize failed", {
                    detail: describeError(error),
                });
                this.applyStartupOutcome({
                    type: "STARTUP_FAILED",
                    reason: "SPEECH_RUNTIME_UNAVAILABLE",
                });
                return;
            }

            const report = this.buildRuntimeCapabilities(capabilities);
            this.applyStartupOutcome({
                type: "STARTUP_COMPLETED",
                capabilities: report,
                enabled: loadedSettings.enabled,
            });
        } finally {
            this.clearStartupWatchdog();
        }
    }

    async dispose(): Promise<void> {
        if (this.disposed) {
            return;
        }
        this.disposed = true;

        this.clearStartupWatchdog();

        const session = extractSession(this.state);
        if (session !== null) {
            try {
                await this.speech.cancelRecording(session.sessionId);
            } catch (error) {
                this.logger.warn("cancel during dispose failed", { detail: describeError(error) });
            }
        }

        this.speechEvents?.dispose();
        this.speechEvents = null;
        this.listeners.clear();
    }

    async handlePanelMicrophonePressed(): Promise<void> {
        if (this.disposed) {
            return;
        }
        const kind = this.state.kind;
        if (kind !== "ready" && kind !== "recording") {
            return;
        }
        await this.mutex.runExclusive(async () => {
            const current = this.state;
            if (current.kind === "ready") {
                this.apply({
                    type: "MICROPHONE_PRESSED",
                    session: {
                        sessionId: this.ids.nextId(),
                        startedAtMonotonicMs: this.clock.nowMonotonicMs(),
                    },
                });
                return;
            }
            if (current.kind === "recording") {
                this.apply({ type: "MICROPHONE_PRESSED" });
            }
        });
    }

    async requestCancel(): Promise<void> {
        if (this.disposed) {
            return;
        }
        await this.mutex.runExclusive(async () => {
            this.apply({ type: "CANCEL_REQUESTED" });
        });
    }

    dismissError(): void {
        this.apply({ type: "ERROR_DISMISSED" });
    }

    private onSpeechEvent(event: SpeechEvent): void {
        switch (event.type) {
            case "transcript-ready":
                this.onTranscriptReady(event.payload);
                break;
            case "speech-error":
                this.onSpeechError(event.sessionId, event.error);
                break;
            case "runtime-status":
                this.onRuntimeStatus(event.status);
                break;
            default:
                assertNever(event);
        }
    }

    private onTranscriptReady(payload: TranscriptReadyPayload): void {
        const session = extractSession(this.state);
        if (session === null || payload.sessionId !== session.sessionId) {
            this.logger.info("stale transcript discarded", { sessionId: payload.sessionId });
            return;
        }
        this.apply({
            type: "TRANSCRIPT_READY",
            sessionId: session.sessionId,
            transcript: payload.text,
        });
    }

    private onSpeechError(sessionId: string | null, error: DictationError): void {
        const session = extractSession(this.state);
        if (session === null) {
            this.logger.warn("speech error without active session", { code: error.code });
            return;
        }
        if (sessionId !== null && sessionId !== session.sessionId) {
            this.logger.info("stale speech error discarded", { sessionId });
            return;
        }
        this.apply({ type: "SPEECH_FAILED", sessionId: session.sessionId, error });
    }

    private onRuntimeStatus(status: SpeechRuntimeStatus): void {
        if (status === "ready") {
            this.clearStaleErrorOnRuntimeReady();
            return;
        }
        if (status !== "crashed") {
            this.logger.info("runtime status", { status });
            return;
        }
        const session = extractSession(this.state);
        if (session === null) {
            this.logger.error("speech runtime crashed while idle");
            return;
        }
        this.apply({
            type: "SPEECH_FAILED",
            sessionId: session.sessionId,
            error: new DictationError("RUNTIME_CRASHED"),
        });
    }

    private clearStaleErrorOnRuntimeReady(): void {
        this.logger.info("runtime status", { status: "ready" });
        if (this.state.kind === "error") {
            this.apply({ type: "ERROR_DISMISSED" });
        }
    }

    private apply(event: Parameters<typeof transition>[1]): void {
        this.adopt(transition(this.state, event));
    }

    private adopt(next: TransitionResult): void {
        if (next.state === this.state) {
            return;
        }
        this.state = next.state;
        for (const listener of [...this.listeners]) {
            listener();
        }
        if (next.effects.length > 0) {
            void this.runEffects(next.effects);
        }
    }

    private async runEffects(effects: readonly DictationEffect[]): Promise<void> {
        for (const effect of effects) {
            switch (effect.type) {
                case "START_RECORDING": {
                    try {
                        await this.speech.startRecording(effect.sessionId);
                    } catch (error) {
                        this.speechFailed(effect.sessionId, error, "RECORDING_START_FAILED");
                        break;
                    }
                    this.apply({ type: "RECORDING_STARTED", sessionId: effect.sessionId });
                    break;
                }
                case "STOP_RECORDING": {
                    try {
                        await this.speech.stopRecording(effect.sessionId);
                    } catch (error) {
                        this.speechFailed(effect.sessionId, error, "RECORDING_STOP_FAILED");
                        break;
                    }
                    this.apply({ type: "RECORDING_STOPPED", sessionId: effect.sessionId });
                    break;
                }
                case "CANCEL_RECORDING": {
                    try {
                        await this.speech.cancelRecording(effect.sessionId);
                    } catch (error) {
                        this.logger.warn("cancel failed", {
                            sessionId: effect.sessionId,
                            detail: describeError(error),
                        });
                    }
                    break;
                }
                case "INSERT_TEXT":
                    await this.copyTranscriptToClipboard(effect.sessionId, effect.text);
                    break;
                default:
                    assertNever(effect);
            }
        }
    }

    private speechFailed(
        sessionId: string,
        error: unknown,
        fallbackCode: DictationErrorCode,
    ): void {
        const dictationError =
            error instanceof DictationError
                ? error
                : new DictationError(fallbackCode, describeError(error), { cause: error });
        this.apply({ type: "SPEECH_FAILED", sessionId, error: dictationError });
    }

    private async copyTranscriptToClipboard(sessionId: string, text: string): Promise<void> {
        const session = extractSession(this.state);
        if (session === null || session.sessionId !== sessionId) {
            return;
        }
        let failure: DictationError | null = null;
        try {
            await this.clipboard.writeText(text);
        } catch (error) {
            failure =
                error instanceof DictationError
                    ? error
                    : new DictationError("CLIPBOARD_WRITE_FAILED", describeError(error), {
                          cause: error,
                      });
        }
        if (failure === null) {
            this.apply({ type: "INSERTION_SUCCEEDED", sessionId });
        } else {
            this.logger.error("clipboard write failed", {
                sessionId,
                code: failure.code,
            });
            this.apply({ type: "INSERTION_FAILED", sessionId, error: failure });
        }
    }

    private buildRuntimeCapabilities(speech: SpeechCapabilities): RuntimeCapabilities {
        return {
            speechRuntimeAvailable: speech.speechRuntimeAvailable,
            microphoneAvailable: speech.microphoneAvailable,
            cpuAvailable: speech.cpuAvailable,
            vulkanAvailable: speech.vulkanAvailable,
            modelInstalled: speech.modelInstalled,
        };
    }

    private applyStartupOutcome(event: Parameters<typeof transition>[1]): void {
        if (this.startupExpired) {
            this.logger.warn("late startup resolution ignored after watchdog expiry");
            return;
        }
        this.apply(event);
    }

    private clearStartupWatchdog(): void {
        if (this.startupWatchdog !== null) {
            this.startupTimer.cancel(this.startupWatchdog);
            this.startupWatchdog = null;
        }
    }
}

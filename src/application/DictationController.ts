/**
 * DictationController — the application orchestrator.
 *
 * Responsibilities: owns the current application state (exposed as a
 * `StateStore` for `useSyncExternalStore`), creates sessions, serializes
 * microphone actions through an async operation mutex, dispatches
 * state-machine effects, rejects stale backend results by session id, and
 * verifies the keyboard context before insertion.
 *
 * MUST NOT: know DOM selectors, Steam internals, spawn processes, know file
 * paths, or call Decky directly — it only sees the ports.
 *
 * Public API beyond the basic press flow, each required by a product mandate
 * that has no other entry point:
 * - `requestCancel()` — cancellation is first-class and must be available
 *   during recording/transcription flows.
 * - `dismissError()` — recoverable errors return to ready after the user
 *   acknowledged them (the machine's ERROR_DISMISSED edge).
 * - `getLastSuppressedTranscript()` — a suppressed transcript is retained so
 *   the plugin panel can offer manual copy.
 */

import type { RuntimeCapabilities } from "../domain/Capability";
import { directInsertAvailable } from "../domain/Capability";
import { DictationError } from "../domain/DictationError";
import type { DictationErrorCode } from "../domain/DictationError";
import type { KeyboardContext } from "../domain/DictationSession";
import type { DictationState } from "../domain/DictationState";
import { extractSession } from "../domain/DictationState";
import { err } from "../domain/Result";
import type { Disposable } from "../shared/Disposable";
import { Logger, nullSink } from "../shared/Logger";
import { Mutex } from "../shared/Mutex";
import { assertNever } from "../shared/assertNever";
import { transition } from "./DictationStateMachine";
import type { DictationEffect, TransitionResult } from "./DictationStateMachine";
import type { BulkInsertResult, BulkTextInserter } from "./ports/BulkTextInserter";
import type { ClockPort } from "./ports/ClockPort";
import type { IdGeneratorPort } from "./ports/IdGeneratorPort";
import type { KeyboardHostPort } from "./ports/KeyboardHostPort";
import type { PluginSettings, SettingsPort } from "./ports/SettingsPort";
import type {
    SpeechCapabilities,
    SpeechEvent,
    SpeechPort,
    SpeechRuntimeStatus,
    TranscriptReadyPayload,
} from "./ports/SpeechPort";

/** Minimal external store consumable through `useSyncExternalStore`. */
export interface StateStore<T> {
    getSnapshot(): T;

    subscribe(listener: () => void): () => void;
}

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

/** Handle shape of the platform timer scheduler (the boot watchdog's seam). */
export type TimeoutHandle = ReturnType<typeof setTimeout>;

/**
 * Boot watchdog budget: no startup wait is unbounded. When the loader's
 * plugin registration is torn, every backend callable hangs and the card
 * would sit in `booting` forever with a dead button (deck 2026-09-18).
 * Generous enough
 * for a real cold start (settings load, hook install, backend init); tests
 * inject manual scheduling and never wait.
 */
export const STARTUP_WATCHDOG_MS = 10_000;

/**
 * Scheduling seam for the boot watchdog, made injectable so tests fire
 * expiry deterministically (no real-time sleeps). The default schedules on
 * the platform event loop.
 */
export interface StartupTimerSeam {
    readonly timeoutMs: number;
    schedule(handler: () => void, timeoutMs: number): TimeoutHandle;
    cancel(handle: TimeoutHandle): void;
}

export const defaultStartupTimer: StartupTimerSeam = {
    timeoutMs: STARTUP_WATCHDOG_MS,
    schedule: (handler, timeoutMs) => setTimeout(handler, timeoutMs),
    cancel: (handle) => clearTimeout(handle),
};

export class DictationController implements Disposable, StateStore<DictationState> {
    private readonly mutex = new Mutex();
    private readonly listeners = new Set<() => void>();

    private state: DictationState = { kind: "booting" };
    private speechEvents: Disposable | null = null;
    private keyboardEvents: Disposable | null = null;
    private startupWatchdog: TimeoutHandle | null = null;
    private startupExpired = false;
    private suppressedTranscript: string | null = null;
    private started = false;
    private disposed = false;

    constructor(
        private readonly speech: SpeechPort,
        private readonly keyboard: KeyboardHostPort,
        private readonly inserter: BulkTextInserter,
        private readonly settings: SettingsPort,
        private readonly clock: ClockPort,
        private readonly ids: IdGeneratorPort,
        // No-op by default: application code stays silent unless composition
        // wires a real sink. Not an infrastructure dependency.
        private readonly logger: Logger = new Logger("dictation.session", nullSink),
        // Boot watchdog scheduling; injectable for deterministic tests.
        private readonly startupTimer: StartupTimerSeam = defaultStartupTimer,
    ) {}

    // ── StateStore ──

    getSnapshot(): DictationState {
        return this.state;
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /**
     * Transcript retained after keyboard-context suppression so the plugin
     * panel can offer
     * manual copy; never logged, never inserted.
     */
    getLastSuppressedTranscript(): string | null {
        return this.suppressedTranscript;
    }

    // ── Lifecycle ──

    async start(): Promise<void> {
        if (this.started || this.disposed) {
            return;
        }
        this.started = true;

        // The whole startup sequence is bounded. When the loader's
        // plugin registration is torn, every callable below hangs and the card
        // would sit in `booting` forever with a dead button (deck 2026-09-18);
        // expiry reports the existing SPEECH_RUNTIME_UNAVAILABLE path instead.
        this.startupExpired = false;
        this.startupWatchdog = this.startupTimer.schedule(() => {
            this.startupWatchdog = null;
            this.startupExpired = true;
            this.logger.error("startup watchdog expired; reporting runtime unavailable");
            this.apply({ type: "STARTUP_FAILED", reason: "SPEECH_RUNTIME_UNAVAILABLE" });
        }, this.startupTimer.timeoutMs);

        try {
            this.speechEvents = this.speech.subscribe((event) => this.onSpeechEvent(event));
            this.keyboardEvents = this.keyboard.subscribe((event) => {
                if (event.type === "keyboard-opened") {
                    this.handleKeyboardOpened(event.context);
                } else {
                    void this.handleKeyboardClosed(event.contextId);
                }
            });

            // Startup order: load settings → install keyboard hook →
            // initialize speech runtime (backend init incl. model). The hook
            // install MUST NOT wait for model loading, so the keyboard host
            // starts first.
            //
            // On-device regression fix: a failed hook does NOT abort startup.
            // The QAM panel flow needs no keyboard injection; a broken hook
            // only leaves the in-keyboard button dormant and degrades through
            // the diagnostics consumed by the capability report.
            // The load itself stays load-bearing: a failure must fail startup
            // with SETTINGS_LOAD_FAILED, and the loaded `enabled` flag
            // drives the startup outcome.
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

            try {
                await this.keyboard.start();
            } catch (error) {
                this.logger.warn("keyboard hook start failed; continuing without it", {
                    detail: describeError(error),
                });
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

            const report = await this.buildRuntimeCapabilities(capabilities);
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
        this.disposed = true; // new microphone presses are rejected from here on

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
        this.keyboardEvents?.dispose();
        this.speechEvents = null;
        this.keyboardEvents = null;
        this.listeners.clear();
    }

    // ── Microphone and keyboard interaction ──

    async handleMicrophonePressed(): Promise<void> {
        if (this.disposed) {
            return;
        }
        const kind = this.state.kind;
        if (kind !== "ready" && kind !== "recording") {
            // Transient/terminal states ignore presses without queueing.
            return;
        }
        await this.mutex.runExclusive(async () => {
            const current = this.state;
            if (current.kind === "ready") {
                const context = this.keyboard.currentContext();
                if (context === null) {
                    this.logger.warn("press ignored: no keyboard context");
                    return;
                }
                this.apply({
                    type: "MICROPHONE_PRESSED",
                    session: {
                        sessionId: this.ids.nextId(),
                        keyboardContextId: context.id,
                        startedAtMonotonicMs: this.clock.nowMonotonicMs(),
                    },
                });
                return;
            }
            if (current.kind === "recording") {
                this.apply({ type: "MICROPHONE_PRESSED" });
            }
            // Any state re-checked under the lock stays ignored.
        });
    }

    /**
     * Panel press: the QAM dictation card's big button. Same serialized
     * press path — the operation mutex, the state machine, and stale-result
     * protection are all identical — but a press with NO keyboard context
     * starts a clipboard-flow session (`keyboardContextId: null`): its
     * transcript is never inserted, suppression retains it for the panel,
     * and the system-clipboard leg carries it to the Steam keyboard's Paste
     * key. The keyboard-mount press semantics above are unchanged.
     */
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
                const context = this.keyboard.currentContext();
                this.apply({
                    type: "MICROPHONE_PRESSED",
                    session: {
                        sessionId: this.ids.nextId(),
                        keyboardContextId: context === null ? null : context.id,
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

    handleKeyboardOpened(context: KeyboardContext): void {
        this.logger.info("keyboard opened", { contextId: context.id });
    }

    async handleKeyboardClosed(contextId: string): Promise<void> {
        await this.mutex.runExclusive(async () => {
            this.apply({ type: "KEYBOARD_CLOSED", contextId });
        });
    }

    /** First-class cancellation. Safe in every state. */
    async requestCancel(): Promise<void> {
        if (this.disposed) {
            return;
        }
        await this.mutex.runExclusive(async () => {
            this.apply({ type: "CANCEL_REQUESTED" });
        });
    }

    /** Acknowledge a recoverable error and return to ready. */
    dismissError(): void {
        this.apply({ type: "ERROR_DISMISSED" });
    }

    // ── Speech port events (stale-result and suppression handling) ──

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
            // Stale result: never injected.
            this.logger.info("stale transcript discarded", { sessionId: payload.sessionId });
            return;
        }
        const context = this.keyboard.currentContext();
        if (context === null || context.id !== session.keyboardContextId) {
            // Keyboard closed/gone while transcribing: suppress insertion and
            // retain the transcript for manual copy.
            this.suppressedTranscript = payload.text;
            this.logger.info("transcript suppressed: keyboard context changed", {
                sessionId: session.sessionId,
            });
            this.apply({ type: "TRANSCRIPT_SUPPRESSED", sessionId: session.sessionId });
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

    /**
     * On-device 2026-09-19: a press during a daemon restart window (settings
     * changes restart the daemon, ~4 s unavailability) left a standing
     * recoverable error on the card even after the runtime reported ready
     * again. A `runtime_status` ready report clears that staleness through
     * the machine's ERROR_DISMISSED edge: fatal errors stay (the machine
     * rejects that edge for them) and a NEW failing press still produces
     * its own error state — only staleness clears, never honesty.
     */
    private clearStaleErrorOnRuntimeReady(): void {
        this.logger.info("runtime status", { status: "ready" });
        if (this.state.kind === "error") {
            this.apply({ type: "ERROR_DISMISSED" });
        }
    }

    // ── State adoption and effect dispatch ──

    private apply(event: Parameters<typeof transition>[1]): void {
        this.adopt(transition(this.state, event));
    }

    private adopt(next: TransitionResult): void {
        if (next.state === this.state) {
            return; // rejected by the machine; nothing to notify or execute
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
                    // Promise resolution is the start acknowledgement.
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
                    // Best-effort; cancellation discards the result and emits no
                    // transcript. A late result is stale.
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
                    await this.insertTranscript(effect.sessionId, effect.text);
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

    private async insertTranscript(sessionId: string, text: string): Promise<void> {
        const session = extractSession(this.state);
        if (session === null || session.sessionId !== sessionId) {
            return;
        }
        // Context is verified again immediately before insertion.
        const context = this.keyboard.currentContext();
        if (context === null || context.id !== session.keyboardContextId) {
            this.suppressedTranscript = text;
            this.logger.info("insertion suppressed: keyboard context changed", { sessionId });
            this.apply({ type: "TRANSCRIPT_SUPPRESSED", sessionId });
            return;
        }
        let outcome: BulkInsertResult;
        try {
            outcome = await this.inserter.insert(context, text);
        } catch (error) {
            // The inserter contract reports failures as Result values;
            // an escaping exception is mapped to the closest stable code.
            outcome = err(
                new DictationError("CLIPBOARD_WRITE_FAILED", describeError(error), {
                    cause: error,
                }),
            );
        }
        if (outcome.ok) {
            this.apply({ type: "INSERTION_SUCCEEDED", sessionId });
        } else {
            this.logger.error("bulk insertion failed", {
                sessionId,
                code: outcome.error.code,
            });
            this.apply({ type: "INSERTION_FAILED", sessionId, error: outcome.error });
        }
    }

    // ── Capability report ──

    private async buildRuntimeCapabilities(
        speech: SpeechCapabilities,
    ): Promise<RuntimeCapabilities> {
        // Derive keyboardHookAvailable from the host's keyboard-hook
        // diagnostics when the implementation reports them — a registry or
        // signature miss degrades the capability honestly (no optimistic
        // assumption). Hosts without the optional surface (older or
        // simpler doubles) keep the previous behavior: start() resolved, so
        // the hook is installed.
        const diagnostics =
            typeof this.keyboard.getDiagnostics === "function"
                ? this.keyboard.getDiagnostics()
                : null;
        const keyboardHookAvailable = diagnostics === null ? true : diagnostics.reason === null;
        let clipboardAvailable = false;
        let nativePasteAvailable = false;
        const context = this.keyboard.currentContext();
        if (context !== null) {
            try {
                const insertion = await this.inserter.probe(context);
                clipboardAvailable = insertion.directInsert || insertion.clipboardOnly;
                nativePasteAvailable = insertion.directInsert;
            } catch (error) {
                // No optimistic assumption: a failed probe reports false.
                this.logger.warn("insertion probe failed", { detail: describeError(error) });
            }
        }
        return {
            speechRuntimeAvailable: speech.speechRuntimeAvailable,
            microphoneAvailable: speech.microphoneAvailable,
            cpuAvailable: speech.cpuAvailable,
            vulkanAvailable: speech.vulkanAvailable,
            modelInstalled: speech.modelInstalled,
            keyboardHookAvailable,
            clipboardAvailable,
            nativePasteAvailable,
            directInsertAvailable: directInsertAvailable({
                clipboardAvailable,
                nativePasteAvailable,
                keyboardHookAvailable,
            }),
        };
    }

    /**
     * Applies a startup outcome unless the boot watchdog already expired: a
     * late resolution (or late failure) after expiry must never flip the
     * reported state back — the machine may legally take STARTUP_COMPLETED
     * from `unavailable`, so the guard lives here, not in the machine.
     */
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

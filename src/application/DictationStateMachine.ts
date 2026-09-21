import type { RuntimeCapabilities } from "../domain/Capability";
import type { DictationErrorCode } from "../domain/DictationError";
import { DictationError, EmptyTranscriptError, validateTranscript } from "../domain/DictationError";
import type { DictationSession } from "../domain/DictationSession";
import type { DictationState, UnavailableReason } from "../domain/DictationState";
import { assertNever } from "../shared/assertNever";

export type DictationEvent =
    | {
          readonly type: "STARTUP_COMPLETED";
          readonly capabilities: RuntimeCapabilities;
          readonly enabled: boolean;
      }
    | { readonly type: "STARTUP_FAILED"; readonly reason: UnavailableReason }
    | { readonly type: "MICROPHONE_PRESSED"; readonly session?: DictationSession }
    | { readonly type: "RECORDING_STARTED"; readonly sessionId: string }
    | { readonly type: "RECORDING_STOPPED"; readonly sessionId: string }
    | { readonly type: "TRANSCRIPT_READY"; readonly sessionId: string; readonly transcript: string }
    | { readonly type: "INSERTION_SUCCEEDED"; readonly sessionId: string }
    | {
          readonly type: "INSERTION_FAILED";
          readonly sessionId: string;
          readonly error: DictationError;
      }
    | { readonly type: "CANCEL_REQUESTED" }
    | {
          readonly type: "SPEECH_FAILED";
          readonly sessionId: string | null;
          readonly error: DictationError;
      }
    | { readonly type: "ERROR_DISMISSED" };

export type DictationEffect =
    | { readonly type: "START_RECORDING"; readonly sessionId: string }
    | { readonly type: "STOP_RECORDING"; readonly sessionId: string }
    | { readonly type: "CANCEL_RECORDING"; readonly sessionId: string }
    | { readonly type: "INSERT_TEXT"; readonly sessionId: string; readonly text: string };

export interface TransitionResult {
    readonly state: DictationState;
    readonly effects: readonly DictationEffect[];
}

const FATAL_ERROR_CODES: ReadonlySet<DictationErrorCode> = new Set([
    "RUNTIME_CRASHED",
    "RUNTIME_START_FAILED",
    "STEAM_PROFILE_UNSUPPORTED",
    "MODEL_NOT_INSTALLED",
    "MODEL_DOWNLOAD_FAILED",
    "MODEL_CHECKSUM_FAILED",
]);

export function isFatalDictationError(error: DictationError): boolean {
    return FATAL_ERROR_CODES.has(error.code);
}

const NO_EFFECTS: readonly DictationEffect[] = [];

function unchanged(state: DictationState): TransitionResult {
    return { state, effects: NO_EFFECTS };
}

function result(state: DictationState, ...effects: readonly DictationEffect[]): TransitionResult {
    return { state, effects };
}

function sameSession(state: { readonly session: DictationSession }, sessionId: string): boolean {
    return state.session.sessionId === sessionId;
}

function unavailableReasonFor(
    capabilities: RuntimeCapabilities,
    enabled: boolean,
): UnavailableReason | null {
    if (!enabled) {
        return "PLUGIN_DISABLED";
    }
    if (!capabilities.speechRuntimeAvailable) {
        return "SPEECH_RUNTIME_UNAVAILABLE";
    }
    if (!capabilities.microphoneAvailable) {
        return "MICROPHONE_UNAVAILABLE";
    }
    if (!capabilities.modelInstalled) {
        return "MODEL_NOT_INSTALLED";
    }
    return null;
}

export function transition(current: DictationState, event: DictationEvent): TransitionResult {
    switch (event.type) {
        case "STARTUP_COMPLETED": {
            switch (current.kind) {
                case "booting":
                case "unavailable":
                case "error": {
                    const reason = unavailableReasonFor(event.capabilities, event.enabled);
                    return reason === null
                        ? result({ kind: "ready" })
                        : result({ kind: "unavailable", reason });
                }
                case "ready":
                case "starting":
                case "recording":
                case "stopping":
                case "transcribing":
                case "inserting":
                    return unchanged(current);
            }
            break;
        }

        case "STARTUP_FAILED": {
            switch (current.kind) {
                case "booting":
                case "unavailable":
                case "error":
                    return result({ kind: "unavailable", reason: event.reason });
                case "ready":
                case "starting":
                case "recording":
                case "stopping":
                case "transcribing":
                case "inserting":
                    return unchanged(current);
            }
            break;
        }

        case "MICROPHONE_PRESSED": {
            switch (current.kind) {
                case "ready":
                    if (event.session === undefined) {
                        return unchanged(current);
                    }
                    return result(
                        { kind: "starting", session: event.session },
                        { type: "START_RECORDING", sessionId: event.session.sessionId },
                    );
                case "recording":
                    return result(
                        { kind: "stopping", session: current.session },
                        { type: "STOP_RECORDING", sessionId: current.session.sessionId },
                    );
                case "starting":
                case "stopping":
                case "transcribing":
                case "inserting":
                    return unchanged(current);
                case "booting":
                case "unavailable":
                case "error":
                    return unchanged(current);
            }
            break;
        }

        case "RECORDING_STARTED": {
            switch (current.kind) {
                case "starting":
                    if (!sameSession(current, event.sessionId)) {
                        return unchanged(current);
                    }
                    return result({ kind: "recording", session: current.session });
                case "booting":
                case "unavailable":
                case "ready":
                case "recording":
                case "stopping":
                case "transcribing":
                case "inserting":
                case "error":
                    return unchanged(current);
            }
            break;
        }

        case "RECORDING_STOPPED": {
            switch (current.kind) {
                case "stopping":
                    if (!sameSession(current, event.sessionId)) {
                        return unchanged(current);
                    }
                    return result({ kind: "transcribing", session: current.session });
                case "booting":
                case "unavailable":
                case "ready":
                case "starting":
                case "recording":
                case "transcribing":
                case "inserting":
                case "error":
                    return unchanged(current);
            }
            break;
        }

        case "TRANSCRIPT_READY": {
            switch (current.kind) {
                case "transcribing":
                case "stopping": {
                    if (!sameSession(current, event.sessionId)) {
                        return unchanged(current);
                    }
                    let normalized: string;
                    try {
                        normalized = validateTranscript(event.transcript);
                    } catch (error) {
                        if (error instanceof EmptyTranscriptError) {
                            return result({ kind: "ready" });
                        }
                        if (error instanceof DictationError) {
                            return result({ kind: "error", error, recoverable: true });
                        }
                        throw error;
                    }
                    return result(
                        {
                            kind: "inserting",
                            session: current.session,
                            transcript: normalized,
                        },
                        {
                            type: "INSERT_TEXT",
                            sessionId: current.session.sessionId,
                            text: normalized,
                        },
                    );
                }
                case "booting":
                case "unavailable":
                case "ready":
                case "starting":
                case "recording":
                case "stopping":
                case "inserting":
                case "error":
                    return unchanged(current);
            }
            break;
        }

        case "INSERTION_SUCCEEDED": {
            switch (current.kind) {
                case "inserting":
                    if (!sameSession(current, event.sessionId)) {
                        return unchanged(current);
                    }
                    return result({ kind: "ready" });
                case "booting":
                case "unavailable":
                case "ready":
                case "starting":
                case "recording":
                case "stopping":
                case "transcribing":
                case "error":
                    return unchanged(current);
            }
            break;
        }

        case "INSERTION_FAILED": {
            switch (current.kind) {
                case "inserting":
                    if (!sameSession(current, event.sessionId)) {
                        return unchanged(current);
                    }
                    return result({ kind: "error", error: event.error, recoverable: true });
                case "booting":
                case "unavailable":
                case "ready":
                case "starting":
                case "recording":
                case "stopping":
                case "transcribing":
                case "error":
                    return unchanged(current);
            }
            break;
        }

        case "CANCEL_REQUESTED": {
            switch (current.kind) {
                case "starting":
                case "recording":
                case "stopping":
                case "transcribing":
                    return result(
                        { kind: "ready" },
                        { type: "CANCEL_RECORDING", sessionId: current.session.sessionId },
                    );
                case "booting":
                case "unavailable":
                case "ready":
                case "inserting":
                case "error":
                    return unchanged(current);
            }
            break;
        }

        case "SPEECH_FAILED": {
            switch (current.kind) {
                case "starting":
                case "recording":
                case "stopping":
                case "transcribing": {
                    if (event.sessionId !== null && event.sessionId !== current.session.sessionId) {
                        return unchanged(current);
                    }
                    return result(
                        {
                            kind: "error",
                            error: event.error,
                            recoverable: !isFatalDictationError(event.error),
                        },
                        { type: "CANCEL_RECORDING", sessionId: current.session.sessionId },
                    );
                }
                case "booting":
                case "unavailable":
                case "ready":
                case "inserting":
                case "error":
                    return unchanged(current);
            }
            break;
        }

        case "ERROR_DISMISSED": {
            switch (current.kind) {
                case "error":
                    if (!current.recoverable) {
                        return unchanged(current);
                    }
                    return result({ kind: "ready" });
                case "booting":
                case "unavailable":
                case "ready":
                case "starting":
                case "recording":
                case "stopping":
                case "transcribing":
                case "inserting":
                    return unchanged(current);
            }
            break;
        }

        default:
            return assertNever(event);
    }
}

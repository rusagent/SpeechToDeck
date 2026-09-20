/**
 * Pure dictation state machine.
 *
 * `transition` performs no I/O, accesses no global state, contains no Decky
 * and no DOM calls, and is fully unit-testable. The controller dispatches the
 * returned effects through the ports; the machine itself never touches them.
 *
 * Event alphabet (the dictation flow: press, acknowledgement, transcript,
 * inserted; the mic control press is named MICROPHONE_PRESSED):
 *
 * - STARTUP_COMPLETED / STARTUP_FAILED — boot or restart outcome.
 * - MICROPHONE_PRESSED — the mic control was pressed. Carries a fresh
 *   session only for the ready→starting edge, where the machine could not
 *   otherwise learn the controller-generated session; on all other edges the
 *   payload is ignored.
 * - RECORDING_STARTED / RECORDING_STOPPED — acknowledgements: the active
 *   indicator appears only after the start acknowledgement and ends only
 *   after the stop acknowledgement. Carry the sessionId for stale-result
 *   protection.
 * - TRANSCRIPT_READY / TRANSCRIPT_SUPPRESSED — transcription outcome; the
 *   suppressed variant is dispatched by the controller when the result is
 *   stale or the keyboard context changed, so insertion is never even
 *   attempted.
 * - INSERTION_SUCCEEDED / INSERTION_FAILED — insertion outcome (Result).
 * - CANCEL_REQUESTED — first-class cancellation.
 * - KEYBOARD_CLOSED — keyboard context disappeared.
 * - SPEECH_FAILED — an error event from the speech port (stable error codes).
 * - ERROR_DISMISSED — user acknowledged a recoverable error.
 *
 * Rejection semantics: an event that is not applicable in the current state —
 * including every forbidden transition and every stale result — is rejected
 * by returning the current state unchanged with no effects. The machine never
 * throws on stale or duplicate input.
 */

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
    | { readonly type: "TRANSCRIPT_SUPPRESSED"; readonly sessionId: string }
    | { readonly type: "INSERTION_SUCCEEDED"; readonly sessionId: string }
    | {
          readonly type: "INSERTION_FAILED";
          readonly sessionId: string;
          readonly error: DictationError;
      }
    | { readonly type: "CANCEL_REQUESTED" }
    | { readonly type: "KEYBOARD_CLOSED"; readonly contextId: string }
    | {
          readonly type: "SPEECH_FAILED";
          readonly sessionId: string | null;
          readonly error: DictationError;
      }
    | { readonly type: "ERROR_DISMISSED" };

/**
 * Commands the machine hands to the controller. The controller executes them
 * through the ports; effects carry every argument the port call needs.
 */
export type DictationEffect =
    | { readonly type: "START_RECORDING"; readonly sessionId: string }
    | { readonly type: "STOP_RECORDING"; readonly sessionId: string }
    | { readonly type: "CANCEL_RECORDING"; readonly sessionId: string }
    | { readonly type: "INSERT_TEXT"; readonly sessionId: string; readonly text: string };

export interface TransitionResult {
    readonly state: DictationState;
    readonly effects: readonly DictationEffect[];
}

/**
 * Error codes that leave the plugin unable to continue without an explicit
 * restart-style action (fatal runtime errors); every other code is a
 * recoverable error that returns the plugin to ready after cleanup.
 */
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

/**
 * Deterministic unavailable-reason derivation from the capability report,
 * checked in a fixed order. Returns `null` when the plugin is ready to
 * dictate.
 *
 * On-device regression fix: readiness is the QAM flow's own requirement —
 * runtime available, model installed, plugin enabled. The keyboard facets
 * (keyboardHookAvailable, clipboard/nativePaste, directInsert) do NOT gate
 * the flow: the panel flow records and carries the transcript to the
 * clipboard with no keyboard injection, and a degraded keyboard only leaves
 * the in-keyboard button dormant while the facets stay honestly reported.
 */
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

/**
 * Applies `event` to `current` and returns the next state plus the effects to
 * dispatch. Both axes are exhaustively switched so the compiler rejects a new
 * state kind or event type without an explicit decision.
 */
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
                        // The controller always supplies a session for a ready press.
                        return unchanged(current);
                    }
                    return result(
                        { kind: "starting", session: event.session },
                        { type: "START_RECORDING", sessionId: event.session.sessionId },
                    );
                case "recording":
                    // Press while recording stops the recording.
                    return result(
                        { kind: "stopping", session: current.session },
                        { type: "STOP_RECORDING", sessionId: current.session.sessionId },
                    );
                case "starting":
                case "stopping":
                case "transcribing":
                case "inserting":
                    // Duplicate presses while an operation is pending are ignored.
                    return unchanged(current);
                case "booting":
                case "unavailable":
                case "error":
                    // e.g. error → recording is forbidden.
                    return unchanged(current);
            }
            break;
        }

        case "RECORDING_STARTED": {
            switch (current.kind) {
                case "starting":
                    if (!sameSession(current, event.sessionId)) {
                        return unchanged(current); // stale acknowledgement
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
                        return unchanged(current); // stale acknowledgement
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
                // `stopping` included: the real backend emits transcript_ready
                // INSIDE the stop_recording callable window, so over the FIFO
                // decky socket the outcome event always precedes the callable
                // resolution — the machine is still in `stopping` when it
                // arrives (on-device deck 2026-09-18: rejecting it there lost
                // the transcript forever and wedged the card in transcribing).
                case "transcribing":
                case "stopping": {
                    if (!sameSession(current, event.sessionId)) {
                        return unchanged(current); // stale result
                    }
                    let normalized: string;
                    try {
                        normalized = validateTranscript(event.transcript);
                    } catch (error) {
                        if (error instanceof EmptyTranscriptError) {
                            // Empty speech: silently back to ready, no insert.
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
                    // e.g. ready → transcribing and recording → inserting are forbidden.
                    return unchanged(current);
            }
            break;
        }

        case "TRANSCRIPT_SUPPRESSED": {
            switch (current.kind) {
                // Same FIFO ordering as TRANSCRIPT_READY above: the panel
                // suppression lands while the machine is still in `stopping`.
                case "transcribing":
                case "stopping":
                    if (!sameSession(current, event.sessionId)) {
                        return unchanged(current);
                    }
                    // Keyboard context changed while transcribing: no insertion.
                    return result({ kind: "ready" });
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
                    // Insertion failure is a recoverable error; no retry happens
                    // automatically — the user presses again (auto-recovery into a
                    // session state is forbidden).
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
                    // Cancellation stops capture, discards any result and emits no
                    // transcript; a late backend result is stale.
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

        case "KEYBOARD_CLOSED": {
            switch (current.kind) {
                case "starting":
                case "recording":
                case "stopping":
                    if (current.session.keyboardContextId !== event.contextId) {
                        return unchanged(current); // a different keyboard context
                    }
                    // Keyboard disappeared: cancel, discard, be ready when the next
                    // keyboard appears.
                    return result(
                        { kind: "ready" },
                        { type: "CANCEL_RECORDING", sessionId: current.session.sessionId },
                    );
                case "transcribing":
                    // Transcription may finish; insertion is suppressed at the
                    // transcript event.
                    return unchanged(current);
                case "inserting":
                    // The inserter revalidates the context inside its transaction.
                    return unchanged(current);
                case "booting":
                case "unavailable":
                case "ready":
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
                        return unchanged(current); // stale error
                    }
                    return result(
                        {
                            kind: "error",
                            error: event.error,
                            recoverable: !isFatalDictationError(event.error),
                        },
                        // Recoverable path cleanup: cancel whatever is still in flight.
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
                        // Fatal errors need an explicit restart-style action.
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

/**
 * Application state as a discriminated union — exactly spec §8/§3.4.
 *
 * Boolean flags such as `isRecording`/`hasError` are forbidden; every state is
 * one member of this union, so invalid combinations cannot be expressed.
 */

import type { DictationError } from "./DictationError";
import type { DictationSession } from "./DictationSession";

/**
 * Why dictation is unavailable. Derived deterministically from the startup
 * capability report (spec §57) and the enabled setting, checked in a fixed
 * order by the state machine.
 */
export type UnavailableReason =
    | "PLUGIN_DISABLED"
    | "KEYBOARD_HOOK_UNAVAILABLE"
    | "SPEECH_RUNTIME_UNAVAILABLE"
    | "MICROPHONE_UNAVAILABLE"
    | "MODEL_NOT_INSTALLED"
    | "SETTINGS_LOAD_FAILED";

export type DictationState =
    | { readonly kind: "booting" }
    | { readonly kind: "unavailable"; readonly reason: UnavailableReason }
    | { readonly kind: "ready" }
    | { readonly kind: "starting"; readonly session: DictationSession }
    | { readonly kind: "recording"; readonly session: DictationSession }
    | { readonly kind: "stopping"; readonly session: DictationSession }
    | { readonly kind: "transcribing"; readonly session: DictationSession }
    | {
          readonly kind: "inserting";
          readonly session: DictationSession;
          readonly transcript: string;
      }
    | {
          readonly kind: "error";
          readonly error: DictationError;
          readonly recoverable: boolean;
      };

/** The session carried by a sessionful state, or `null`. */
export function extractSession(state: DictationState): DictationSession | null {
    switch (state.kind) {
        case "starting":
        case "recording":
        case "stopping":
        case "transcribing":
        case "inserting":
            return state.session;
        case "booting":
        case "unavailable":
        case "ready":
        case "error":
            return null;
    }
}

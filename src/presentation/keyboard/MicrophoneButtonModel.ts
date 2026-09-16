/**
 * MicrophoneButtonModel (spec §19/§20/§75) — pure mapping from the
 * application state union to the visual state and enabled flag of the
 * microphone button.
 *
 * Indicator integrity (§75): `recording` is shown only after recording start
 * has been acknowledged (`starting` stays processing/disabled), and the
 * recording state ends as soon as stop is requested. Boolean flags such as
 * `isRecording` never leak into the presentation; the state union is the
 * single source (§3.4).
 */

import type { DictationState } from "../../domain/DictationState";

/** Visual states (spec §19). */
export type MicrophoneVisualState = "ready" | "recording" | "processing" | "error";

export interface MicrophoneButtonModel {
    readonly visualState: MicrophoneVisualState;
    readonly disabled: boolean;
}

export function microphoneButtonModel(state: DictationState): MicrophoneButtonModel {
    switch (state.kind) {
        case "booting":
            // Startup is transient; the control is visible but not yet
            // usable, and never shows an active indicator (§75).
            return { visualState: "ready", disabled: true };
        case "unavailable":
        case "error":
            return { visualState: "error", disabled: true };
        case "ready":
            return { visualState: "ready", disabled: false };
        case "starting":
            // Recording start not acknowledged yet — must not show active (§75).
            return { visualState: "processing", disabled: true };
        case "recording":
            return { visualState: "recording", disabled: false };
        case "stopping":
        case "transcribing":
        case "inserting":
            return { visualState: "processing", disabled: true };
    }
}

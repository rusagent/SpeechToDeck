import type { DictationState } from "../../domain/DictationState";

export type MicrophoneVisualState = "ready" | "recording" | "processing" | "error";

export interface MicrophoneButtonModel {
    readonly visualState: MicrophoneVisualState;
    readonly disabled: boolean;
}

export function microphoneButtonModel(state: DictationState): MicrophoneButtonModel {
    switch (state.kind) {
        case "booting":
            return { visualState: "ready", disabled: true };
        case "unavailable":
        case "error":
            return { visualState: "error", disabled: true };
        case "ready":
            return { visualState: "ready", disabled: false };
        case "starting":
            return { visualState: "processing", disabled: true };
        case "recording":
            return { visualState: "recording", disabled: false };
        case "stopping":
        case "transcribing":
        case "inserting":
            return { visualState: "processing", disabled: true };
    }
}

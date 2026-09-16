/**
 * MicrophoneButton (spec §19/§20/§107) — pure presentation component.
 *
 * No backend logic. Accessibility (§107): implicit button role, accessible
 * name per state, `aria-pressed` for the recording state, disabled state,
 * and a per-state glyph so the state never relies on color alone.
 */

import * as React from "react";
import { translateMicLabel } from "../i18n/messages";
import type { Locale } from "../i18n/messages";
import type { MicrophoneVisualState } from "./MicrophoneButtonModel";

export interface MicrophoneButtonProps {
    readonly state: MicrophoneVisualState;
    readonly disabled: boolean;
    readonly onPress: () => void;
    readonly locale?: Locale;
}

const BUTTON_SIZE_PX = 44;

function buttonStyle(disabled: boolean): React.CSSProperties {
    return {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: BUTTON_SIZE_PX,
        height: BUTTON_SIZE_PX,
        borderRadius: "50%",
        border: "1px solid rgba(255, 255, 255, 0.35)",
        background: "rgba(25, 28, 34, 0.85)",
        color: "#ffffff",
        cursor: disabled ? "default" : "pointer",
        padding: 0,
        position: "relative",
    };
}

const GLYPH_STYLE: React.CSSProperties = {
    position: "absolute",
    right: -2,
    bottom: -2,
    fontSize: 12,
    lineHeight: 1,
    fontWeight: 700,
    pointerEvents: "none",
};

const MIC_ICON = (
    <svg
        width="20"
        height="20"
        viewBox="0 0 24 24"
        fill="currentColor"
        aria-hidden="true"
        focusable="false"
    >
        <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3z" />
        <path d="M18 11a1 1 0 1 0-2 0 4 4 0 0 1-8 0 1 1 0 1 0-2 0 6 6 0 0 0 5 5.91V19H9a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-2v-2.09A6 6 0 0 0 18 11z" />
    </svg>
);

/** Per-state glyph so state is distinguishable without color (§107). */
function StateGlyph({ state }: { state: MicrophoneVisualState }): React.ReactElement | null {
    switch (state) {
        case "ready":
            return null;
        case "recording":
            return (
                <span aria-hidden="true" style={{ ...GLYPH_STYLE, color: "#ff5c5c" }}>
                    ●
                </span>
            );
        case "processing":
            return (
                <span aria-hidden="true" style={{ ...GLYPH_STYLE, color: "#ffd166" }}>
                    ◌
                </span>
            );
        case "error":
            return (
                <span aria-hidden="true" style={{ ...GLYPH_STYLE, color: "#ff5c5c" }}>
                    !
                </span>
            );
    }
}

export function MicrophoneButton({
    state,
    disabled,
    onPress,
    locale = "en",
}: MicrophoneButtonProps): React.ReactElement {
    const label = translateMicLabel(locale, state);
    return (
        <button
            type="button"
            className="decky-voice-keyboard-mic-button"
            data-state={state}
            aria-label={label}
            title={label}
            aria-pressed={state === "recording" ? true : undefined}
            disabled={disabled}
            onClick={onPress}
            style={buttonStyle(disabled)}
        >
            {MIC_ICON}
            <StateGlyph state={state} />
        </button>
    );
}

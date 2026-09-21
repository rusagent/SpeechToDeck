import * as React from "react";
import { translateMicLabel } from "../i18n/messages";
import type { Locale } from "../i18n/messages";
import type { MicrophoneVisualState } from "./MicrophoneButtonModel";

export interface MicrophoneButtonProps {
    readonly state: MicrophoneVisualState;
    readonly disabled: boolean;
    readonly onPress: () => void;
    readonly locale?: Locale;
    readonly elapsedLabel?: string | undefined;
    readonly errorMessage?: string | undefined;
    readonly size?: number;
}

const BUTTON_SIZE_PX = 44;
const ERROR_FLASH_MS = 4000;

const RECORDING_COLOR = "#ff5c5c";

function buttonStyle(
    state: MicrophoneVisualState,
    disabled: boolean,
    size: number,
): React.CSSProperties {
    const recording = state === "recording";
    return {
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: size,
        height: size,
        borderRadius: "50%",
        border: recording
            ? `1px solid ${RECORDING_COLOR}`
            : state === "error"
              ? "1px solid rgba(255, 92, 92, 0.75)"
              : "1px solid rgba(255, 255, 255, 0.35)",
        background: recording ? "rgba(58, 24, 26, 0.9)" : "rgba(25, 28, 34, 0.85)",
        color: "#ffffff",
        cursor: disabled ? "default" : "pointer",
        padding: 0,
        position: "relative",
        transition: "border-color 120ms ease, background-color 120ms ease",
    };
}

const BADGE_STYLE: React.CSSProperties = {
    position: "absolute",
    right: -2,
    top: -2,
    width: 12,
    height: 12,
    borderRadius: "50%",
    display: "inline-flex",
    alignItems: "center",
    justifyContent: "center",
    fontSize: 9,
    lineHeight: 1,
    fontWeight: 700,
    color: "#ffffff",
    background: RECORDING_COLOR,
    border: "1px solid rgba(0, 0, 0, 0.55)",
    pointerEvents: "none",
};

const FLASH_STYLE: React.CSSProperties = {
    position: "absolute",
    top: "100%",
    marginTop: 4,
    left: "50%",
    transform: "translateX(-50%)",
    maxWidth: 224,
    padding: "3px 9px",
    borderRadius: 9,
    fontSize: 12,
    lineHeight: 1.35,
    color: "#ffd7d7",
    background: "rgba(30, 12, 14, 0.95)",
    border: "1px solid rgba(255, 92, 92, 0.55)",
    whiteSpace: "normal",
    textAlign: "center",
    zIndex: 1,
};

function micIcon(size: number): React.ReactElement {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="currentColor"
            aria-hidden="true"
            focusable="false"
        >
            <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3z" />
            <path d="M18 11a1 1 0 1 0-2 0 4 4 0 0 1-8 0 1 1 0 1 0-2 0 6 6 0 0 0 5 5.91V19H9a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-2v-2.09A6 6 0 0 0 18 11z" />
        </svg>
    );
}

function spinnerIcon(size: number): React.ReactElement {
    return (
        <svg
            width={size}
            height={size}
            viewBox="0 0 24 24"
            fill="none"
            aria-hidden="true"
            focusable="false"
            className="speechtodeck-spinner"
        >
            <circle cx="12" cy="12" r="9" stroke="rgba(255, 255, 255, 0.18)" strokeWidth="2.5" />
            <path
                d="M21 12a9 9 0 0 0-9-9"
                stroke="rgba(255, 255, 255, 0.9)"
                strokeWidth="2.5"
                strokeLinecap="round"
            />
        </svg>
    );
}

function glyphSize(buttonSize: number): number {
    return Math.round(Math.min(40, Math.max(18, buttonSize * 0.45)));
}

const MOTION_STYLES = `
@keyframes speechtodeck-pulse {
    0% { box-shadow: 0 0 0 0 rgba(255, 92, 92, 0.55); }
    70% { box-shadow: 0 0 0 8px rgba(255, 92, 92, 0); }
    100% { box-shadow: 0 0 0 0 rgba(255, 92, 92, 0); }
}
@keyframes speechtodeck-spin {
    to { transform: rotate(360deg); }
}
.speechtodeck-rec-ring { animation: speechtodeck-pulse 1.6s ease-out infinite; }
.speechtodeck-spinner { animation: speechtodeck-spin 1.1s linear infinite; }
@media (prefers-reduced-motion: reduce) {
    .speechtodeck-rec-ring { animation: none; box-shadow: 0 0 0 3px rgba(255, 92, 92, 0.4); }
    .speechtodeck-spinner { animation: none; }
}
`;

let motionStylesInjected = false;

function injectMotionStyles(): void {
    if (motionStylesInjected || typeof document === "undefined") {
        return;
    }
    const element = document.createElement("style");
    element.textContent = MOTION_STYLES;
    document.head.append(element);
    motionStylesInjected = true;
}

function useErrorFlash(errorMessage: string | undefined): boolean {
    const [visible, setVisible] = React.useState(false);
    React.useEffect(() => {
        if (errorMessage === undefined || errorMessage.length === 0) {
            setVisible(false);
            return;
        }
        setVisible(true);
        const timer = window.setTimeout(() => setVisible(false), ERROR_FLASH_MS);
        return () => window.clearTimeout(timer);
    }, [errorMessage]);
    return visible;
}

export function MicrophoneButton({
    state,
    disabled,
    onPress,
    locale = "en",
    elapsedLabel,
    errorMessage,
    size = BUTTON_SIZE_PX,
}: MicrophoneButtonProps): React.ReactElement {
    injectMotionStyles();
    const label = translateMicLabel(locale, state);
    const flashVisible = useErrorFlash(errorMessage);
    const recording = state === "recording";
    return (
        <button
            type="button"
            className={`speechtodeck-mic-button${recording ? " speechtodeck-rec-ring" : ""}`}
            data-state={state}
            aria-label={label}
            title={label}
            aria-pressed={recording ? true : undefined}
            disabled={disabled}
            onClick={onPress}
            style={buttonStyle(state, disabled, size)}
        >
            {state === "processing" ? (
                spinnerIcon(glyphSize(size))
            ) : recording && elapsedLabel !== undefined && elapsedLabel.length > 0 ? (
                <span
                    aria-hidden="true"
                    style={{
                        fontSize: 11,
                        fontWeight: 700,
                        fontVariantNumeric: "tabular-nums",
                        letterSpacing: 0.5,
                    }}
                >
                    {elapsedLabel}
                </span>
            ) : (
                micIcon(glyphSize(size))
            )}
            {recording ? (
                <span aria-hidden="true" data-state-marker="recording" style={BADGE_STYLE} />
            ) : null}
            {state === "error" ? (
                <span aria-hidden="true" data-state-marker="error" style={BADGE_STYLE}>
                    !
                </span>
            ) : null}
            {state === "error" && flashVisible && errorMessage !== undefined ? (
                <span role="status" style={FLASH_STYLE}>
                    {errorMessage}
                </span>
            ) : null}
        </button>
    );
}

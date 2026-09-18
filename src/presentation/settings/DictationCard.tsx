/**
 * DictationCard (v0.2 owner pivot) — the QAM panel's dictation surface.
 *
 * Layout, top of the plugin panel: a BIG microphone button driven by the
 * SAME application state union and `MicrophoneButtonModel` semantics as the
 * keyboard mount (§75: the active indicator appears only after the start
 * acknowledgement and ends with the stop), presses going through the
 * controller's panel press path (§10 mutex, §8 machine, §11 stale
 * protection — all unchanged). While `recording`, a 24-bar level strip
 * renders ONLY the real received `recording_level` frames (live amplitude
 * envelope from the daemon's audio.sock — a level meter, not an FFT).
 * After a settled flow, the transcript preview plus the clipboard status
 * line and a "copy again" action: the transcript travels to the Steam
 * keyboard's Paste key (STEAM+X on-screen keyboard) via the system
 * clipboard.
 *
 * §61: the strip's height transitions run only while events arrive (bars
 * re-render on publishes, never on a timer) and are disabled under
 * `prefers-reduced-motion`. All strings via i18n (§108).
 */

import * as React from "react";
import { PanelSectionRow } from "@decky/ui";
import { MicrophoneButton } from "../keyboard/MicrophoneButton";
import { microphoneButtonModel } from "../keyboard/MicrophoneButtonModel";
import { translate, translateMicLabel } from "../i18n/messages";
import type { Locale } from "../i18n/messages";
import type { DictationState } from "../../domain/DictationState";
import { LevelMeterStore } from "../../application/ports/LevelMeterPort";
import type { PanelTranscriptSnapshot } from "../../application/ports/PanelTranscriptPort";

export interface DictationCardProps {
    /** Controller store snapshot (the §8 state union drives everything). */
    readonly state: DictationState;
    /** Level store fed by the adapter's guarded `recording_level` events;
     * concrete because the card resets the window per recording session. */
    readonly levelMeter: LevelMeterStore;
    /** Latest transcript snapshot from the adapter (null before the first). */
    readonly transcript: PanelTranscriptSnapshot | null;
    /** Panel press handler (controller.handlePanelMicrophonePressed). */
    readonly onPress: () => void;
    /** Panel clipboard copy (execCommand primary); resolves success. */
    readonly onCopy: (text: string) => Promise<boolean>;
    readonly locale?: Locale;
}

const BIG_BUTTON_SIZE = 72;
const BAR_COUNT = 24;
const PREVIEW_MAX_CHARS = 140;
/** Panel copy outcome; null before the auto-copy for the current transcript. */
const COPY_IDLE: "copied" | "failed" | "copying" | null = null;

/** Motion styles, injected once; off under `prefers-reduced-motion`. */
const CARD_MOTION_STYLES = `
.speechtodeck-level-bar { transition: height 90ms linear; }
@media (prefers-reduced-motion: reduce) {
    .speechtodeck-level-bar { transition: none; }
}
`;

let cardStylesInjected = false;

function injectCardStyles(): void {
    if (cardStylesInjected || typeof document === "undefined") {
        return;
    }
    const element = document.createElement("style");
    element.textContent = CARD_MOTION_STYLES;
    document.head.append(element);
    cardStylesInjected = true;
}

function truncatePreview(text: string): string {
    return text.length > PREVIEW_MAX_CHARS ? `${text.slice(0, PREVIEW_MAX_CHARS)}…` : text;
}

/** The transcript region is visible once the flow has settled. */
function transcriptVisible(state: DictationState): boolean {
    return (
        state.kind === "ready" ||
        state.kind === "error" ||
        state.kind === "unavailable" ||
        state.kind === "booting"
    );
}

function LevelStrip({
    bars,
    label,
}: {
    bars: readonly number[];
    label: string;
}): React.ReactElement {
    return (
        <div
            role="img"
            aria-label={label}
            data-level-strip="true"
            style={{
                display: "flex",
                alignItems: "flex-end",
                gap: 2,
                height: 44,
                padding: "3px 6px",
                borderRadius: 6,
                background: "rgba(25, 28, 34, 0.85)",
                border: "1px solid rgba(255, 255, 255, 0.25)",
                marginTop: 8,
            }}
        >
            {Array.from({ length: BAR_COUNT }, (_, index) => {
                const bar = bars[index] ?? 0;
                return (
                    <div
                        key={index}
                        aria-hidden="true"
                        className="speechtodeck-level-bar"
                        data-level-bar={index}
                        data-level-value={bar.toFixed(2)}
                        style={{
                            flex: 1,
                            minWidth: 2,
                            height: `${Math.max(4, Math.round(bar * 100))}%`,
                            background:
                                bar > 0.75 ? "rgba(255, 92, 92, 0.9)" : "rgba(255, 255, 255, 0.55)",
                            borderRadius: 2,
                        }}
                    />
                );
            })}
        </div>
    );
}

export function DictationCard({
    state,
    levelMeter,
    transcript,
    onPress,
    onCopy,
    locale = "en",
}: DictationCardProps): React.ReactElement {
    injectCardStyles();
    const button = microphoneButtonModel(state);
    const recording = state.kind === "recording";

    // Bound, render-store accessors (§102), same closure pattern as the panel.
    const subscribeLevels = React.useMemo(
        () => (onChange: () => void) => levelMeter.subscribe(onChange),
        [levelMeter],
    );
    const getLevels = React.useMemo(() => () => levelMeter.getSnapshot(), [levelMeter]);
    const levels = React.useSyncExternalStore(subscribeLevels, getLevels);

    // Fresh level window per recording session (§75: never stale bars).
    React.useEffect(() => {
        if (recording) {
            levelMeter.reset();
        }
    }, [recording, levelMeter]);

    // Panel copy state: null until the auto-copy for the current transcript
    // resolved; "copied"/"failed" afterwards ("copying" while in flight).
    const [copyState, setCopyState] = React.useState<"copied" | "failed" | "copying" | null>(
        COPY_IDLE,
    );
    const showTranscript = transcriptVisible(state) && transcript !== null;

    React.useEffect(() => {
        if (!showTranscript || transcript === null || transcript.clipboard === "ok") {
            return;
        }
        let cancelled = false;
        setCopyState("copying");
        void onCopy(transcript.text).then((ok) => {
            if (!cancelled) {
                setCopyState(ok ? "copied" : "failed");
            }
        });
        return () => {
            cancelled = true;
        };
    }, [showTranscript, transcript, onCopy]);

    const copyAgain = (): void => {
        if (transcript === null) {
            return;
        }
        setCopyState("copying");
        void onCopy(transcript.text).then((ok) => {
            setCopyState(ok ? "copied" : "failed");
        });
    };

    const backendCopied = transcript !== null && transcript.clipboard === "ok";
    const copied = backendCopied || copyState === "copied";
    const failed = !backendCopied && (copyState === "failed" || transcript?.clipboard === "failed");

    return (
        <PanelSectionRow>
            <div data-dictation-card="true" style={{ width: "100%" }}>
                <div style={{ display: "flex", justifyContent: "center", padding: "4px 0" }}>
                    <MicrophoneButton
                        state={button.visualState}
                        disabled={button.disabled}
                        onPress={onPress}
                        locale={locale}
                        size={BIG_BUTTON_SIZE}
                    />
                </div>
                {recording ? (
                    <LevelStrip
                        bars={levels.bars}
                        label={translate(locale, "dictation.level.label")}
                    />
                ) : null}
                {showTranscript && transcript !== null ? (
                    <div data-transcript-block="true" style={{ marginTop: 8 }}>
                        <div style={{ fontSize: 11, opacity: 0.7 }}>
                            {translate(locale, "dictation.transcript.label")}
                        </div>
                        <div
                            data-transcript-preview="true"
                            style={{
                                marginTop: 2,
                                padding: "5px 8px",
                                borderRadius: 6,
                                background: "rgba(25, 28, 34, 0.85)",
                                border: "1px solid rgba(255, 255, 255, 0.25)",
                                fontSize: 13,
                                lineHeight: 1.4,
                                whiteSpace: "pre-wrap",
                                wordBreak: "break-word",
                            }}
                        >
                            {truncatePreview(transcript.text)}
                        </div>
                        <div style={{ marginTop: 4, fontSize: 12 }}>
                            {copied ? (
                                <span role="status" data-clipboard-status="copied">
                                    ✓ {translate(locale, "dictation.clipboard.copied")}
                                </span>
                            ) : failed ? (
                                <span role="alert" data-clipboard-status="failed">
                                    {translate(locale, "dictation.clipboard.failed")}
                                </span>
                            ) : (
                                <span style={{ opacity: 0.7 }} data-clipboard-status="copying">
                                    {translate(locale, "dictation.copying")}
                                </span>
                            )}
                        </div>
                        <button
                            type="button"
                            data-copy-again="true"
                            onClick={copyAgain}
                            aria-label={translate(locale, "dictation.copyAgain")}
                            style={{
                                marginTop: 6,
                                padding: "5px 12px",
                                borderRadius: 6,
                                border: "1px solid rgba(255, 255, 255, 0.35)",
                                background: "rgba(25, 28, 34, 0.85)",
                                color: "#ffffff",
                                fontSize: 12,
                                cursor: "pointer",
                            }}
                        >
                            {translate(locale, "dictation.copyAgain")}
                        </button>
                    </div>
                ) : null}
                <div style={{ marginTop: 4, fontSize: 11, opacity: 0.7 }} aria-hidden="true">
                    {translateMicLabel(locale, button.visualState)}
                </div>
            </div>
        </PanelSectionRow>
    );
}

/**
 * DictationCard (owner pivot) — the QAM panel's dictation surface.
 *
 * Layout, top of the plugin panel: a BIG microphone button driven by the
 * SAME application state union and `MicrophoneButtonModel` semantics as the
 * keyboard mount (the active indicator appears only after the start
 * acknowledgement and ends with the stop), presses going through the
 * controller's panel press path (mutex, state machine, stale-result
 * protection — all unchanged). While `recording`, the LevelVisualizer's
 * strip renders ONLY the real received `recording_level` frames (live
 * amplitude envelope from the daemon's audio.sock — a level meter, not an
 * FFT) in the user-selected style (heatmap default, classic, mirror;
 * frontend-local choice persisted under `speechtodeck.`); the compact
 * style-picker row beneath it stays visible in EVERY state so the style
 * can be chosen before a recording starts.
 * After a settled flow, the transcript preview plus the clipboard status
 * line and a "copy again" action: the transcript travels to the Steam
 * keyboard's Paste key (STEAM+X on-screen keyboard) via the system
 * clipboard.
 *
 * The card's inset panels (strip frame, picker, transcript preview, copy
 * controls) share one dark-panel surface palette (`DARK_PANEL_SURFACE`).
 *
 * The strip's height transitions run only while events arrive (bars
 * re-render on publishes, never on a timer) and are disabled under
 * `prefers-reduced-motion`. All strings via i18n.
 */

import * as React from "react";
import { PanelSectionRow } from "@decky/ui";
import { MicrophoneButton } from "../keyboard/MicrophoneButton";
import { microphoneButtonModel } from "../keyboard/MicrophoneButtonModel";
import { translate, translateError, translateMicLabel } from "../i18n/messages";
import type { Locale } from "../i18n/messages";
import type { DictationState } from "../../domain/DictationState";
import { LevelMeterStore } from "../../application/ports/LevelMeterPort";
import type { PanelTranscriptSnapshot } from "../../application/ports/PanelTranscriptPort";
import { CodeChip } from "./CodeChip";
import { DARK_PANEL_SURFACE, LevelVisualizer } from "./LevelVisualizer";

export interface DictationCardProps {
    /** Controller store snapshot (the state union drives everything). */
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
const PREVIEW_MAX_CHARS = 140;
/** Panel copy outcome; null before the auto-copy for the current transcript. */
const COPY_IDLE: "copied" | "failed" | "copying" | null = null;

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

export function DictationCard({
    state,
    levelMeter,
    transcript,
    onPress,
    onCopy,
    locale = "en",
}: DictationCardProps): React.ReactElement {
    const button = microphoneButtonModel(state);
    const recording = state.kind === "recording";

    // Bound, render-store accessors, same closure pattern as the panel.
    const subscribeLevels = React.useMemo(
        () => (onChange: () => void) => levelMeter.subscribe(onChange),
        [levelMeter],
    );
    const getLevels = React.useMemo(() => () => levelMeter.getSnapshot(), [levelMeter]);
    const levels = React.useSyncExternalStore(subscribeLevels, getLevels);

    // Fresh level window per recording session (never stale bars).
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
                {/* Strip only while recording; the style picker is always visible. */}
                <LevelVisualizer bars={levels.bars} showStrip={recording} locale={locale} />
                {state.kind === "error" ? (
                    // Inline error details (diagnosability): the stable
                    // code chip plus the mapped text right where the press
                    // failed — same layout as the setup-failed chip — not
                    // only in the Diagnostics section's last-error row.
                    <div
                        role="alert"
                        data-dictation-error="true"
                        style={{ marginTop: 6, fontSize: 12, display: "flex", gap: 6 }}
                    >
                        <CodeChip code={state.error.code} />
                        <span style={{ minWidth: 0 }}>
                            {translateError(locale, state.error.code)}
                        </span>
                    </div>
                ) : null}
                {showTranscript && transcript !== null ? (
                    <div data-transcript-block="true" style={{ marginTop: 8 }}>
                        <div style={{ fontSize: 11, opacity: 0.7 }}>
                            {translate(locale, "dictation.transcript.label")}
                        </div>
                        <div
                            data-transcript-preview="true"
                            style={{
                                ...DARK_PANEL_SURFACE,
                                marginTop: 2,
                                padding: "5px 8px",
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
                                ...DARK_PANEL_SURFACE,
                                // Deliberate emphasis: the action button keeps
                                // its slightly brighter border over the shared
                                // surface (unchanged from the previous style).
                                border: "1px solid rgba(255, 255, 255, 0.35)",
                                marginTop: 6,
                                padding: "5px 12px",
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

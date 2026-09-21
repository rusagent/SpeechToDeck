import * as React from "react";
import { PanelSectionRow } from "@decky/ui";
import { MicrophoneButton } from "../controls/MicrophoneButton";
import { microphoneButtonModel } from "../controls/MicrophoneButtonModel";
import { translate, translateError, translateMicLabel } from "../i18n/messages";
import type { Locale } from "../i18n/messages";
import type { DictationState } from "../../domain/DictationState";
import { LevelMeterStore } from "../../application/ports/LevelMeterPort";
import type { PanelTranscriptSnapshot } from "../../application/ports/PanelTranscriptPort";
import { CodeChip } from "./CodeChip";
import { DARK_PANEL_SURFACE, LevelVisualizer } from "./LevelVisualizer";

export interface DictationCardProps {
    readonly state: DictationState;
    readonly levelMeter: LevelMeterStore;
    readonly transcript: PanelTranscriptSnapshot | null;
    readonly onPress: () => void;
    readonly onCopy: (text: string) => Promise<boolean>;
    readonly locale?: Locale;
}

const BIG_BUTTON_SIZE = 72;
const PREVIEW_MAX_CHARS = 140;
const COPY_IDLE: "copied" | "failed" | "copying" | null = null;

function truncatePreview(text: string): string {
    return text.length > PREVIEW_MAX_CHARS ? `${text.slice(0, PREVIEW_MAX_CHARS)}…` : text;
}

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

    const subscribeLevels = React.useMemo(
        () => (onChange: () => void) => levelMeter.subscribe(onChange),
        [levelMeter],
    );
    const getLevels = React.useMemo(() => () => levelMeter.getSnapshot(), [levelMeter]);
    const levels = React.useSyncExternalStore(subscribeLevels, getLevels);

    React.useEffect(() => {
        if (recording) {
            levelMeter.reset();
        }
    }, [recording, levelMeter]);

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
                {}
                <LevelVisualizer bars={levels.bars} showStrip={recording} locale={locale} />
                {state.kind === "error" ? (
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

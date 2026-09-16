/**
 * DiagnosticsPanel (spec §58/§80) — read-only capability and health display.
 *
 * Values are shown from the §58 probe report, the §54 settings and the
 * controller state; nothing here writes text or mutates the session. The
 * §80 "benchmark button" is intentionally absent in this slice: the frozen
 * §30 callable list has no benchmark callable to invoke, so a button would
 * be a fake control.
 */

import * as React from "react";
import { ButtonItem, Field } from "@decky/ui";
import { translate, translateError, translateRuntimeHealth } from "../i18n/messages";
import type { Locale } from "../i18n/messages";
import type { DictationState } from "../../domain/DictationState";
import type { KeyboardCapabilityReport } from "../../domain/Capability";
import type { SpeechCapabilities } from "../../application/ports/SpeechPort";
import type { PluginSettings } from "../../application/ports/SettingsPort";

/** Data source seam wired by the composition root (no Decky/Steam imports). */
export interface DiagnosticsSource {
    loadCapabilityReport(): Promise<KeyboardCapabilityReport | null>;

    loadSpeechCapabilities(): Promise<SpeechCapabilities | null>;

    restartRuntime(): Promise<void>;
}

export interface DiagnosticsPanelProps {
    readonly state: DictationState;
    readonly settings: PluginSettings | null;
    readonly source: DiagnosticsSource;
    readonly locale: Locale;
}

function boolText(value: boolean | undefined, locale: Locale): string {
    if (value === undefined) {
        return translate(locale, "common.unknown");
    }
    return translate(locale, value ? "common.available" : "common.unavailable");
}

export function DiagnosticsPanel({
    state,
    settings,
    source,
    locale,
}: DiagnosticsPanelProps): React.ReactElement {
    const [report, setReport] = React.useState<KeyboardCapabilityReport | null>(null);
    const [speech, setSpeech] = React.useState<SpeechCapabilities | null>(null);
    const [restarting, setRestarting] = React.useState(false);

    React.useEffect(() => {
        let cancelled = false;
        void source.loadCapabilityReport().then((value) => {
            if (!cancelled) {
                setReport(value);
            }
        });
        void source.loadSpeechCapabilities().then((value) => {
            if (!cancelled) {
                setSpeech(value);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [source]);

    const lastError =
        state.kind === "error"
            ? translateError(locale, state.error.code)
            : translate(locale, "common.none");

    return (
        <>
            <Field label={translate(locale, "diagnostics.keyboardDetected")}>
                {boolText(report?.keyboardSignatureSupported, locale)}
            </Field>
            <Field label={translate(locale, "diagnostics.pasteCapability")}>
                {boolText(report?.nativePasteRecognized, locale)}
            </Field>
            <Field label={translate(locale, "diagnostics.clipboardCapability")}>
                {boolText(report?.clipboardUsable, locale)}
            </Field>
            <Field label={translate(locale, "setting.microphone")}>
                {boolText(speech?.microphoneAvailable, locale)}
            </Field>
            <Field label={translate(locale, "diagnostics.runtimeStatus")}>
                {translateRuntimeHealth(locale, state)}
            </Field>
            <Field label={translate(locale, "diagnostics.model")}>
                {settings?.modelId ?? translate(locale, "common.unknown")}
            </Field>
            <Field label={translate(locale, "diagnostics.computeBackend")}>
                {settings?.computeBackend ?? translate(locale, "common.unknown")}
            </Field>
            <Field label={translate(locale, "diagnostics.lastError")}>{lastError}</Field>
            <ButtonItem
                label={translate(locale, "diagnostics.restartRuntime")}
                disabled={restarting}
                onClick={() => {
                    setRestarting(true);
                    void source
                        .restartRuntime()
                        .catch(() => undefined)
                        .finally(() => {
                            setRestarting(false);
                        });
                }}
            >
                {translate(locale, "diagnostics.restartRuntime")}
            </ButtonItem>
        </>
    );
}

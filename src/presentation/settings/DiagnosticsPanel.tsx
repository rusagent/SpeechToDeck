/**
 * DiagnosticsPanel (spec §58/§80) — read-only capability and health display.
 *
 * Values are shown from the §58 probe report, the §54 settings and the
 * controller state; nothing here writes text or mutates the session. The
 * §80 "benchmark button" is intentionally absent in this slice: the frozen
 * §30 callable list has no benchmark callable to invoke, so a button would
 * be a fake control.
 *
 * Every capability row renders a state chip (shape + text, never color-only,
 * §107) with an explicit unknown state while probes are pending or failed.
 * The last runtime error shows the stable §68 code next to its localized
 * message (§109: the code is a fixed enum, sanitized by construction).
 */

import * as React from "react";
import { ButtonItem, Field } from "@decky/ui";
import { translate, translateError, translateRuntimeHealth } from "../i18n/messages";
import type { Locale } from "../i18n/messages";
import type { DictationState } from "../../domain/DictationState";
import type { KeyboardCapabilityReport } from "../../domain/Capability";
import type { SpeechCapabilities } from "../../application/ports/SpeechPort";
import type { PluginSettings } from "../../application/ports/SettingsPort";
import { CapabilityChip, capabilityState } from "./CapabilityChip";
import type { CapabilityState } from "./CapabilityChip";

/**
 * Data source seam wired by the composition root (no Decky/Steam imports).
 * `loadSpeechCapabilities` is consumed by the settings panel (model install
 * state, microphone availability) and passed down here as `speech`.
 */
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

/**
 * Monospace chip showing the raw stable §68 code next to its mapped text
 * (§109: the code is a fixed enum, sanitized by construction). Shared with
 * the setup-progress panel so both error surfaces read identically.
 */
export function CodeChip({ code }: { code: string }): React.ReactElement {
    return (
        <span
            style={{
                display: "inline-block",
                padding: "0 6px",
                borderRadius: 4,
                background: "rgba(255, 255, 255, 0.08)",
                border: "1px solid rgba(255, 92, 92, 0.4)",
                fontFamily: "monospace",
                fontSize: 11,
                lineHeight: 1.6,
                color: "rgba(255, 255, 255, 0.75)",
            }}
        >
            {code}
        </span>
    );
}

function CapabilityRow(props: {
    label: string;
    value: boolean | undefined;
    locale: Locale;
}): React.ReactElement {
    const state: CapabilityState = capabilityState(props.value);
    return (
        <Field label={props.label}>
            <CapabilityChip state={state} locale={props.locale} />
        </Field>
    );
}

export function DiagnosticsPanel({
    state,
    settings,
    source,
    locale,
}: DiagnosticsPanelProps): React.ReactElement {
    const [report, setReport] = React.useState<KeyboardCapabilityReport | null>(null);
    const [restarting, setRestarting] = React.useState(false);

    React.useEffect(() => {
        let cancelled = false;
        void source.loadCapabilityReport().then((value) => {
            if (!cancelled) {
                setReport(value);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [source]);

    return (
        <>
            <CapabilityRow
                label={translate(locale, "diagnostics.keyboardDetected")}
                value={report?.keyboardSignatureSupported}
                locale={locale}
            />
            <CapabilityRow
                label={translate(locale, "diagnostics.pasteCapability")}
                value={report?.nativePasteRecognized}
                locale={locale}
            />
            <CapabilityRow
                label={translate(locale, "diagnostics.clipboardCapability")}
                value={report?.clipboardUsable}
                locale={locale}
            />
            <Field label={translate(locale, "diagnostics.runtimeStatus")}>
                {translateRuntimeHealth(locale, state)}
            </Field>
            <Field label={translate(locale, "diagnostics.model")}>
                {settings === null
                    ? translate(locale, "common.unknown")
                    : translate(locale, `option.model.${settings.modelId}` as "option.model.tiny")}
            </Field>
            <Field label={translate(locale, "diagnostics.computeBackend")}>
                {settings === null
                    ? translate(locale, "common.unknown")
                    : translate(
                          locale,
                          `option.backend.${settings.computeBackend}` as "option.backend.auto",
                      )}
            </Field>
            <Field label={translate(locale, "diagnostics.lastError")}>
                {state.kind === "error" ? (
                    <span>
                        <CodeChip code={state.error.code} />
                        <div style={{ marginTop: 3 }}>
                            {translateError(locale, state.error.code)}
                        </div>
                    </span>
                ) : (
                    translate(locale, "common.none")
                )}
            </Field>
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

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
import {
    translate,
    translateDegradeReason,
    translateError,
    translateRuntimeHealth,
} from "../i18n/messages";
import type { Locale } from "../i18n/messages";
import type { DictationState } from "../../domain/DictationState";
import type { KeyboardCapabilityReport } from "../../domain/Capability";
import type { CdpDiagnosticsReport, SpeechCapabilities } from "../../application/ports/SpeechPort";
import type { KeyboardHostDiagnostics } from "../../application/ports/KeyboardHostPort";
import type { PluginSettings } from "../../application/ports/SettingsPort";
import { CapabilityChip, capabilityState } from "./CapabilityChip";
import type { CapabilityState } from "./CapabilityChip";

/**
 * Data source seam wired by the composition root (no Decky/Steam imports).
 * `loadSpeechCapabilities` is consumed by the settings panel (model install
 * state, microphone availability) and passed down here as `speech`.
 * `loadCdpDiagnostics`/`loadKeyboardHookDiagnostics` are the additive v0.1.6
 * cross-view facts; both degrade to null when unavailable.
 */
export interface DiagnosticsSource {
    loadCapabilityReport(): Promise<KeyboardCapabilityReport | null>;
    loadSpeechCapabilities(): Promise<SpeechCapabilities | null>;
    /**
     * Optional since v0.1.6: the cross-view diagnostics rows render unknown
     * when the composition does not provide them (§99 additive surface).
     */
    loadCdpDiagnostics?(): Promise<CdpDiagnosticsReport | null>;
    loadKeyboardHookDiagnostics?(): Promise<KeyboardHostDiagnostics | null>;
    /**
     * Hydrates the setup store from the §30 status report so a startup
     * failure that fired before the panel subscribed still renders (live
     * events always win). No-op when the runtime is fine or a snapshot
     * already exists.
     */
    hydrateSetupProgress(): Promise<void>;
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
    const [cdp, setCdp] = React.useState<CdpDiagnosticsReport | null>(null);
    const [hook, setHook] = React.useState<KeyboardHostDiagnostics | null>(null);
    const [restarting, setRestarting] = React.useState(false);

    React.useEffect(() => {
        let cancelled = false;
        void source.loadCapabilityReport().then((value) => {
            if (!cancelled) {
                setReport(value);
            }
        });
        void Promise.resolve(source.loadCdpDiagnostics?.()).then((value) => {
            if (!cancelled && value !== undefined) {
                setCdp(value);
            }
        });
        void Promise.resolve(source.loadKeyboardHookDiagnostics?.()).then((value) => {
            if (!cancelled && value !== undefined) {
                setHook(value);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [source]);

    return (
        <>
            <Field label={translate(locale, "diagnostics.keyboardDetected")}>
                <CapabilityChip
                    state={capabilityState(report?.keyboardSignatureSupported)}
                    locale={locale}
                />
                {hook !== null && hook.reason !== null && (
                    <div style={{ marginTop: 3, opacity: 0.75, fontSize: 11 }}>
                        {translateDegradeReason(locale, hook.reason)}
                    </div>
                )}
            </Field>
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
            <Field label={translate(locale, "diagnostics.cdpDiagnostics")}>
                <CapabilityChip
                    state={capabilityState(cdp === null ? undefined : cdp.cdpAvailable)}
                    locale={locale}
                />
                {cdp !== null && !cdp.cdpAvailable && (
                    <div style={{ marginTop: 3, opacity: 0.75, fontSize: 11 }}>
                        {translateDegradeReason(locale, cdp.reason)}
                    </div>
                )}
            </Field>
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

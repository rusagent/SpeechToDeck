/**
 * SettingsPanel (spec §54/§80/§102) — the Decky plugin panel.
 *
 * Loads the settings document through the SettingsPort (backend-owned
 * persistence, §55) and saves through the same port on every change. The
 * §80 sections (Runtime / Speech / Output / Diagnostics) render as nested
 * titled panel sections; read-only rows use one field idiom so labels and
 * values stay aligned. Application/runtime state is consumed through
 * `useSyncExternalStore` over the controller store (§102); only this panel
 * and the microphone mount subscribe to relevant state (§66).
 */

import * as React from "react";
import {
    DropdownItem,
    Field,
    PanelSection,
    PanelSectionRow,
    SliderField,
    ToggleField,
} from "@decky/ui";
import type { DictationState } from "../../domain/DictationState";
import type { StateStore } from "../../application/DictationController";
import type { PluginSettings, SettingsPort } from "../../application/ports/SettingsPort";
import type { SpeechCapabilities } from "../../application/ports/SpeechPort";
import { translate, translateRuntimeHealth } from "../i18n/messages";
import type { Locale, MessageKey } from "../i18n/messages";
import { CapabilityChip, capabilityState } from "./CapabilityChip";
import { ComputeBackendPicker } from "./ComputeBackendPicker";
import { DiagnosticsPanel } from "./DiagnosticsPanel";
import type { DiagnosticsSource } from "./DiagnosticsPanel";
import { LanguagePicker } from "./LanguagePicker";
import { ModelPicker } from "./ModelPicker";

export interface SettingsPanelProps {
    readonly settings: SettingsPort;
    readonly store: StateStore<DictationState>;
    readonly diagnostics: DiagnosticsSource;
    readonly locale?: Locale;
}

const MAX_DURATION_MIN_SECONDS = 5;
const MAX_DURATION_MAX_SECONDS = 120;
const MAX_DURATION_STEP_SECONDS = 5;

const OUTPUT_MODES: readonly PluginSettings["outputMode"][] = ["direct-insert", "clipboard-only"];

function optionLabel(locale: Locale, prefix: string, value: string): string {
    return translate(locale, `${prefix}.${value}` as MessageKey);
}

export function SettingsPanel({
    settings,
    store,
    diagnostics,
    locale = "en",
}: SettingsPanelProps): React.ReactElement {
    const [value, setValue] = React.useState<PluginSettings | null>(null);
    const [saveError, setSaveError] = React.useState(false);
    // §57: availability is reported, never assumed — unknown until the
    // probe resolves, and a failed probe stays unknown instead of lying.
    const [speech, setSpeech] = React.useState<SpeechCapabilities | null>(null);
    // Bound, render-stable store accessors (§102): useSyncExternalStore calls
    // these as plain functions, so unbound class methods would lose `this`.
    // Same closure pattern as the microphone-button bridge (§66).
    const subscribe = React.useMemo(
        () => (onChange: () => void) => store.subscribe(onChange),
        [store],
    );
    const getSnapshot = React.useMemo(() => () => store.getSnapshot(), [store]);
    const runtimeState = React.useSyncExternalStore(subscribe, getSnapshot);

    React.useEffect(() => {
        let cancelled = false;
        settings
            .load()
            .then((loaded) => {
                if (!cancelled) {
                    setValue(loaded);
                }
            })
            .catch(() => {
                if (!cancelled) {
                    setValue(null);
                }
            });
        void diagnostics.loadSpeechCapabilities().then((caps) => {
            if (!cancelled) {
                setSpeech(caps);
            }
        });
        return () => {
            cancelled = true;
        };
    }, [settings, diagnostics]);

    const update = (change: Partial<PluginSettings>): void => {
        if (value === null) {
            return;
        }
        const next: PluginSettings = { ...value, ...change };
        setValue(next);
        setSaveError(false);
        settings.save(next).catch(() => {
            setSaveError(true);
        });
    };

    if (value === null) {
        return (
            <PanelSection title={translate(locale, "panel.title")} spinner>
                <PanelSectionRow>
                    <span>{translate(locale, "setting.loading")}</span>
                </PanelSectionRow>
            </PanelSection>
        );
    }

    return (
        <PanelSection title={translate(locale, "panel.title")}>
            {saveError ? (
                <PanelSectionRow>
                    <span role="alert">⚠ {translate(locale, "setting.saveFailed")}</span>
                </PanelSectionRow>
            ) : null}

            <PanelSection title={translate(locale, "section.runtime")}>
                <PanelSectionRow>
                    <ToggleField
                        label={translate(locale, "setting.enabled")}
                        checked={value.enabled}
                        onChange={(checked) => update({ enabled: checked })}
                    />
                </PanelSectionRow>
                <PanelSectionRow>
                    <ComputeBackendPicker
                        value={value.computeBackend}
                        locale={locale}
                        onChange={(backend) => update({ computeBackend: backend })}
                    />
                </PanelSectionRow>
                <PanelSectionRow>
                    <Field label={translate(locale, "setting.runtimeHealth")}>
                        {translateRuntimeHealth(locale, runtimeState)}
                    </Field>
                </PanelSectionRow>
            </PanelSection>

            <PanelSection title={translate(locale, "section.speech")}>
                <PanelSectionRow>
                    <ModelPicker
                        value={value.modelId}
                        locale={locale}
                        installed={speech?.modelInstalled}
                        onChange={(model) => update({ modelId: model })}
                    />
                </PanelSectionRow>
                <PanelSectionRow>
                    <LanguagePicker
                        value={value.language}
                        locale={locale}
                        onChange={(language) => update({ language })}
                    />
                </PanelSectionRow>
                <PanelSectionRow>
                    <Field label={translate(locale, "setting.microphone")}>
                        <CapabilityChip
                            state={capabilityState(speech?.microphoneAvailable)}
                            locale={locale}
                        />
                    </Field>
                </PanelSectionRow>
                <PanelSectionRow>
                    <SliderField
                        label={translate(locale, "setting.maxDuration")}
                        value={value.maxRecordingSeconds}
                        min={MAX_DURATION_MIN_SECONDS}
                        max={MAX_DURATION_MAX_SECONDS}
                        step={MAX_DURATION_STEP_SECONDS}
                        showValue
                        onChange={(seconds) => update({ maxRecordingSeconds: seconds })}
                    />
                </PanelSectionRow>
                <PanelSectionRow>
                    <ToggleField
                        label={translate(locale, "setting.vad")}
                        checked={value.vadEnabled}
                        onChange={(checked) => update({ vadEnabled: checked })}
                    />
                </PanelSectionRow>
            </PanelSection>

            <PanelSection title={translate(locale, "section.output")}>
                <PanelSectionRow>
                    <DropdownItem
                        label={translate(locale, "setting.outputMode")}
                        rgOptions={OUTPUT_MODES.map((mode) => ({
                            data: mode,
                            label: optionLabel(locale, "option.output", mode),
                        }))}
                        selectedOption={value.outputMode}
                        onChange={(option) =>
                            update({ outputMode: option.data as PluginSettings["outputMode"] })
                        }
                    />
                </PanelSectionRow>
            </PanelSection>

            <PanelSection title={translate(locale, "section.diagnostics")}>
                <PanelSectionRow>
                    <DiagnosticsPanel
                        state={runtimeState}
                        settings={value}
                        source={diagnostics}
                        locale={locale}
                    />
                </PanelSectionRow>
            </PanelSection>
        </PanelSection>
    );
}

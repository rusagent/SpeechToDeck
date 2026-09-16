/**
 * SettingsPanel (spec §54/§80/§102) — the Decky plugin panel.
 *
 * Loads the settings document through the SettingsPort (backend-owned
 * persistence, §55), renders the §80 sections with @decky/ui components and
 * saves through the same port on every change. Application/runtime state is
 * consumed through `useSyncExternalStore` over the controller store (§102);
 * only this panel and the microphone mount subscribe to relevant state
 * (§66).
 */

import * as React from "react";
import { DropdownItem, PanelSection, PanelSectionRow, SliderField, ToggleField } from "@decky/ui";
import type { DictationState } from "../../domain/DictationState";
import type { StateStore } from "../../application/DictationController";
import type { PluginSettings, SettingsPort } from "../../application/ports/SettingsPort";
import { translate, translateRuntimeHealth } from "../i18n/messages";
import type { Locale, MessageKey } from "../i18n/messages";
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

/** Simple label/value row for non-interactive settings display. */
function ValueRow(props: { label: string; value: React.ReactNode }): React.ReactElement {
    return (
        <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
            <span>{props.label}</span>
            <span>{props.value}</span>
        </div>
    );
}

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
    const runtimeState = React.useSyncExternalStore(store.subscribe, store.getSnapshot);

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
        return () => {
            cancelled = true;
        };
    }, [settings]);

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
                    <span>{translate(locale, "setting.saveFailed")}</span>
                </PanelSectionRow>
            ) : null}

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
                <ValueRow
                    label={translate(locale, "setting.runtimeHealth")}
                    value={translateRuntimeHealth(locale, runtimeState)}
                />
            </PanelSectionRow>

            <PanelSectionRow>
                <ModelPicker
                    value={value.modelId}
                    locale={locale}
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
                <ValueRow
                    label={translate(locale, "setting.microphone")}
                    value={translate(
                        locale,
                        value.enabled ? "common.available" : "common.unavailable",
                    )}
                />
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

            <PanelSectionRow>
                <DiagnosticsPanel
                    state={runtimeState}
                    settings={value}
                    source={diagnostics}
                    locale={locale}
                />
            </PanelSectionRow>
        </PanelSection>
    );
}

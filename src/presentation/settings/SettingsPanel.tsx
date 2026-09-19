/**
 * SettingsPanel (spec §54/§80/§102) — the Decky plugin panel.
 *
 * Loads the settings document through the SettingsPort (backend-owned
 * persistence, §55) and saves through the same port on every change. The
 * §80 sections render as nested titled panel sections. v0.2.5 declutter
 * (owner list): the Microphone/Available chip row, the Maximum Recording
 * Duration slider, the VAD toggle, the runtime-health row and the whole
 * Diagnostics section are gone — the panel reads as Dictation card / (setup
 * when needed) / Runtime (Enabled + Compute backend) / Speech (Language →
 * Model) / Output (Output mode). Application/runtime state is consumed
 * through `useSyncExternalStore` over the controller store (§102); only
 * this panel and the microphone mount subscribe to relevant state (§66).
 */

import * as React from "react";
import { DropdownItem, PanelSection, PanelSectionRow, ToggleField } from "@decky/ui";
import type { DictationState } from "../../domain/DictationState";
import type { StateStore } from "../../application/DictationController";
import type { PluginSettings, SettingsPort } from "../../application/ports/SettingsPort";
import type { SetupProgressSnapshot } from "../../application/ports/SetupProgressPort";
import type { ModelCatalogSnapshot } from "../../application/ports/ModelCatalogPort";
import { LevelMeterStore } from "../../application/ports/LevelMeterPort";
import type { PanelTranscriptSnapshot } from "../../application/ports/PanelTranscriptPort";
import { translate } from "../i18n/messages";
import type { Locale, MessageKey } from "../i18n/messages";
import { ComputeBackendPicker } from "./ComputeBackendPicker";
import type { DiagnosticsSource } from "./DiagnosticsSource";
import { DictationCard } from "./DictationCard";
import { LanguagePicker } from "./LanguagePicker";
import { ModelSelect } from "./ModelSelect";
import { SetupProgressPanel } from "./SetupProgressPanel";

export interface SettingsPanelProps {
    readonly settings: SettingsPort;
    readonly store: StateStore<DictationState>;
    readonly setupProgress: StateStore<SetupProgressSnapshot | null>;
    readonly diagnostics: DiagnosticsSource;
    readonly locale?: Locale;
    /**
     * Additive v0.2 dictation card wiring (owner pivot): stores + press/copy
     * handlers composed by the composition root. The card renders only when
     * provided (§99 additive surface — never a fake control).
     */
    readonly dictation?: {
        readonly levelMeter: LevelMeterStore;
        readonly transcript: StateStore<PanelTranscriptSnapshot | null>;
        readonly onPress: () => void;
        readonly onCopy: (text: string) => Promise<boolean>;
    };
    /**
     * Additive curated model catalog wiring (ADR-011): guarded catalog store
     * + download handlers composed by the composition root. The model
     * select renders only when provided (§99 additive surface — never a
     * fake control).
     */
    readonly modelCatalog?: {
        readonly store: StateStore<ModelCatalogSnapshot>;
        readonly load: () => Promise<void>;
        readonly download: (modelId: string) => void;
        readonly cancel: () => void;
    };
}

const OUTPUT_MODES: readonly PluginSettings["outputMode"][] = ["direct-insert", "clipboard-only"];

function optionLabel(locale: Locale, prefix: string, value: string): string {
    return translate(locale, `${prefix}.${value}` as MessageKey);
}

export function SettingsPanel({
    settings,
    store,
    setupProgress,
    diagnostics,
    locale = "en",
    dictation,
    modelCatalog,
}: SettingsPanelProps): React.ReactElement {
    const [value, setValue] = React.useState<PluginSettings | null>(null);
    const [saveError, setSaveError] = React.useState(false);
    // Bound, render-stable store accessors (§102): useSyncExternalStore calls
    // these as plain functions, so unbound class methods would lose `this`.
    // Same closure pattern as the microphone-button bridge (§66).
    const subscribe = React.useMemo(
        () => (onChange: () => void) => store.subscribe(onChange),
        [store],
    );
    const getSnapshot = React.useMemo(() => () => store.getSnapshot(), [store]);
    const runtimeState = React.useSyncExternalStore(subscribe, getSnapshot);
    // Setup progress is transport-level UI state with its own dedicated
    // store; same bound-accessor pattern (§102), never the dictation machine.
    const subscribeSetup = React.useMemo(
        () => (onChange: () => void) => setupProgress.subscribe(onChange),
        [setupProgress],
    );
    const getSetupSnapshot = React.useMemo(
        () => () => setupProgress.getSnapshot(),
        [setupProgress],
    );
    const setup = React.useSyncExternalStore(subscribeSetup, getSetupSnapshot);
    // Additive v0.2: the dictation card's transcript snapshot — same bound
    // accessor pattern (§102); absent wiring renders no card.
    const subscribeTranscript = React.useMemo(
        () => (onChange: () => void) =>
            dictation?.transcript.subscribe(onChange) ?? (() => undefined),
        [dictation],
    );
    const getTranscript = React.useMemo(
        () => () => dictation?.transcript.getSnapshot() ?? null,
        [dictation],
    );
    const dictationTranscript = React.useSyncExternalStore(subscribeTranscript, getTranscript);
    // Shown while the runtime is setting up or failed; terminal `ready`
    // hides it again, and a disabled plugin shows no progress at all.
    const showSetup = value !== null && value.enabled && setup !== null && setup.step !== "ready";

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
        // Failure hydration: a startup failure that fired before this panel
        // subscribed left no live setup snapshot (on-device v0.1.3 finding).
        // The adapter rebuilds the terminal failed view from the §30 status
        // report, never overwriting an existing snapshot (live wins).
        void diagnostics.hydrateSetupProgress();
        return () => {
            cancelled = true;
        };
    }, [settings, diagnostics]);

    // ADR-011: load the curated catalog once per panel mount; load failures
    // leave the store empty and the select reports the catalog as
    // unavailable (§57: availability is reported, never assumed).
    React.useEffect(() => {
        if (modelCatalog === undefined) {
            return;
        }
        void modelCatalog.load();
    }, [modelCatalog]);

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
            {dictation !== undefined ? (
                <PanelSection title={translate(locale, "section.dictation")}>
                    <DictationCard
                        state={runtimeState}
                        levelMeter={dictation.levelMeter}
                        transcript={dictationTranscript}
                        onPress={dictation.onPress}
                        onCopy={dictation.onCopy}
                        locale={locale}
                    />
                </PanelSection>
            ) : null}
            {saveError ? (
                <PanelSectionRow>
                    <span role="alert">⚠ {translate(locale, "setting.saveFailed")}</span>
                </PanelSectionRow>
            ) : null}

            {showSetup && setup !== null ? (
                <PanelSectionRow>
                    <SetupProgressPanel
                        snapshot={setup}
                        locale={locale}
                        onRetry={() => diagnostics.restartRuntime()}
                    />
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
            </PanelSection>

            <PanelSection title={translate(locale, "section.speech")}>
                <PanelSectionRow>
                    <LanguagePicker
                        value={value.language}
                        locale={locale}
                        onChange={(language) => update({ language })}
                    />
                </PanelSectionRow>
                {modelCatalog !== undefined ? (
                    <PanelSectionRow>
                        <ModelSelect
                            value={value.modelId}
                            locale={locale}
                            language={value.language}
                            store={modelCatalog.store}
                            onChange={(modelId) => update({ modelId })}
                            onDownload={modelCatalog.download}
                            onCancel={modelCatalog.cancel}
                        />
                    </PanelSectionRow>
                ) : null}
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
        </PanelSection>
    );
}

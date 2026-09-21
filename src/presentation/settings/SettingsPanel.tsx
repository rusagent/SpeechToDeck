import * as React from "react";
import { ButtonItem, DialogButton, PanelSection, PanelSectionRow, ToggleField } from "@decky/ui";
import type { DictationState } from "../../domain/DictationState";
import type { StateStore } from "../../application/DictationController";
import type { ClockPort } from "../../application/ports/ClockPort";
import type { PluginSettings, SettingsPort } from "../../application/ports/SettingsPort";
import type { SetupProgressSnapshot } from "../../application/ports/SetupProgressPort";
import type { ModelCatalogSnapshot } from "../../application/ports/ModelCatalogPort";
import { LevelMeterStore } from "../../application/ports/LevelMeterPort";
import type { PanelTranscriptSnapshot } from "../../application/ports/PanelTranscriptPort";
import { translate } from "../i18n/messages";
import type { Locale } from "../i18n/messages";
import type { DiagnosticsSource } from "./DiagnosticsSource";
import { DictationCard } from "./DictationCard";
import { LanguagePicker } from "./LanguagePicker";
import { openManageModelsModal } from "./ManageModels";
import { ModelSelect } from "./ModelSelect";
import { SetupProgressPanel } from "./SetupProgressPanel";

export interface SettingsPanelProps {
    readonly settings: SettingsPort;
    readonly store: StateStore<DictationState>;
    readonly setupProgress: StateStore<SetupProgressSnapshot | null>;
    readonly diagnostics: DiagnosticsSource;
    readonly clock: ClockPort;
    readonly locale?: Locale;
    readonly dictation?: {
        readonly levelMeter: LevelMeterStore;
        readonly transcript: StateStore<PanelTranscriptSnapshot | null>;
        readonly onPress: () => void;
        readonly onCopy: (text: string) => Promise<boolean>;
    };
    readonly modelCatalog?: {
        readonly store: StateStore<ModelCatalogSnapshot>;
        readonly load: () => Promise<void>;
        readonly download: (modelId: string) => void;
        readonly cancel: () => void;
        readonly deleteModel: (modelId: string) => Promise<void>;
    };
    readonly selfHeal?: {
        readonly reportLoadOutcome: (outcome: "timeout" | "rejected" | "success") => boolean;
        readonly onImportPlugin: (listener: () => void) => () => void;
    };
}

const SETTINGS_LOAD_TIMEOUT_MS = 10_000;

export function SettingsPanel({
    settings,
    store,
    setupProgress,
    diagnostics,
    clock,
    locale = "en",
    dictation,
    modelCatalog,
    selfHeal,
}: SettingsPanelProps): React.ReactElement {
    const [value, setValue] = React.useState<PluginSettings | null>(null);
    const [saveError, setSaveError] = React.useState(false);
    const [loadFailed, setLoadFailed] = React.useState(false);
    const [loadAttempt, setLoadAttempt] = React.useState(0);
    const [reloadPending, setReloadPending] = React.useState(false);
    const subscribe = React.useMemo(
        () => (onChange: () => void) => store.subscribe(onChange),
        [store],
    );
    const getSnapshot = React.useMemo(() => () => store.getSnapshot(), [store]);
    const runtimeState = React.useSyncExternalStore(subscribe, getSnapshot);
    const subscribeSetup = React.useMemo(
        () => (onChange: () => void) => setupProgress.subscribe(onChange),
        [setupProgress],
    );
    const getSetupSnapshot = React.useMemo(
        () => () => setupProgress.getSnapshot(),
        [setupProgress],
    );
    const setup = React.useSyncExternalStore(subscribeSetup, getSetupSnapshot);
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
    const subscribeCatalog = React.useMemo(
        () => (onChange: () => void) =>
            modelCatalog?.store.subscribe(onChange) ?? (() => undefined),
        [modelCatalog],
    );
    const getCatalogSnapshot = React.useMemo(
        () => () => modelCatalog?.store.getSnapshot() ?? null,
        [modelCatalog],
    );
    const catalogSnapshot = React.useSyncExternalStore(subscribeCatalog, getCatalogSnapshot);
    const showSetup = value !== null && value.enabled && setup !== null && setup.step !== "ready";
    const selectedCatalogModel =
        value === null ? undefined : catalogSnapshot?.models.find((m) => m.id === value.modelId);
    const showLanguagePicker =
        selectedCatalogModel === undefined || selectedCatalogModel.languages === undefined;

    React.useEffect(() => {
        let cancelled = false;
        const deadline = clock.nowMonotonicMs() + SETTINGS_LOAD_TIMEOUT_MS;
        const wakeup = window.setTimeout(() => {
            if (!cancelled && clock.nowMonotonicMs() >= deadline) {
                setLoadFailed(true);
                if (selfHeal?.reportLoadOutcome("timeout") === true) {
                    setReloadPending(true);
                }
            }
        }, SETTINGS_LOAD_TIMEOUT_MS);
        settings
            .load()
            .then((loaded) => {
                if (!cancelled) {
                    window.clearTimeout(wakeup);
                    setLoadFailed(false);
                    setReloadPending(false);
                    setValue(loaded);
                    selfHeal?.reportLoadOutcome("success");
                }
            })
            .catch(() => {
                if (!cancelled) {
                    window.clearTimeout(wakeup);
                    setLoadFailed(true);
                    selfHeal?.reportLoadOutcome("rejected");
                }
            });
        void diagnostics.hydrateSetupProgress();
        return () => {
            cancelled = true;
            window.clearTimeout(wakeup);
        };
    }, [settings, diagnostics, clock, loadAttempt, selfHeal]);

    React.useEffect(() => {
        if (selfHeal === undefined || !loadFailed) {
            return;
        }
        return selfHeal.onImportPlugin(() => {
            setLoadFailed(false);
            setReloadPending(false);
            setLoadAttempt((attempt) => attempt + 1);
        });
    }, [selfHeal, loadFailed]);

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

    const retryLoad = (): void => {
        setLoadFailed(false);
        setLoadAttempt((attempt) => attempt + 1);
    };

    if (value === null) {
        return (
            <PanelSection title={translate(locale, "panel.title")} spinner={!loadFailed}>
                {loadFailed ? (
                    <>
                        <PanelSectionRow>
                            <span role="alert">{translate(locale, "setting.loadFailed")}</span>
                        </PanelSectionRow>
                        <PanelSectionRow>
                            <span>
                                {translate(
                                    locale,
                                    reloadPending
                                        ? "setting.loadFailedReloading"
                                        : "setting.loadFailedHint",
                                )}
                            </span>
                        </PanelSectionRow>
                        <PanelSectionRow>
                            {}
                            <ButtonItem
                                label={translate(locale, "setup.retry")}
                                onClick={retryLoad}
                            >
                                {translate(locale, "setup.retry")}
                            </ButtonItem>
                        </PanelSectionRow>
                    </>
                ) : (
                    <PanelSectionRow>
                        <span>{translate(locale, "setting.loading")}</span>
                    </PanelSectionRow>
                )}
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
            </PanelSection>

            <PanelSection title={translate(locale, "section.speech")}>
                {modelCatalog !== undefined ? (
                    <PanelSectionRow>
                        <ModelSelect
                            value={value.modelId}
                            locale={locale}
                            store={modelCatalog.store}
                            onChange={(modelId) => update({ modelId })}
                            onDownload={modelCatalog.download}
                            onCancel={modelCatalog.cancel}
                        />
                    </PanelSectionRow>
                ) : null}
                {}
                {modelCatalog !== undefined &&
                catalogSnapshot !== null &&
                catalogSnapshot.models.length > 0 ? (
                    <PanelSectionRow>
                        <DialogButton
                            data-manage-open="true"
                            onClick={() =>
                                openManageModelsModal({
                                    store: modelCatalog.store,
                                    locale,
                                    selectedModelId: value.modelId,
                                    onDelete: modelCatalog.deleteModel,
                                    onRefresh: modelCatalog.load,
                                })
                            }
                        >
                            {translate(locale, "model.manage.open")}
                        </DialogButton>
                    </PanelSectionRow>
                ) : null}
                {showLanguagePicker ? (
                    <PanelSectionRow>
                        <LanguagePicker
                            value={value.language}
                            locale={locale}
                            onChange={(language) => update({ language })}
                        />
                    </PanelSectionRow>
                ) : null}
            </PanelSection>
        </PanelSection>
    );
}

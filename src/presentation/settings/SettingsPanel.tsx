/**
 * SettingsPanel (spec §54/§80/§102) — the Decky plugin panel.
 *
 * Loads the settings document through the SettingsPort (backend-owned
 * persistence, §55) and saves through the same port on every change. The
 * §80 sections render as nested titled panel sections. v0.2.5 declutter
 * (owner list): the Microphone/Available chip row, the Maximum Recording
 * Duration slider, the VAD toggle, the runtime-health row and the whole
 * Diagnostics section are gone — the panel reads as Dictation card / (setup
 * when needed) / Runtime (Enabled) / Speech (Model, with
 * the Language picker below it only while the selected model does not pin a
 * language) / Output (Output mode). Application/runtime state is consumed
 * through `useSyncExternalStore` over the controller store (§102); only
 * this panel and the microphone mount subscribe to relevant state (§66).
 * The initial settings load is honest about failure: a load that neither
 * resolves nor rejects within 10 s (a wedged backend callable) leaves the
 * loading state with a failed message and a Retry control instead of an
 * eternal spinner; the deadline is measured on the injected monotonic clock.
 * v0.2.9 install-wedge self-heal: the panel reports each settled boot-load
 * outcome to the optional `selfHeal` port — two consecutive full-deadline
 * timeouts (the wedged-callable signature) make the composition-root side
 * reload the plugin backend once, the hint names it, and the loader's
 * re-import broadcast re-arms the load while the panel sits in the failed
 * state. The port owns the gates (session/download) and the loader access.
 */

import * as React from "react";
import { ButtonItem, DropdownItem, PanelSection, PanelSectionRow, ToggleField } from "@decky/ui";
import type { DictationState } from "../../domain/DictationState";
import type { StateStore } from "../../application/DictationController";
import type { ClockPort } from "../../application/ports/ClockPort";
import type { PluginSettings, SettingsPort } from "../../application/ports/SettingsPort";
import type { SetupProgressSnapshot } from "../../application/ports/SetupProgressPort";
import type { ModelCatalogSnapshot } from "../../application/ports/ModelCatalogPort";
import { LevelMeterStore } from "../../application/ports/LevelMeterPort";
import type { PanelTranscriptSnapshot } from "../../application/ports/PanelTranscriptPort";
import { translate } from "../i18n/messages";
import type { Locale, MessageKey } from "../i18n/messages";
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
    /** Monotonic clock for the settings-load deadline (§7.1 durations only). */
    readonly clock: ClockPort;
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
    /**
     * Additive install-wedge self-heal wiring (v0.2.9): the panel reports
     * settled boot-load outcomes; the bound port (composed in the
     * composition root) owns the gates — dictation session, model download —
     * and the loader route access. `reportLoadOutcome` returns whether the
     * reload fired (the hint then names it); `onImportPlugin` subscribes to
     * the loader's re-import broadcast for the failed-state re-arm.
     */
    readonly selfHeal?: {
        readonly reportLoadOutcome: (outcome: "timeout" | "rejected" | "success") => boolean;
        readonly onImportPlugin: (listener: () => void) => () => void;
    };
}

const OUTPUT_MODES: readonly PluginSettings["outputMode"][] = ["direct-insert", "clipboard-only"];

/** How long the initial settings load may stay unanswered before failing. */
const SETTINGS_LOAD_TIMEOUT_MS = 10_000;

function optionLabel(locale: Locale, prefix: string, value: string): string {
    return translate(locale, `${prefix}.${value}` as MessageKey);
}

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
    // Honest load failure (the eternal-spinner fix): set when the load
    // rejects or outlives the 10 s deadline; `loadAttempt` re-arms the load
    // effect for Retry.
    const [loadFailed, setLoadFailed] = React.useState(false);
    const [loadAttempt, setLoadAttempt] = React.useState(0);
    // Self-heal leg (v0.2.9): set when the port reports that the loader
    // reload fired; the failed-state hint then names the reload instead of
    // the generic advice. Cleared by a success or a re-import re-arm.
    const [reloadPending, setReloadPending] = React.useState(false);
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
    // Additive ADR-011: the catalog snapshot decides whether the Language
    // picker renders at all (same bound-accessor pattern, §102). Absent
    // wiring reads as the unloaded catalog → the picker stays.
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
    // Shown while the runtime is setting up or failed; terminal `ready`
    // hides it again, and a disabled plugin shows no progress at all.
    const showSetup = value !== null && value.enabled && setup !== null && setup.step !== "ready";
    // The Language picker renders ONLY while the selected model declares no
    // languages at all: an unloaded catalog, an unknown (older-backend)
    // model id, or a general model without a `languages` field. ANY
    // declared-language model hides the picker — single-language
    // declarations are the only shipped case (ADR-011/ADR-012), and for
    // those the backend forces the declared language regardless of
    // `settings.language`, so the picker would be a lie. The persisted
    // `language` value is never cleared or rewritten here — switching back
    // to a general model restores the prior selection (the backend honors
    // `language` only when no single language is declared).
    const selectedCatalogModel =
        value === null ? undefined : catalogSnapshot?.models.find((m) => m.id === value.modelId);
    const showLanguagePicker =
        selectedCatalogModel === undefined || selectedCatalogModel.languages === undefined;

    React.useEffect(() => {
        let cancelled = false;
        // The deadline lives on the injected monotonic clock (§7.1 durations
        // only); the window timer is just the wakeup, and the clock decides
        // whether the deadline actually elapsed when it fires.
        const deadline = clock.nowMonotonicMs() + SETTINGS_LOAD_TIMEOUT_MS;
        const wakeup = window.setTimeout(() => {
            if (!cancelled && clock.nowMonotonicMs() >= deadline) {
                setLoadFailed(true);
                // Self-heal accounting: a full-deadline timeout is the
                // wedged callable's signature. The port (gates + once-per-
                // module-session latch) decides; true means the reload fired
                // and the hint must say so.
                if (selfHeal?.reportLoadOutcome("timeout") === true) {
                    setReloadPending(true);
                }
            }
        }, SETTINGS_LOAD_TIMEOUT_MS);
        settings
            .load()
            .then((loaded) => {
                if (!cancelled) {
                    // A late success after the timeout fired still renders
                    // normally (pinned behavior): the data wins over the
                    // failed state once it arrives.
                    window.clearTimeout(wakeup);
                    setLoadFailed(false);
                    setReloadPending(false);
                    setValue(loaded);
                    // The backend answered: the timeout streak resets.
                    selfHeal?.reportLoadOutcome("success");
                }
            })
            .catch(() => {
                if (!cancelled) {
                    window.clearTimeout(wakeup);
                    setLoadFailed(true);
                    // A coded reply proves the callable path answers — the
                    // reload must never fire on it; the streak just resets.
                    selfHeal?.reportLoadOutcome("rejected");
                }
            });
        // Failure hydration: a startup failure that fired before this panel
        // subscribed left no live setup snapshot (on-device v0.1.3 finding).
        // The adapter rebuilds the terminal failed view from the §30 status
        // report, never overwriting an existing snapshot (live wins).
        void diagnostics.hydrateSetupProgress();
        return () => {
            cancelled = true;
            window.clearTimeout(wakeup);
        };
    }, [settings, diagnostics, clock, loadAttempt, selfHeal]);

    // Self-heal re-arm (v0.2.9): when the loader re-imports this plugin
    // (fresh backend is up) while the panel sits in the failed state, retry
    // the load instead of waiting for the user to find Retry. Subscribed
    // only while failed, so re-imports outside a failure never restart the
    // boot load.
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

    // Retry the initial load: back to the loading state with a fresh 10 s
    // deadline (the effect re-runs per attempt; its cleanup retires the old
    // wakeup timer).
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
                            {/* Same generic retry label as the setup failed
                                state; the control retries the settings load. */}
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

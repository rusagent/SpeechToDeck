import * as React from "react";
import { createRoot } from "react-dom/client";
import { SettingsPanel } from "../../src/presentation/settings/SettingsPanel";
import { MicrophoneButton } from "../../src/presentation/controls/MicrophoneButton";
import { DictationCard } from "../../src/presentation/settings/DictationCard";
import { LevelMeterStore } from "../../src/application/ports/LevelMeterPort";
import { translateError } from "../../src/presentation/i18n/messages";
import type { Locale } from "../../src/presentation/i18n/messages";
import { DictationError } from "../../src/domain/DictationError";
import type { DictationState } from "../../src/domain/DictationState";
import type { DiagnosticsSource } from "../../src/presentation/settings/DiagnosticsSource";
import type { PanelTranscriptSnapshot } from "../../src/application/ports/PanelTranscriptPort";
import type {
    SetupProgressSnapshot,
    SetupProgressStore,
} from "../../src/application/ports/SetupProgressPort";
import type { CatalogModel } from "../../src/application/ports/ModelCatalogPort";
import { ModelCatalogStore } from "../../src/application/ports/ModelCatalogPort";
import type { SettingsPort } from "../../src/application/ports/SettingsPort";
import { openModelDownloadModal } from "../../src/presentation/settings/ModelSelect";
import { openManageModelsModal } from "../../src/presentation/settings/ManageModels";
import { DeckyBackendClient } from "../../src/infrastructure/decky/DeckyBackendClient";
import { DeckySpeechAdapter } from "../../src/infrastructure/decky/DeckySpeechAdapter";
import { copyTextToClipboard } from "../../src/infrastructure/system/PanelClipboard";
import { SystemClock } from "../../src/infrastructure/system/SystemClock";
import { FakeSettingsPort } from "../../tests/frontend/fakes/FakeSettingsPort";
import {
    FAILED_GET_STATUS_REPORT,
    SETUP_SNAPSHOTS,
    FakeDeckyTransport,
    FakeSnapshotStore,
    FakeStateStore,
} from "../../tests/contract/helpers";

export type HarnessCaseId = "panel" | "mic" | "setup" | "dictation";

export type HarnessSetupVariant = keyof typeof SETUP_SNAPSHOTS | "hydrated-failed" | "none";

export type HarnessDictationVariant = "idle" | "recording" | "transcript";

export type HarnessCatalogVariant = "none" | "ready" | "modal" | "manage";

export interface HarnessParams {
    readonly caseId: HarnessCaseId;
    readonly locale: Locale;
    readonly stateKind: "ready" | "recording" | "error";
    readonly setup: HarnessSetupVariant;
    readonly dictation: HarnessDictationVariant;
    readonly catalog?: HarnessCatalogVariant;
    readonly settingsLoad?: "failed";
    readonly language?: string;
    readonly scroll: string | null;
}

export const CAPTURED_CASES: readonly HarnessParams[] = [
    {
        caseId: "panel",
        locale: "en",
        stateKind: "ready",
        setup: "none",
        dictation: "idle",
        scroll: null,
    },
    {
        caseId: "panel",
        locale: "de",
        stateKind: "ready",
        setup: "none",
        dictation: "idle",
        scroll: null,
    },
    {
        caseId: "panel",
        locale: "en",
        stateKind: "recording",
        setup: "none",
        dictation: "idle",
        scroll: null,
    },
    {
        caseId: "panel",
        locale: "en",
        stateKind: "ready",
        setup: "none",
        dictation: "idle",
        settingsLoad: "failed",
        scroll: null,
    },
    {
        caseId: "mic",
        locale: "en",
        stateKind: "ready",
        setup: "none",
        dictation: "idle",
        scroll: null,
    },
    {
        caseId: "mic",
        locale: "de",
        stateKind: "ready",
        setup: "none",
        dictation: "idle",
        scroll: null,
    },
    {
        caseId: "setup",
        locale: "en",
        stateKind: "ready",
        setup: "indeterminate",
        dictation: "idle",
        scroll: null,
    },
    {
        caseId: "setup",
        locale: "en",
        stateKind: "ready",
        setup: "download",
        dictation: "idle",
        scroll: null,
    },
    {
        caseId: "setup",
        locale: "en",
        stateKind: "ready",
        setup: "failed",
        dictation: "idle",
        scroll: null,
    },
    {
        caseId: "setup",
        locale: "de",
        stateKind: "ready",
        setup: "failed",
        dictation: "idle",
        scroll: null,
    },
    {
        caseId: "setup",
        locale: "en",
        stateKind: "ready",
        setup: "ready",
        dictation: "idle",
        scroll: null,
    },
    {
        caseId: "setup",
        locale: "en",
        stateKind: "ready",
        setup: "hydrated-failed",
        dictation: "idle",
        scroll: null,
    },
    {
        caseId: "dictation",
        locale: "en",
        stateKind: "ready",
        setup: "none",
        dictation: "idle",
        scroll: null,
    },
    {
        caseId: "dictation",
        locale: "en",
        stateKind: "ready",
        setup: "none",
        dictation: "recording",
        scroll: null,
    },
    {
        caseId: "dictation",
        locale: "en",
        stateKind: "ready",
        setup: "none",
        dictation: "transcript",
        scroll: null,
    },
    {
        caseId: "dictation",
        locale: "de",
        stateKind: "ready",
        setup: "none",
        dictation: "transcript",
        scroll: null,
    },
    {
        caseId: "panel",
        locale: "en",
        stateKind: "ready",
        setup: "none",
        dictation: "idle",
        catalog: "ready",
        scroll: null,
    },
    {
        caseId: "panel",
        locale: "en",
        stateKind: "ready",
        setup: "none",
        dictation: "idle",
        catalog: "modal",
        scroll: null,
    },
    {
        caseId: "panel",
        locale: "en",
        stateKind: "ready",
        setup: "none",
        dictation: "idle",
        catalog: "manage",
        scroll: null,
    },
];

const HARNESS_MODEL_CATALOG: readonly CatalogModel[] = [
    {
        id: "tiny",
        engine: "whisper",
        multilingual: true,
        filename: "ggml-tiny.bin",
        installed: true,
        sizeBytes: 77691713,
    },
    {
        id: "base",
        engine: "whisper",
        multilingual: true,
        filename: "ggml-base.bin",
        installed: true,
        sizeBytes: 147951465,
    },
    {
        id: "small",
        engine: "whisper",
        multilingual: true,
        filename: "ggml-small.bin",
        installed: true,
        sizeBytes: 487601967,
    },
    {
        id: "whisper-large-v3-turbo-q5_0",
        engine: "whisper",
        multilingual: true,
        filename: "ggml-large-v3-turbo-q5_0.bin",
        installed: false,
        sizeBytes: 574041195,
        description:
            "Recommended primary model: near large-v3 accuracy at turbo speed, quantized for the Deck.",
    },
    {
        id: "whisper-large-v3-turbo",
        engine: "whisper",
        multilingual: true,
        filename: "ggml-large-v3-turbo.bin",
        installed: false,
        sizeBytes: 1624555275,
        description: "Full-precision large-v3-turbo for the best general-purpose accuracy.",
    },
    {
        id: "distil-small-en",
        engine: "whisper",
        multilingual: false,
        filename: "ggml-distil-small.en.bin",
        installed: false,
        sizeBytes: 336191657,
        languages: ["en"],
        description: "English-only distilled model with the lowest latency.",
    },
    {
        id: "distil-medium-en",
        engine: "whisper",
        multilingual: false,
        filename: "ggml-medium-32-2.en.bin",
        installed: false,
        sizeBytes: 794018180,
        languages: ["en"],
        description: "English-only distilled model balancing accuracy and speed.",
    },
    {
        id: "whisper-large-v3-turbo-german-q5_0",
        engine: "whisper",
        multilingual: true,
        filename: "ggml-primeline-de-turbo-q5_0.bin",
        installed: false,
        sizeBytes: 574041195,
        languages: ["de"],
        description: "German-specialized large-v3-turbo, quantized (Primeline).",
    },
    {
        id: "whisper-large-v3-turbo-german-f16",
        engine: "whisper",
        multilingual: true,
        filename: "ggml-primeline-de-turbo-f16.bin",
        installed: true,
        sizeBytes: 1624555275,
        languages: ["de"],
        description: "German-specialized large-v3-turbo at full precision (Primeline).",
    },
    {
        id: "whisper-large-v3-french-q5_0",
        engine: "whisper",
        multilingual: true,
        filename: "ggml-bofeng-fr-q5_0.bin",
        installed: false,
        sizeBytes: 1081140203,
        languages: ["fr"],
        description: "French-specialized large-v3 model, quantized.",
    },
    {
        id: "kotoba-whisper-v2.0-q5_0",
        engine: "whisper",
        multilingual: true,
        filename: "ggml-kotoba-v2-q5_0.bin",
        installed: false,
        sizeBytes: 537819875,
        languages: ["ja"],
        description: "Japanese-specialized whisper model, quantized (kotoba v2.0).",
    },
    {
        id: "kotoba-whisper-v2.0-f16",
        engine: "whisper",
        multilingual: true,
        filename: "ggml-kotoba-v2-f16.bin",
        installed: false,
        sizeBytes: 1519521155,
        languages: ["ja"],
        description: "Japanese-specialized whisper model at full precision (kotoba v2.0).",
    },
];

function fakeCatalogStore(variant: Exclude<HarnessCatalogVariant, "none">): ModelCatalogStore {
    const store = new ModelCatalogStore();
    store.setModels(HARNESS_MODEL_CATALOG);
    if (variant === "modal") {
        store.publishProgress({
            protocolVersion: 1,
            modelId: "whisper-large-v3-turbo-q5_0",
            bytesReceived: 574041195,
            totalBytes: 574041195,
        });
    }
    return store;
}

function fakeDiagnostics(): DiagnosticsSource {
    return {
        hydrateSetupProgress: async () => undefined,
        restartRuntime: async () => undefined,
    };
}

const clock = new SystemClock();

function hydratedFailureCase(): {
    store: SetupProgressStore;
    diagnostics: DiagnosticsSource;
} {
    const transport = new FakeDeckyTransport();
    transport.callResponses.set("get_status", FAILED_GET_STATUS_REPORT);
    const adapter = new DeckySpeechAdapter(new DeckyBackendClient(transport));
    adapter.subscribe(() => undefined);
    return {
        store: adapter.setupProgress,
        diagnostics: {
            hydrateSetupProgress: () => adapter.hydrateSetupFromStatus(),
            restartRuntime: async () => undefined,
        },
    };
}

function fakeState(stateKind: HarnessParams["stateKind"]): DictationState {
    switch (stateKind) {
        case "ready":
            return { kind: "ready" };
        case "recording":
            return {
                kind: "recording",
                session: {
                    sessionId: "harness-1",
                    startedAtMonotonicMs: performance.now() - 83_000,
                },
            };
        case "error":
            return {
                kind: "error",
                error: new DictationError("TRANSCRIPTION_FAILED"),
                recoverable: true,
            };
    }
}

function ModalOpener({ store, locale }: { store: ModelCatalogStore; locale: Locale }): null {
    React.useEffect(() => {
        const model = store
            .getSnapshot()
            .models.find((candidate) => candidate.id === "whisper-large-v3-turbo-q5_0");
        if (model === undefined || model.installed) {
            return;
        }
        openModelDownloadModal({
            model,
            locale,
            store,
            onCompleted: () => undefined,
            onCancel: () => undefined,
        });
        store.publishComplete({
            protocolVersion: 1,
            modelId: model.id,
            ...(model.sizeBytes !== undefined ? { sizeBytes: model.sizeBytes } : {}),
        });
    }, [store, locale]);
    return null;
}

function failedBootLoadPort(): SettingsPort {
    return {
        load: () => Promise.reject(new Error("harness: boot load failed")),
        save: async () => undefined,
    };
}

function ManageOpener({ store, locale }: { store: ModelCatalogStore; locale: Locale }): null {
    React.useEffect(() => {
        openManageModelsModal({
            store,
            locale,
            selectedModelId: "base",
            onDelete: () => Promise.resolve(),
            onRefresh: () => Promise.resolve(),
        });
    }, [store, locale]);
    return null;
}

function PanelCase({
    locale,
    stateKind,
    setup,
    catalog = "none",
    language = "system",
    settingsLoad = "ok",
}: {
    locale: Locale;
    stateKind: HarnessParams["stateKind"];
    setup: HarnessSetupVariant;
    catalog: HarnessCatalogVariant;
    language: string;
    settingsLoad: "ok" | "failed";
}) {
    const hydration = setup === "hydrated-failed" ? hydratedFailureCase() : null;
    const setupSnapshot: SetupProgressSnapshot | null =
        setup === "none" || setup === "hydrated-failed" ? null : SETUP_SNAPSHOTS[setup];
    const baseSettingsPort = new FakeSettingsPort();
    if (language !== "system") {
        baseSettingsPort.value = { ...baseSettingsPort.value, language };
    }
    const settingsPort: SettingsPort =
        settingsLoad === "failed" ? failedBootLoadPort() : baseSettingsPort;
    const catalogStore = catalog === "none" ? null : fakeCatalogStore(catalog);
    const modelCatalog =
        catalogStore === null
            ? undefined
            : {
                  store: catalogStore,
                  load: () => Promise.resolve(),
                  download: () => undefined,
                  cancel: () => undefined,
                  deleteModel: () => Promise.resolve(),
              };
    return (
        <>
            <SettingsPanel
                settings={settingsPort}
                store={new FakeStateStore(fakeState(stateKind))}
                setupProgress={
                    hydration
                        ? hydration.store
                        : new FakeSnapshotStore<SetupProgressSnapshot | null>(setupSnapshot)
                }
                diagnostics={hydration ? hydration.diagnostics : fakeDiagnostics()}
                clock={clock}
                locale={locale}
                {...(modelCatalog !== undefined ? { modelCatalog } : {})}
            />
            {catalogStore !== null && catalog === "modal" ? (
                <ModalOpener store={catalogStore} locale={locale} />
            ) : null}
            {catalogStore !== null && catalog === "manage" ? (
                <ManageOpener store={catalogStore} locale={locale} />
            ) : null}
        </>
    );
}

function MicCase({ locale }: { locale: Locale }): React.ReactElement {
    const message = translateError(locale, "TRANSCRIPTION_FAILED");
    const noop = (): void => undefined;
    return (
        <div className="mic-row">
            <figure>
                <MicrophoneButton state="ready" disabled={false} onPress={noop} locale={locale} />
                <figcaption>ready</figcaption>
            </figure>
            <figure>
                <MicrophoneButton
                    state="recording"
                    disabled={false}
                    onPress={noop}
                    locale={locale}
                    elapsedLabel="01:23"
                />
                <figcaption>recording</figcaption>
            </figure>
            <figure>
                <MicrophoneButton
                    state="processing"
                    disabled={true}
                    onPress={noop}
                    locale={locale}
                />
                <figcaption>processing</figcaption>
            </figure>
            <figure>
                <MicrophoneButton
                    state="error"
                    disabled={true}
                    onPress={noop}
                    locale={locale}
                    errorMessage={message}
                />
                <figcaption>error</figcaption>
            </figure>
        </div>
    );
}

function DictationCase({
    locale,
    variant,
}: {
    locale: Locale;
    variant: HarnessDictationVariant;
}): React.ReactElement {
    const levelMeter = new LevelMeterStore();
    const transcript = new FakeSnapshotStore<PanelTranscriptSnapshot | null>(
        variant === "transcript"
            ? {
                  sessionId: "harness-1",
                  text: "Hallo Welt, das ist das Diktat vom Steam Deck.",
                  clipboard: "ok",
              }
            : null,
    );
    const state: DictationState =
        variant === "recording"
            ? {
                  kind: "recording",
                  session: {
                      sessionId: "harness-1",
                      startedAtMonotonicMs: 0,
                  },
              }
            : { kind: "ready" };
    React.useEffect(() => {
        if (variant !== "recording") {
            return;
        }
        const amplitudes = [
            0.05, 0.12, 0.2, 0.35, 0.5, 0.62, 0.7, 0.65, 0.5, 0.3, 0.18, 0.1, 0.08, 0.15, 0.28,
            0.45, 0.6, 0.75, 0.85, 0.78, 0.6, 0.4, 0.22, 0.12,
        ];
        levelMeter.publish({
            protocolVersion: 1,
            kind: "recording_level",
            seq: 24,
            frames: amplitudes.map((a) => {
                const peakDbfs = Math.max(-60, 20 * Math.log10(a));
                return [-a, a, Math.round(peakDbfs * 1000) / 1000] as const;
            }),
        });
    }, [variant, levelMeter]);
    return (
        <DictationCard
            state={state}
            levelMeter={levelMeter}
            transcript={transcript.getSnapshot()}
            onPress={() => undefined}
            onCopy={(text: string) => copyTextToClipboard(text)}
            locale={locale}
        />
    );
}

function Harness({ params }: { params: HarnessParams }): React.ReactElement {
    if (params.caseId === "mic") {
        return <MicCase locale={params.locale} />;
    }
    if (params.caseId === "dictation") {
        return <DictationCase locale={params.locale} variant={params.dictation} />;
    }
    return (
        <PanelCase
            locale={params.locale}
            stateKind={params.stateKind}
            setup={params.setup}
            catalog={params.catalog ?? "none"}
            language={params.language ?? "system"}
            settingsLoad={params.settingsLoad === "failed" ? "failed" : "ok"}
        />
    );
}

export function mountVisualHarness(container: HTMLElement, params: HarnessParams): () => void {
    const root = createRoot(container);
    root.render(<Harness params={params} />);
    return () => root.unmount();
}

const SETUP_VARIANTS: readonly HarnessSetupVariant[] = [
    "download",
    "indeterminate",
    "failed",
    "ready",
    "hydrated-failed",
];

function paramsFromLocation(): HarnessParams {
    const search = new URLSearchParams(window.location.search);
    const rawCase = search.get("case");
    const caseId: HarnessCaseId =
        rawCase === "mic"
            ? "mic"
            : rawCase === "setup"
              ? "setup"
              : rawCase === "dictation"
                ? "dictation"
                : "panel";
    const locale: Locale = search.get("locale") === "de" ? "de" : "en";
    const state = search.get("state");
    const variant = search.get("variant");
    const setup: HarnessSetupVariant = SETUP_VARIANTS.includes(variant as HarnessSetupVariant)
        ? (variant as HarnessSetupVariant)
        : "none";
    const rawDictation = search.get("dictation");
    const dictation: HarnessDictationVariant =
        rawDictation === "recording" || rawDictation === "transcript" ? rawDictation : "idle";
    const rawCatalog = search.get("catalog");
    const catalog: HarnessCatalogVariant =
        rawCatalog === "ready" || rawCatalog === "modal" || rawCatalog === "manage"
            ? rawCatalog
            : "none";
    const load = search.get("load");
    return {
        caseId,
        locale,
        stateKind: state === "recording" || state === "error" ? state : "ready",
        setup,
        dictation,
        catalog,
        ...(load === "failed" ? { settingsLoad: "failed" as const } : {}),
        language: search.get("language") ?? "system",
        scroll: search.get("scroll"),
    };
}

const visualRoot = typeof document !== "undefined" ? document.getElementById("visual-root") : null;
if (
    visualRoot !== null &&
    typeof window !== "undefined" &&
    window.location.search.includes("case=")
) {
    const params = paramsFromLocation();
    mountVisualHarness(visualRoot, params);
    const settle = (): void => {
        const doc = document.documentElement;
        visualRoot.dataset.overflowX = doc.scrollWidth > doc.clientWidth ? "true" : "false";
        const sections = Array.from(
            document.querySelectorAll<HTMLElement>(".decky-panel-section"),
        ).map((section) => {
            const rect = section.getBoundingClientRect();
            return {
                title: section.dataset.panelTitle ?? "",
                top: Math.round(rect.top + window.scrollY),
                height: Math.round(rect.height),
            };
        });
        const catalogBlock = document.querySelector<HTMLElement>("[data-model-select]");
        const regions: { name: string; top: number; height: number }[] = [];
        if (catalogBlock) {
            const blockRect = catalogBlock.getBoundingClientRect();
            regions.push({
                name: "modelSelect",
                top: Math.round(blockRect.top + window.scrollY),
                height: Math.round(blockRect.height),
            });
        }
        const modalCard = document.querySelector<HTMLElement>(".decky-modal-dialog");
        if (modalCard) {
            const modalRect = modalCard.getBoundingClientRect();
            const manageModal = document.querySelector<HTMLElement>("[data-manage-modal]");
            regions.push({
                name: manageModal !== null ? "manageModal" : "downloadModal",
                top: Math.round(modalRect.top + window.scrollY),
                height: Math.round(modalRect.height),
            });
        }
        visualRoot.dataset.geometry = JSON.stringify({
            docH: doc.scrollHeight,
            rootX: Math.round(visualRoot.getBoundingClientRect().left + window.scrollX),
            sections,
            regions,
        });
    };
    window.requestAnimationFrame(settle);
    window.setTimeout(settle, 300);
}

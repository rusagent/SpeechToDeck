/**
 * Visual-harness entry (spec §19/§20/§80/§107 acceptance surface).
 *
 * Mounts the REAL presentation components — SettingsPanel and
 * MicrophoneButton — with the repository's existing fakes
 * (FakeSettingsPort, FakeStateStore) and realistic capability reports, on
 * a plain HTML page sized like the Deck QAM plugin column (~410px). The
 * `@decky/ui` primitives are resolved from the `DeckyUI` global exactly as
 * in the packaged plugin; outside Steam the committed stand-in
 * (decky-ui-standin.js) provides that global with the Deck visual language.
 *
 * Cases are selected via query parameters (`case`, `locale`, `state`,
 * `scroll`). The same mount function is exercised by the jsdom smoke test
 * (harness.test.tsx) for every captured state.
 */

import * as React from "react";
import { createRoot } from "react-dom/client";
import { SettingsPanel } from "../../src/presentation/settings/SettingsPanel";
import { MicrophoneButton } from "../../src/presentation/keyboard/MicrophoneButton";
import { DictationCard } from "../../src/presentation/settings/DictationCard";
import { LevelMeterStore } from "../../src/application/ports/LevelMeterPort";
import { translateError } from "../../src/presentation/i18n/messages";
import type { Locale } from "../../src/presentation/i18n/messages";
import { DictationError } from "../../src/domain/DictationError";
import type { DictationState } from "../../src/domain/DictationState";
import type { DiagnosticsSource } from "../../src/presentation/settings/DiagnosticsPanel";
import type { KeyboardCapabilityReport } from "../../src/domain/Capability";
import type { SpeechCapabilities } from "../../src/application/ports/SpeechPort";
import type { PanelTranscriptSnapshot } from "../../src/application/ports/PanelTranscriptPort";
import type {
    SetupProgressSnapshot,
    SetupProgressStore,
} from "../../src/application/ports/SetupProgressPort";
import type { CatalogModel } from "../../src/application/ports/ModelCatalogPort";
import { ModelCatalogStore } from "../../src/application/ports/ModelCatalogPort";
import { DeckyBackendClient } from "../../src/infrastructure/decky/DeckyBackendClient";
import { DeckySpeechAdapter } from "../../src/infrastructure/decky/DeckySpeechAdapter";
import { copyTextToClipboard } from "../../src/infrastructure/system/PanelClipboard";
import { FakeSettingsPort } from "../../tests/frontend/fakes/FakeSettingsPort";
import {
    FAILED_GET_STATUS_REPORT,
    SETUP_SNAPSHOTS,
    FakeDeckyTransport,
    FakeSnapshotStore,
    FakeStateStore,
} from "../../tests/contract/helpers";

export type HarnessCaseId = "panel" | "mic" | "setup" | "dictation";

/** Which `setup_progress` snapshot the setup case mounts (REAL component). */
export type HarnessSetupVariant = keyof typeof SETUP_SNAPSHOTS | "hydrated-failed" | "none";

/** Which dictation-card state the dictation case mounts (REAL component). */
export type HarnessDictationVariant = "idle" | "recording" | "transcript";

/**
 * Model-catalog wiring for the panel case (ADR-011): `ready` mounts the REAL
 * ModelPicker over a canned `list_models` snapshot matching the committed
 * defaults/models.json; `downloading` additionally puts one row into the
 * in-flight download state (~40%).
 */
export type HarnessCatalogVariant = "none" | "ready" | "downloading";

export interface HarnessParams {
    readonly caseId: HarnessCaseId;
    readonly locale: Locale;
    /** Store state for the panel case: `ready` | `recording` | `error`. */
    readonly stateKind: "ready" | "recording" | "error";
    /** Setup snapshot for the setup case. */
    readonly setup: HarnessSetupVariant;
    /** Dictation-card state for the dictation case. */
    readonly dictation: HarnessDictationVariant;
    /** Model-catalog wiring for the panel case (default `none`). */
    readonly catalog?: HarnessCatalogVariant;
    /** Settings language for the panel case (default `"system"`). */
    readonly language?: string;
    /** Optional `data-panel-title` of the section to scroll into view. */
    readonly scroll: string | null;
}

/** Every captured state; the smoke test mounts exactly these. */
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
    // Setup progress: real panel with the dedicated store preset per state.
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
    // Hydrated failure: no live event at all — the panel shows the failed
    // state because the real adapter rebuilt it from the §30 status report.
    {
        caseId: "setup",
        locale: "en",
        stateKind: "ready",
        setup: "hydrated-failed",
        dictation: "idle",
        scroll: null,
    },
    // Dictation card (v0.2): idle big button, live recording with REAL
    // received frames, and the settled transcript + clipboard block.
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
    // Catalog-driven ModelPicker (ADR-011): the REAL picker over a canned
    // list_models snapshot matching defaults/models.json, with a concrete
    // language selected so the per-language group renders (EN UI, "For de").
    {
        caseId: "panel",
        locale: "en",
        stateKind: "ready",
        setup: "none",
        dictation: "idle",
        catalog: "ready",
        language: "de",
        scroll: null,
    },
    // Same catalog with one row in the single-flight download state at 40%
    // (Cancel + live percentage; every other Download button disabled).
    {
        caseId: "panel",
        locale: "en",
        stateKind: "ready",
        setup: "none",
        dictation: "idle",
        catalog: "downloading",
        language: "de",
        scroll: null,
    },
];

const REPORT: KeyboardCapabilityReport = {
    windowReachable: true,
    managerRecognizable: true,
    keyboardSignatureSupported: true,
    clipboardUsable: true,
    nativePasteRecognized: true,
    supported: true,
    profileId: "steam-vk-semantic-v1",
};

const SPEECH: SpeechCapabilities = {
    speechRuntimeAvailable: true,
    microphoneAvailable: true,
    cpuAvailable: true,
    vulkanAvailable: true,
    modelInstalled: true,
};

/**
 * Canned `list_models` payload matching the committed defaults/models.json
 * catalog (ADR-011): the legacy trio installed, the German full-precision
 * model installed for install-state variety in the per-language group, every
 * other curated entry not installed. Sizes and descriptions mirror the real
 * manifest; the store payload never carries digests.
 */
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

/**
 * Builds the catalog store for the panel case through the production publish
 * paths. The downloading variant reports 40% of the recommended turbo model
 * (229616478 / 574041195 bytes) — the exact percent math the real
 * `model_download_progress` events produce.
 */
function fakeCatalogStore(variant: Exclude<HarnessCatalogVariant, "none">): ModelCatalogStore {
    const store = new ModelCatalogStore();
    store.setModels(HARNESS_MODEL_CATALOG);
    if (variant === "downloading") {
        store.publishProgress({
            protocolVersion: 1,
            modelId: "whisper-large-v3-turbo-q5_0",
            bytesReceived: 229616478,
            totalBytes: 574041195,
        });
    }
    return store;
}

function fakeDiagnostics(): DiagnosticsSource {
    return {
        loadCapabilityReport: async () => REPORT,
        loadSpeechCapabilities: async () => SPEECH,
        hydrateSetupProgress: async () => undefined,
        restartRuntime: async () => undefined,
    };
}

/**
 * The real hydration chain for the `hydrated-failed` case: a REAL adapter
 * over a transport seeded with the failed §30 status report. The panel
 * mounts with an empty setup store and reconstructs the failed state through
 * the production `hydrateSetupFromStatus` path — no live event involved.
 */
function hydratedFailureCase(): {
    store: SetupProgressStore;
    diagnostics: DiagnosticsSource;
} {
    const transport = new FakeDeckyTransport();
    transport.callResponses.set("get_status", FAILED_GET_STATUS_REPORT);
    const adapter = new DeckySpeechAdapter(new DeckyBackendClient(transport));
    adapter.subscribe(() => undefined); // arm the backend event subscriptions
    return {
        store: adapter.setupProgress,
        diagnostics: {
            loadCapabilityReport: async () => REPORT,
            loadSpeechCapabilities: async () => SPEECH,
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
                    keyboardContextId: "ctx-1",
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

function PanelCase({
    locale,
    stateKind,
    setup,
    catalog = "none",
    language = "system",
}: {
    locale: Locale;
    stateKind: HarnessParams["stateKind"];
    setup: HarnessSetupVariant;
    catalog: HarnessCatalogVariant;
    language: string;
}) {
    const hydration = setup === "hydrated-failed" ? hydratedFailureCase() : null;
    const setupSnapshot: SetupProgressSnapshot | null =
        setup === "none" || setup === "hydrated-failed" ? null : SETUP_SNAPSHOTS[setup];
    // ADR-011 catalog wiring: the REAL picker consumes the store side-channel
    // exactly like the composed panel (load is inert here — the store is
    // pre-populated through the production publish paths).
    const settingsPort = new FakeSettingsPort();
    if (language !== "system") {
        settingsPort.value = { ...settingsPort.value, language };
    }
    const catalogStore = catalog === "none" ? null : fakeCatalogStore(catalog);
    const modelCatalog =
        catalogStore === null
            ? undefined
            : {
                  store: catalogStore,
                  load: () => Promise.resolve(),
                  download: () => undefined,
                  cancel: () => undefined,
              };
    return (
        <SettingsPanel
            settings={settingsPort}
            store={new FakeStateStore(fakeState(stateKind))}
            setupProgress={
                hydration
                    ? hydration.store
                    : new FakeSnapshotStore<SetupProgressSnapshot | null>(setupSnapshot)
            }
            diagnostics={hydration ? hydration.diagnostics : fakeDiagnostics()}
            locale={locale}
            {...(modelCatalog !== undefined ? { modelCatalog } : {})}
        />
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

/**
 * Dictation-card case (v0.2): the REAL card over the REAL level store. The
 * `recording`/`transcript` variants publish REAL payload-shaped frames
 * (envelope numbers only) through the store's production publish path — the
 * rendered bars are exactly what real `recording_level` events produce; no
 * synthetic DOM, no synthetic CSS.
 */
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
                      keyboardContextId: null,
                      startedAtMonotonicMs: 0,
                  },
              }
            : { kind: "ready" };
    // Publish after mount (real event timing): the card resets the level
    // window when the state enters recording, so pre-mount frames would be
    // wiped by its fresh-window behavior.
    React.useEffect(() => {
        if (variant !== "recording") {
            return;
        }
        // 24 frames of a plausible spoken envelope: two gentle surges. Each
        // frame's peak is the envelope's dBFS (20·log10, floored at the
        // meter's -60 dBFS, rounded to 3 decimals like the backend's frames)
        // so the strip exercises the real dB-derived level mapping.
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
        />
    );
}

/** Mounts one captured state; returns the disposer. Shared with the smoke test. */
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
        rawCatalog === "ready" || rawCatalog === "downloading" ? rawCatalog : "none";
    return {
        caseId,
        locale,
        stateKind: state === "recording" || state === "error" ? state : "ready",
        setup,
        dictation,
        catalog,
        language: search.get("language") ?? "system",
        scroll: search.get("scroll"),
    };
}

// Browser auto-mount: only on the harness page itself (jsdom smoke calls
// mountVisualHarness directly and has no #visual-root + ?case URL).
const visualRoot = typeof document !== "undefined" ? document.getElementById("visual-root") : null;
if (
    visualRoot !== null &&
    typeof window !== "undefined" &&
    window.location.search.includes("case=")
) {
    const params = paramsFromLocation();
    mountVisualHarness(visualRoot, params);
    const settle = (): void => {
        // Numeric capture geometry for the driver: the page stays
        // unscrolled and the capture driver screenshots the full window and
        // crops the target region — headless Chromium maps window pixels
        // 1:1 onto the page from its origin, but does not reliably honor
        // page-side scroll offsets (the old scrollIntoView targeting
        // captured the wrong region for section shots).
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
        // Named sub-section regions for targeted crops (the catalog-driven
        // ModelPicker block is smaller than its host section, and its
        // per-language group must stay inside the ≤450px review crop).
        const catalogBlock = document.querySelector<HTMLElement>("[data-model-catalog]");
        const regions: { name: string; top: number; height: number }[] = [];
        if (catalogBlock) {
            const blockRect = catalogBlock.getBoundingClientRect();
            regions.push({
                name: "modelCatalog",
                top: Math.round(blockRect.top + window.scrollY),
                height: Math.round(blockRect.height),
            });
            for (const group of Array.from(
                catalogBlock.querySelectorAll<HTMLElement>("[data-model-group]"),
            )) {
                const groupRect = group.getBoundingClientRect();
                regions.push({
                    name: `modelGroup:${group.dataset.modelGroup ?? ""}`,
                    top: Math.round(groupRect.top + window.scrollY),
                    height: Math.round(groupRect.height),
                });
            }
        }
        visualRoot.dataset.geometry = JSON.stringify({
            docH: doc.scrollHeight,
            rootX: Math.round(visualRoot.getBoundingClientRect().left + window.scrollX),
            sections,
            regions,
        });
    };
    window.requestAnimationFrame(settle);
    // Fallback for capture drivers whose virtual clock does not run rAF.
    window.setTimeout(settle, 300);
}

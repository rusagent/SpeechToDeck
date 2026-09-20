/**
 * Composition root and Decky plugin entry.
 *
 * This module only creates dependencies and wires them — no application
 * logic. `PluginCompositionRoot` owns every disposable and disposes in
 * reverse construction order, executing the unload sequence: lifecycle
 * dispose (controller dispose → speech shutdown) → store unsubscription.
 */

import { definePlugin } from "@decky/api";
import * as React from "react";
import { DictationController } from "./application/DictationController";
import type { StateStore } from "./application/DictationController";
import { PluginLifecycle } from "./application/PluginLifecycle";
import { DeckyBackendClient } from "./infrastructure/decky/DeckyBackendClient";
import { createDeckyApiTransport } from "./infrastructure/decky/DeckyApiTransport";
import { DeckySelfHeal } from "./infrastructure/decky/DeckySelfHeal";
import type { SettingsLoadOutcome } from "./infrastructure/decky/DeckySelfHeal";
import { DeckySpeechAdapter } from "./infrastructure/decky/DeckySpeechAdapter";
import { DeckySettingsAdapter } from "./infrastructure/decky/DeckySettingsAdapter";
import type { SetupProgressStore } from "./application/ports/SetupProgressPort";
import type { LevelMeterStore } from "./application/ports/LevelMeterPort";
import type { ModelCatalogSnapshot } from "./application/ports/ModelCatalogPort";
import type { PanelTranscriptSnapshot } from "./application/ports/PanelTranscriptPort";
import { copyTextToClipboard } from "./infrastructure/system/PanelClipboard";
import { SteamClipboardAdapter } from "./infrastructure/steam/SteamClipboardAdapter";
import { RandomIdGenerator } from "./infrastructure/system/RandomIdGenerator";
import { SystemClock } from "./infrastructure/system/SystemClock";
import { SettingsPanel } from "./presentation/settings/SettingsPanel";
import type { DiagnosticsSource } from "./presentation/settings/DiagnosticsSource";
import type { Disposable } from "./shared/Disposable";
import { Logger } from "./shared/Logger";
import type { ClockPort } from "./application/ports/ClockPort";
import type { SettingsPort } from "./application/ports/SettingsPort";
import type { DictationState } from "./domain/DictationState";
import { extractSession } from "./domain/DictationState";

// Entry-module contract: the ONLY export is the callable default (the loader
// evaluates `m.default()`); the composition root is internal wiring.

/**
 * Self-heal gate after a torn loader install: a download counts as in flight
 * until its settle path clears it — EXCEPT the held final 100% completion
 * frame, which is settled state the modal still renders, never a
 * live download.
 */
function isDownloadInFlight(snapshot: ModelCatalogSnapshot): boolean {
    return snapshot.download !== null && snapshot.download.percent !== 100;
}

class PluginCompositionRoot implements Disposable {
    private readonly resources: Disposable[] = [];
    private readonly lifecycle: PluginLifecycle;
    private readonly logger: Logger;
    private started = false;

    /** Wired dependencies the plugin panel consumes. */
    readonly settingsPort: SettingsPort;
    readonly controllerStore: StateStore<DictationState>;
    readonly setupProgress: SetupProgressStore;
    readonly diagnostics: DiagnosticsSource;
    /** Monotonic clock: controller timings and the panel's load deadline. */
    readonly clock: ClockPort;
    /** Additive dictation card wiring for the plugin panel. */
    readonly dictation: {
        readonly levelMeter: LevelMeterStore;
        readonly transcript: StateStore<PanelTranscriptSnapshot | null>;
        readonly onPress: () => void;
        readonly onCopy: (text: string) => Promise<boolean>;
    };
    /** Additive curated model catalog wiring for the plugin panel. */
    readonly modelCatalog: {
        readonly store: StateStore<ModelCatalogSnapshot>;
        readonly load: () => Promise<void>;
        readonly download: (modelId: string) => void;
        readonly cancel: () => void;
        readonly deleteModel: (modelId: string) => Promise<void>;
    };
    /** Self-heal wiring for the plugin panel after a torn loader install. */
    readonly selfHeal: {
        readonly reportLoadOutcome: (outcome: SettingsLoadOutcome) => boolean;
        readonly onImportPlugin: (listener: () => void) => () => void;
    };

    constructor(logger: Logger = new Logger("plugin.lifecycle")) {
        this.logger = logger;

        // Wiring — construction order only, no service locator.
        const transport = createDeckyApiTransport();
        const backendClient = new DeckyBackendClient(transport);
        const speechPort = new DeckySpeechAdapter(backendClient);
        const settingsAdapter = new DeckySettingsAdapter(backendClient);
        this.settingsPort = settingsAdapter;
        this.setupProgress = speechPort.setupProgress;

        // Clipboard-only output: the settled transcript travels to the system
        // clipboard in one write; the user carries it into any text field with
        // the Steam keyboard's Paste key (STEAM+X).
        const clipboard = new SteamClipboardAdapter();

        const clock = new SystemClock();
        this.clock = clock;
        const controller = new DictationController(
            speechPort,
            clipboard,
            settingsAdapter,
            clock,
            new RandomIdGenerator(),
        );
        this.controllerStore = controller;

        // Trimmed to the two methods the panel still consumes (the
        // Diagnostics section removal orphaned the capability/cross-view
        // loaders; the loader-side providers stay untouched).
        this.diagnostics = {
            hydrateSetupProgress: () => speechPort.hydrateSetupFromStatus(),
            restartRuntime: async () => {
                await backendClient.call("restart_runtime");
            },
        };

        // Dictation card: the big button presses the SAME controller through
        // the panel entry (mutex, state machine, stale-result protection);
        // the level/transcript stores are the adapter's guarded UI
        // side-channels; the copy is the panel execCommand path (primary
        // while the backend xclip leg reports "skipped").
        this.dictation = {
            levelMeter: speechPort.levelMeter,
            transcript: speechPort.panelTranscript,
            onPress: () => {
                void controller.handlePanelMicrophonePressed();
            },
            onCopy: (text: string) => copyTextToClipboard(text),
        };

        // Model catalog: the guarded store side-channel plus the
        // download callables. Failures are logged with their detail and
        // leave the picker's store untouched (the row returns to its
        // pre-download action); nothing is silently swallowed.
        this.modelCatalog = {
            store: speechPort.modelCatalog,
            load: async () => {
                try {
                    await speechPort.listModels();
                } catch (error) {
                    this.logger.warn("model catalog load failed", {
                        detail: error instanceof Error ? error.message : String(error),
                    });
                }
            },
            download: (modelId: string) => {
                void speechPort.downloadModel(modelId).catch((error: unknown) => {
                    this.logger.warn("model download failed", {
                        modelId,
                        detail: error instanceof Error ? error.message : String(error),
                    });
                });
            },
            cancel: () => {
                void speechPort.cancelModelDownload().catch((error: unknown) => {
                    this.logger.warn("model download cancel failed", {
                        detail: error instanceof Error ? error.message : String(error),
                    });
                });
            },
            // In-app model cleanup: the id is the only input
            // — the backend resolves the artifact path from its strict
            // manifest. The manage modal awaits the result and owns the
            // inline error presentation, so the coded rejection is logged
            // here AND rethrown (never silently swallowed).
            deleteModel: async (modelId: string) => {
                try {
                    await speechPort.deleteModel(modelId);
                } catch (error) {
                    this.logger.warn("model delete failed", {
                        modelId,
                        detail: error instanceof Error ? error.message : String(error),
                    });
                    throw error;
                }
            },
        };

        // Loader-install self-heal: the panel reports boot-load
        // outcomes through the two-method port below. The gates are read
        // HERE, fresh at report time, over the composed stores — the reload
        // never fires during an active dictation session (any sessionful
        // state) or an in-flight model download. The reload itself lives in
        // the infrastructure adapter and fires at most once per frontend
        // module session (the loader's re-import resets it — never loops).
        const selfHeal = new DeckySelfHeal(transport);
        this.selfHeal = {
            reportLoadOutcome: (outcome) =>
                selfHeal.reportLoadOutcome(outcome, {
                    canReload:
                        extractSession(this.controllerStore.getSnapshot()) === null &&
                        !isDownloadInFlight(speechPort.modelCatalog.getSnapshot()),
                }),
            onImportPlugin: (listener) => selfHeal.onImportPlugin(listener),
        };

        this.lifecycle = new PluginLifecycle(controller, speechPort);
        this.resources.push(this.lifecycle);
    }

    async start(): Promise<void> {
        if (this.started) {
            return;
        }
        this.started = true;
        await this.lifecycle.start();
        this.logger.info("composition root started");
    }

    async dispose(): Promise<void> {
        for (const resource of [...this.resources].reverse()) {
            try {
                await resource.dispose();
            } catch (error) {
                // One failing teardown step must not block the rest.
                this.logger.error("composition root teardown step failed", {
                    detail: error instanceof Error ? error.message : String(error),
                });
            }
        }
    }
}

const PLUGIN_NAME = "SpeechToDeck";

const PLUGIN_ICON: React.ReactElement = (
    <svg width="32" height="32" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
        <path d="M12 14a3 3 0 0 0 3-3V6a3 3 0 1 0-6 0v5a3 3 0 0 0 3 3z" />
        <path d="M18 11a1 1 0 1 0-2 0 4 4 0 0 1-8 0 1 1 0 1 0-2 0 6 6 0 0 0 5 5.91V19H9a1 1 0 1 0 0 2h6a1 1 0 1 0 0-2h-2v-2.09A6 6 0 0 0 18 11z" />
    </svg>
);

export default definePlugin(() => {
    const compositionRoot = new PluginCompositionRoot();
    void compositionRoot.start();

    return {
        name: PLUGIN_NAME,
        icon: PLUGIN_ICON,
        content: (
            <SettingsPanel
                settings={compositionRoot.settingsPort}
                store={compositionRoot.controllerStore}
                setupProgress={compositionRoot.setupProgress}
                diagnostics={compositionRoot.diagnostics}
                clock={compositionRoot.clock}
                dictation={compositionRoot.dictation}
                modelCatalog={compositionRoot.modelCatalog}
                selfHeal={compositionRoot.selfHeal}
            />
        ),
        onDismount: () => {
            void compositionRoot.dispose();
        },
    };
});

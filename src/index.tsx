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

function isDownloadInFlight(snapshot: ModelCatalogSnapshot): boolean {
    return snapshot.download !== null && snapshot.download.percent !== 100;
}

class PluginCompositionRoot implements Disposable {
    private readonly resources: Disposable[] = [];
    private readonly lifecycle: PluginLifecycle;
    private readonly logger: Logger;
    private started = false;

    readonly settingsPort: SettingsPort;
    readonly controllerStore: StateStore<DictationState>;
    readonly setupProgress: SetupProgressStore;
    readonly diagnostics: DiagnosticsSource;
    readonly clock: ClockPort;
    readonly dictation: {
        readonly levelMeter: LevelMeterStore;
        readonly transcript: StateStore<PanelTranscriptSnapshot | null>;
        readonly onPress: () => void;
        readonly onCopy: (text: string) => Promise<boolean>;
    };
    readonly modelCatalog: {
        readonly store: StateStore<ModelCatalogSnapshot>;
        readonly load: () => Promise<void>;
        readonly download: (modelId: string) => void;
        readonly cancel: () => void;
        readonly deleteModel: (modelId: string) => Promise<void>;
    };
    readonly selfHeal: {
        readonly reportLoadOutcome: (outcome: SettingsLoadOutcome) => boolean;
        readonly onImportPlugin: (listener: () => void) => () => void;
    };

    constructor(logger: Logger = new Logger("plugin.lifecycle")) {
        this.logger = logger;

        const transport = createDeckyApiTransport();
        const backendClient = new DeckyBackendClient(transport);
        const speechPort = new DeckySpeechAdapter(backendClient);
        const settingsAdapter = new DeckySettingsAdapter(backendClient);
        this.settingsPort = settingsAdapter;
        this.setupProgress = speechPort.setupProgress;

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

        this.diagnostics = {
            hydrateSetupProgress: () => speechPort.hydrateSetupFromStatus(),
            restartRuntime: async () => {
                await backendClient.call("restart_runtime");
            },
        };

        this.dictation = {
            levelMeter: speechPort.levelMeter,
            transcript: speechPort.panelTranscript,
            onPress: () => {
                void controller.handlePanelMicrophonePressed();
            },
            onCopy: (text: string) => copyTextToClipboard(text),
        };

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

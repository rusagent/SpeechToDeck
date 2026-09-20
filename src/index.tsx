/**
 * Composition root (spec §6) and Decky plugin entry (§112).
 *
 * This module only creates dependencies and wires them — no application
 * logic. `PluginCompositionRoot` (§84) owns every disposable and disposes in
 * reverse construction order, executing the §83 unload sequence: controller
 * dispose (cancel recording) → keyboard stop (unmount mic UI, restore hooks)
 * → speech shutdown (unsubscribe backend events) → store unsubscription.
 */

import { definePlugin } from "@decky/api";
import * as React from "react";
import { DictationController } from "./application/DictationController";
import type { StateStore } from "./application/DictationController";
import { PluginLifecycle } from "./application/PluginLifecycle";
import { DeckyBackendClient } from "./infrastructure/decky/DeckyBackendClient";
import {
    createDeckyApiTransport,
    createDeckyTabExecutor,
} from "./infrastructure/decky/DeckyApiTransport";
import { DeckySelfHeal } from "./infrastructure/decky/DeckySelfHeal";
import type { SettingsLoadOutcome } from "./infrastructure/decky/DeckySelfHeal";
import { DeckySpeechAdapter } from "./infrastructure/decky/DeckySpeechAdapter";
import { DeckySettingsAdapter } from "./infrastructure/decky/DeckySettingsAdapter";
import type { SetupProgressStore } from "./application/ports/SetupProgressPort";
import type { LevelMeterStore } from "./application/ports/LevelMeterPort";
import type { ModelCatalogSnapshot } from "./application/ports/ModelCatalogPort";
import type { PanelTranscriptSnapshot } from "./application/ports/PanelTranscriptPort";
import { copyTextToClipboard } from "./infrastructure/system/PanelClipboard";
import { KeyboardBridgeInserter } from "./infrastructure/steam/KeyboardBridgeInserter";
import { SteamKeyboardTabBridgeHostAdapter } from "./infrastructure/steam/KeyboardTabBridgeHostAdapter";
import { SteamBulkPasteInserter } from "./infrastructure/steam/SteamBulkPasteInserter";
import { SteamClipboardAdapter } from "./infrastructure/steam/SteamClipboardAdapter";
import { TabBridgePasteActionAdapter } from "./infrastructure/steam/TabBridgePasteActionAdapter";
import { RandomIdGenerator } from "./infrastructure/system/RandomIdGenerator";
import { SystemClock } from "./infrastructure/system/SystemClock";
import { MicrophoneControlPresenter } from "./presentation/keyboard/MicrophoneButtonMount";
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
 * Install-wedge self-heal gate (v0.2.9): a download counts as in flight
 * until its settle path clears it — EXCEPT the held final 100% completion
 * frame (ADR-011), which is settled state the modal still renders, never a
 * live download.
 */
function isDownloadInFlight(snapshot: ModelCatalogSnapshot): boolean {
    return snapshot.download !== null && snapshot.download.percent !== 100;
}

class PluginCompositionRoot implements Disposable {
    private readonly resources: Disposable[] = [];
    private readonly lifecycle: PluginLifecycle;
    private readonly presenter: MicrophoneControlPresenter;
    private readonly logger: Logger;
    private started = false;

    /** Wired dependencies the plugin panel consumes (§6 wiring outputs). */
    readonly settingsPort: SettingsPort;
    readonly controllerStore: StateStore<DictationState>;
    readonly setupProgress: SetupProgressStore;
    readonly diagnostics: DiagnosticsSource;
    /** Monotonic clock: controller timings and the panel's load deadline. */
    readonly clock: ClockPort;
    /** Additive v0.2 dictation card wiring for the plugin panel. */
    readonly dictation: {
        readonly levelMeter: LevelMeterStore;
        readonly transcript: StateStore<PanelTranscriptSnapshot | null>;
        readonly onPress: () => void;
        readonly onCopy: (text: string) => Promise<boolean>;
    };
    /** Additive curated model catalog wiring for the plugin panel (ADR-011). */
    readonly modelCatalog: {
        readonly store: StateStore<ModelCatalogSnapshot>;
        readonly load: () => Promise<void>;
        readonly download: (modelId: string) => void;
        readonly cancel: () => void;
    };
    /** Install-wedge self-heal wiring for the plugin panel (v0.2.9). */
    readonly selfHeal: {
        readonly reportLoadOutcome: (outcome: SettingsLoadOutcome) => boolean;
        readonly onImportPlugin: (listener: () => void) => () => void;
    };

    constructor(logger: Logger = new Logger("plugin.lifecycle")) {
        this.logger = logger;

        // §6 wiring — construction order only, no service locator.
        const transport = createDeckyApiTransport();
        const backendClient = new DeckyBackendClient(transport);
        const speechPort = new DeckySpeechAdapter(backendClient);
        const settingsAdapter = new DeckySettingsAdapter(backendClient);
        this.settingsPort = settingsAdapter;
        this.setupProgress = speechPort.setupProgress;

        // v0.1.7: the mic button lives in the real keyboard document
        // ("Steam Big Picture Mode") via the loader's official executeInTab;
        // the v0.1.6 registry-mount adapter is a proven dead end
        // (managersFound=0 on device) and is no longer wired. The store is
        // resolved lazily: the controller below is assigned before any
        // keyboard event can arrive (bridge polls start with start()).
        let controller: DictationController | null = null;
        const keyboardHost = new SteamKeyboardTabBridgeHostAdapter({
            executor: createDeckyTabExecutor(),
            onPress: () => {
                void controller?.handleMicrophonePressed();
            },
            // §61 gate: the poll loop runs ONLY while the plugin is enabled
            // (the machine derives PLUGIN_DISABLED from the startup settings).
            isEnabled: () => {
                const state = controller?.getSnapshot();
                return !(state?.kind === "unavailable" && state.reason === "PLUGIN_DISABLED");
            },
        });
        const clipboard = new SteamClipboardAdapter();
        const pasteAction = new TabBridgePasteActionAdapter(keyboardHost.bridge);
        const fallbackInserter = new SteamBulkPasteInserter(clipboard, pasteAction, keyboardHost);
        const textInserter = new KeyboardBridgeInserter(keyboardHost.bridge, fallbackInserter);

        const clock = new SystemClock();
        this.clock = clock;
        controller = new DictationController(
            speechPort,
            keyboardHost,
            textInserter,
            settingsAdapter,
            clock,
            new RandomIdGenerator(),
        );
        this.controllerStore = controller;

        // v0.2.5: trimmed to the two methods the panel still consumes (the
        // Diagnostics section removal orphaned the capability/cross-view
        // loaders; the loader-side providers stay untouched).
        this.diagnostics = {
            hydrateSetupProgress: () => speechPort.hydrateSetupFromStatus(),
            restartRuntime: async () => {
                await backendClient.call("restart_runtime");
            },
        };

        // v0.2 dictation card (owner pivot): the big button presses the SAME
        // controller through the panel entry (§10 mutex, §8 machine); the
        // level/transcript stores are the adapter's guarded UI side-channels;
        // the copy is the panel execCommand path (primary while the backend
        // xclip leg reports "skipped").
        this.dictation = {
            levelMeter: speechPort.levelMeter,
            transcript: speechPort.panelTranscript,
            onPress: () => {
                void controller?.handlePanelMicrophonePressed();
            },
            onCopy: (text: string) => copyTextToClipboard(text),
        };

        // ADR-011 model catalog: the guarded store side-channel plus the
        // §30 download callables. Failures are logged with their detail and
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
        };

        // Install-wedge self-heal (v0.2.9): the panel reports boot-load
        // outcomes through the two-method port below. The gates are read
        // HERE, fresh at report time, over the composed stores — the reload
        // never fires during an active dictation session (any §8 sessionful
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

        this.presenter = new MicrophoneControlPresenter(controller, keyboardHost, () =>
            controller?.handleMicrophonePressed(),
        );
        this.lifecycle = new PluginLifecycle(controller, keyboardHost, speechPort);

        // §84: dispose in reverse construction order → lifecycle first (it
        // runs the §83 sequence incl. hook restore), presenter afterwards.
        this.resources.push(this.lifecycle, this.presenter);
    }

    async start(): Promise<void> {
        if (this.started) {
            return;
        }
        this.started = true;
        this.presenter.start();
        await this.lifecycle.start();
        this.logger.info("composition root started");
    }

    async dispose(): Promise<void> {
        for (const resource of [...this.resources].reverse()) {
            try {
                await resource.dispose();
            } catch (error) {
                // §84/§106: one failing teardown step must not block the rest.
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

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
import { createDeckyApiTransport } from "./infrastructure/decky/DeckyApiTransport";
import { DeckySpeechAdapter } from "./infrastructure/decky/DeckySpeechAdapter";
import { DeckySettingsAdapter } from "./infrastructure/decky/DeckySettingsAdapter";
import type { SetupProgressStore } from "./application/ports/SetupProgressPort";
import { SteamBulkPasteInserter } from "./infrastructure/steam/SteamBulkPasteInserter";
import { SteamCapabilityProbe } from "./infrastructure/steam/SteamCapabilityProbe";
import { SteamClipboardAdapter } from "./infrastructure/steam/SteamClipboardAdapter";
import { SteamKeyboardHostAdapter } from "./infrastructure/steam/SteamKeyboardHostAdapter";
import { SteamPasteActionAdapter } from "./infrastructure/steam/SteamPasteActionAdapter";
import { RandomIdGenerator } from "./infrastructure/system/RandomIdGenerator";
import { SystemClock } from "./infrastructure/system/SystemClock";
import {
    MicrophoneControlPresenter,
    createMicrophoneControlRenderer,
} from "./presentation/keyboard/MicrophoneButtonMount";
import { SettingsPanel } from "./presentation/settings/SettingsPanel";
import type { DiagnosticsSource } from "./presentation/settings/DiagnosticsPanel";
import type { Disposable } from "./shared/Disposable";
import { Logger } from "./shared/Logger";
import { isSpeechCapabilities } from "./application/ports/SpeechPort";
import type { SettingsPort } from "./application/ports/SettingsPort";
import type { DictationState } from "./domain/DictationState";

// Entry-module contract: the ONLY export is the callable default (the loader
// evaluates `m.default()`); the composition root is internal wiring.
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

    constructor(logger: Logger = new Logger("plugin.lifecycle")) {
        this.logger = logger;

        // §6 wiring — construction order only, no service locator.
        const backendClient = new DeckyBackendClient(createDeckyApiTransport());
        const speechPort = new DeckySpeechAdapter(backendClient);
        const settingsAdapter = new DeckySettingsAdapter(backendClient);
        this.settingsPort = settingsAdapter;
        this.setupProgress = speechPort.setupProgress;

        // The renderer resolves the store lazily: React mounts happen only
        // after startup, by which time the controller below is assigned. This
        // is plain local wiring, not a global dependency container (§6).
        let controller: DictationController | null = null;
        const keyboardHost = new SteamKeyboardHostAdapter({
            renderer: createMicrophoneControlRenderer(() => controller),
        });
        const clipboard = new SteamClipboardAdapter();
        const pasteAction = new SteamPasteActionAdapter(keyboardHost);
        const textInserter = new SteamBulkPasteInserter(clipboard, pasteAction, keyboardHost);
        const capabilityProbe = new SteamCapabilityProbe();

        controller = new DictationController(
            speechPort,
            keyboardHost,
            textInserter,
            settingsAdapter,
            new SystemClock(),
            new RandomIdGenerator(),
        );
        this.controllerStore = controller;

        this.diagnostics = {
            loadCapabilityReport: async () => capabilityProbe.probe(),
            loadSpeechCapabilities: async () => {
                const payload = await backendClient.call("get_capabilities");
                return isSpeechCapabilities(payload) ? payload : null;
            },
            restartRuntime: async () => {
                await backendClient.call("restart_runtime");
            },
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
            />
        ),
        onDismount: () => {
            void compositionRoot.dispose();
        },
    };
});

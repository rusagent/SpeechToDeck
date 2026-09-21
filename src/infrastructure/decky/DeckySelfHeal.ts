import type { DeckyTransport } from "./DeckyBackendClient";
import { Logger } from "../../shared/Logger";

export const LOADER_RELOAD_ROUTE = "loader/reload_plugin";

export const LOADER_IMPORT_EVENT = "loader/import_plugin";

export const SELF_HEAL_PLUGIN_NAME = "SpeechToDeck";

export type SettingsLoadOutcome = "timeout" | "rejected" | "success";

export interface SelfHealGates {
    readonly canReload: boolean;
}

let reloadTriggeredInSession = false;

let consecutiveLoadTimeouts = 0;

export function resetDeckySelfHealForTests(): void {
    reloadTriggeredInSession = false;
    consecutiveLoadTimeouts = 0;
}

export class DeckySelfHeal {
    private readonly importListeners = new Set<() => void>();
    private loaderListenerRegistered = false;

    constructor(
        private readonly transport: DeckyTransport,
        private readonly logger: Logger = new Logger("plugin.lifecycle"),
    ) {}

    reportLoadOutcome(outcome: SettingsLoadOutcome, gates: SelfHealGates): boolean {
        if (outcome !== "timeout") {
            consecutiveLoadTimeouts = 0;
            return false;
        }
        consecutiveLoadTimeouts += 1;
        if (consecutiveLoadTimeouts < 2 || reloadTriggeredInSession || !gates.canReload) {
            return false;
        }
        reloadTriggeredInSession = true;
        consecutiveLoadTimeouts = 0;
        this.logger.warn("settings load timed out twice; reloading the plugin backend", {
            route: LOADER_RELOAD_ROUTE,
            plugin: SELF_HEAL_PLUGIN_NAME,
        });
        void this.transport
            .call(LOADER_RELOAD_ROUTE, SELF_HEAL_PLUGIN_NAME)
            .catch((error: unknown) => {
                this.logger.error("loader reload call failed", {
                    detail: error instanceof Error ? error.message : String(error),
                });
            });
        return true;
    }

    onImportPlugin(listener: () => void): () => void {
        if (!this.loaderListenerRegistered) {
            this.loaderListenerRegistered = true;
            this.transport.addEventListener(LOADER_IMPORT_EVENT, () => {
                consecutiveLoadTimeouts = 0;
                for (const dispatch of [...this.importListeners]) {
                    dispatch();
                }
            });
        }
        this.importListeners.add(listener);
        return () => {
            this.importListeners.delete(listener);
        };
    }
}

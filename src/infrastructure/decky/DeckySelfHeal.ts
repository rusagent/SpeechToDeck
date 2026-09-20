/**
 * DeckySelfHeal — deterministic recovery for the loader install wedge.
 *
 * Loader v3.2.9 can orphan the frontend→backend call channel during a UI
 * reinstall; the visible symptom is a settings load that never settles (no
 * coded reply at all). The honest panel already leaves that eternal-spinner
 * state after 10 s (SettingsPanel); this adapter adds the self-heal leg:
 * after TWO consecutive full-deadline timeouts — never after a coded
 * rejection, which proves the callable path answers — it asks the loader to
 * reload the plugin backend via the generic loader route
 * `loader/reload_plugin` (route+args proven working from a raw WS client,
 * scripts/deploy-deck.mjs:139), and listens for the loader's
 * `loader/import_plugin` broadcast (emitted after every install/reload,
 * loader.py:190-191) so a panel stuck in the failed state re-arms its load.
 *
 * The reload fires AT MOST ONCE per frontend module session: the latch and
 * the timeout streak are module state, and the loader re-imports this
 * module after a reload, which resets them naturally — a reload that does
 * not help can therefore never loop. Loader-route/event access is bound to
 * the injected `DeckyTransport` (the real `@decky/api` binding stays in
 * `DeckyApiTransport`, imported only by the composition root), mirroring
 * the `DeckyBackendClient` seam so tests inject `FakeDeckyTransport`.
 *
 * LIVE_UNPROVEN seam: whether the loader answers a plugin-FE-originated
 * `call("loader/reload_plugin", …)` can only be proven on device; the call
 * is one seam here (single route constant, single transport call) so the
 * on-device verification touches nothing else.
 */

import type { DeckyTransport } from "./DeckyBackendClient";
import { Logger } from "../../shared/Logger";

/** Frozen loader callable: restarts the plugin's backend (loader route). */
export const LOADER_RELOAD_ROUTE = "loader/reload_plugin";

/** Frozen loader event: broadcast after every install/reload (re-import). */
export const LOADER_IMPORT_EVENT = "loader/import_plugin";

/** The plugin name the loader knows (plugin.json); the reload's only arg. */
export const SELF_HEAL_PLUGIN_NAME = "SpeechToDeck";

/** How one boot-load attempt settled, as reported by the panel. */
export type SettingsLoadOutcome = "timeout" | "rejected" | "success";

/**
 * Trigger gates, evaluated fresh at report time by the composition root:
 * the reload never fires while a dictation session is active (any §8
 * sessionful state) or a model download is in flight.
 */
export interface SelfHealGates {
    readonly canReload: boolean;
}

/**
 * Module-session latch: the reload fired already, so no further reload can
 * be triggered until the loader re-imports this module (fresh evaluation).
 * This latch — not a counter — is what guarantees "never loop".
 */
let reloadTriggeredInSession = false;

/** Consecutive full-deadline timeouts; any coded reply or success resets it. */
let consecutiveLoadTimeouts = 0;

/**
 * Test scaffolding: resets the latch and the streak between tests.
 * Production never calls this — the module state lives exactly as long as
 * the frontend module evaluation and is reset by the loader's re-import.
 */
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

    /**
     * Accounts one settled boot-load attempt. Returns `true` when THIS call
     * fired the loader reload (the panel then names the reload in its
     * failed-state hint). Two consecutive timeouts with clear gates are the
     * trigger; a rejection (real coded reply — the backend is alive and a
     * reload would not help) or a success resets the streak instead.
     */
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
        // Fire-and-forget: the loader answers the CALL itself; a rejection
        // (or a wedge that outlives it) leaves the panel's honest failed
        // state with Retry — never a faked success.
        void this.transport
            .call(LOADER_RELOAD_ROUTE, SELF_HEAL_PLUGIN_NAME)
            .catch((error: unknown) => {
                this.logger.error("loader reload call failed", {
                    detail: error instanceof Error ? error.message : String(error),
                });
            });
        return true;
    }

    /**
     * Subscribes one panel listener to the loader's re-import event and
     * returns the unsubscribe. The LOADER listener is registered once per
     * instance regardless of how many panels subscribe (idempotent — panel
     * mounts must not stack transport listeners); the event proves a fresh
     * backend, so it resets the timeout streak and fans out to the current
     * subscribers only.
     */
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

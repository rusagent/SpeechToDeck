/**
 * SteamWindowRegistry — enumeration of per-window virtual keyboard
 * managers from the SharedJSContext window-store registry.
 *
 * Live evidence (verified against a live device with a SharedJSContext
 * probe): `window.SteamUIStore.m_WindowStore`
 * holds maps (m_mapAppWindows, m_mapDesiredWindows, m_mapDesiredWindowInstances,
 * m_mapOverlayPopupByPID) whose window-instance objects expose
 * `m_VirtualKeyboardManager` + `m_BrowserWindow` — but the instances are
 * TRANSIENT: they appear while the keyboard is in use and vanish afterwards.
 * Enumeration is therefore cheap, repeatable and lazy (no busy loops —
 * the adapter drives re-enumeration from lifecycle hooks and a slow panel-
 * lifetime poll).
 *
 * Every accessor is shape-checked before use: nothing is
 * assumed from typings. The walk records which store keys and document
 * accessors resolved so an on-device journal read settles the still-open
 * document-accessor question in one cycle (no object values are logged).
 */

import { Logger } from "../../shared/Logger";
import type { SteamVirtualKeyboardManager } from "./SteamInternalTypes";

/** One usable per-window keyboard manager discovered in the registry. */
export interface SteamUiWindowEntry {
    /** Stable token (WindowName/name, else positional) for keyboard contexts. */
    readonly token: string;
    /** Capability-checked manager (both lifecycle methods callable). */
    readonly manager: SteamVirtualKeyboardManager;
    /**
     * The window document resolved through the bounded accessor chain, or
     * null when no candidate worked (the open on-device question).
     */
    readonly document: Document | null;
    /** Which chain candidate produced the document, for journal evidence. */
    readonly documentAccessor: string | null;
}

/** Shape-only snapshot of one enumeration pass (diagnostics: shapes, never values). */
export interface SteamRegistrySnapshot {
    /** True when any access chain reached a window store / registry. */
    readonly registryFound: boolean;
    /** Store keys walked, in order (shapes only, never values). */
    readonly storeKeysWalked: readonly string[];
    /** Window-instance objects inspected. */
    readonly instancesInspected: number;
    /** Instances that passed the manager capability check. */
    readonly managersFound: number;
    /** Instances whose document resolved through the accessor chain. */
    readonly documentsResolved: number;
    readonly entries: readonly SteamUiWindowEntry[];
}

function isObject(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function isDocument(value: unknown): value is Document {
    return typeof Document !== "undefined" && value instanceof Document;
}

/** Capability check: both lifecycle methods present and callable. */
function isUsableManager(candidate: unknown): candidate is SteamVirtualKeyboardManager {
    if (!isObject(candidate)) {
        return false;
    }
    return (
        typeof candidate["SetVirtualKeyboardVisible"] === "function" &&
        typeof candidate["SetVirtualKeyboardHidden"] === "function"
    );
}

/** Map/object/array-normalized values of one store container. */
function containerValues(container: unknown): unknown[] {
    if (container instanceof Map) {
        return [...container.values()];
    }
    if (Array.isArray(container)) {
        return [...container];
    }
    if (isObject(container)) {
        return Object.values(container);
    }
    return [];
}

export interface SteamWindowRegistryOptions {
    /** Host window; defaults to the plugin frontend's own window. */
    win?: Window;

    /** Logger for accessor evidence (shapes/counts only, never values). */
    logger?: Logger;

    /**
     * Overriding document resolver for tests; the production default is the
     * bounded accessor-candidate chain below.
     */
    resolveDocument?: (instance: Record<string, unknown>) => {
        document: Document | null;
        accessor: string | null;
    };
}

export class SteamWindowRegistry {
    private readonly win: Window;
    private readonly logger: Logger;
    private readonly resolveDocumentOverride:
        | ((instance: Record<string, unknown>) => {
              document: Document | null;
              accessor: string | null;
          })
        | null;

    constructor(options: SteamWindowRegistryOptions = {}) {
        this.win =
            options.win ??
            (globalThis as { window?: Window }).window ??
            (globalThis as unknown as Window);
        this.logger = options.logger ?? new Logger("steam.registry");
        this.resolveDocumentOverride = options.resolveDocument ?? null;
    }

    /**
     * One cheap enumeration pass. Never throws: every access chain and every
     * per-instance extraction is exception-contained, so a Steam
     * update that reshapes the store degrades to an empty snapshot.
     */
    enumerate(): SteamRegistrySnapshot {
        try {
            return this.enumerateUnsafe();
        } catch (error) {
            this.logger.error("registry enumeration failed", {
                detail: error instanceof Error ? error.message : String(error),
            });
            return {
                registryFound: false,
                storeKeysWalked: [],
                instancesInspected: 0,
                managersFound: 0,
                documentsResolved: 0,
                entries: [],
            };
        }
    }

    private enumerateUnsafe(): SteamRegistrySnapshot {
        const storeKeysWalked: string[] = [];
        const candidates: unknown[] = [];
        let registryFound = false;

        // Chain 1 (live-verified): SteamUIStore.m_WindowStore.<maps>.
        const store = (this.win as unknown as Record<string, unknown>)["SteamUIStore"];
        if (isObject(store)) {
            storeKeysWalked.push("SteamUIStore");
            const windowStore = store["m_WindowStore"];
            if (isObject(windowStore)) {
                registryFound = true;
                storeKeysWalked.push("SteamUIStore.m_WindowStore");
                for (const key of STORE_MAP_KEYS) {
                    const container = windowStore[key];
                    if (container === undefined || container === null) {
                        continue;
                    }
                    storeKeysWalked.push(`m_WindowStore.${key}`);
                    candidates.push(...containerValues(container));
                }
            }
            // Chain 3: the historically assumed SteamUIStore.Windows shape.
            if (store["Windows"] !== undefined && store["Windows"] !== null) {
                registryFound = true;
                storeKeysWalked.push("SteamUIStore.Windows");
                candidates.push(...containerValues(store["Windows"]));
            }
        }

        // Chain 2: a plain SteamUIWindows array global.
        const uiWindows = (this.win as unknown as Record<string, unknown>)["SteamUIWindows"];
        if (Array.isArray(uiWindows)) {
            registryFound = true;
            storeKeysWalked.push("SteamUIWindows");
            candidates.push(...uiWindows);
        }

        // Chain 4: the debug accessor observed on device (shape unprobed —
        // call defensively and walk one level of object/array values).
        const debugGet = (this.win as unknown as Record<string, unknown>)[
            "DEBUG_GetDesiredSteamUIWindows"
        ];
        if (typeof debugGet === "function") {
            try {
                const result = (debugGet as () => unknown)();
                if (result !== undefined && result !== null) {
                    registryFound = true;
                    storeKeysWalked.push("DEBUG_GetDesiredSteamUIWindows()");
                    candidates.push(...containerValues(result));
                }
            } catch (error) {
                this.logger.warn("debug window accessor threw", {
                    detail: error instanceof Error ? error.message : String(error),
                });
            }
        }

        let managersFound = 0;
        let documentsResolved = 0;
        const entries: SteamUiWindowEntry[] = [];
        let inspected = 0;
        for (const candidate of candidates) {
            inspected += 1;
            if (!isObject(candidate)) {
                continue;
            }
            let rawManager: unknown;
            try {
                rawManager =
                    candidate["m_VirtualKeyboardManager"] ?? candidate["VirtualKeyboardManager"];
            } catch (error) {
                // One hostile/reshaped instance must not kill the pass.
                this.logger.warn("window instance inspection failed", {
                    detail: error instanceof Error ? error.message : String(error),
                });
                continue;
            }
            if (!isUsableManager(rawManager)) {
                continue;
            }
            managersFound += 1;
            const resolved =
                this.resolveDocumentOverride !== null
                    ? this.resolveDocumentOverride(candidate)
                    : this.resolveDocumentViaChain(candidate);
            if (resolved.document !== null) {
                documentsResolved += 1;
            }
            entries.push({
                token: registryToken(candidate, entries.length),
                manager: rawManager,
                document: resolved.document,
                documentAccessor: resolved.accessor,
            });
        }

        this.logger.info("registry enumerated", {
            registryFound,
            storeKeys: storeKeysWalked.join("|"),
            instancesInspected: inspected,
            managersFound,
            documentsResolved,
        });
        return {
            registryFound,
            storeKeysWalked,
            instancesInspected: inspected,
            managersFound,
            documentsResolved,
            entries,
        };
    }

    /**
     * Bounded document-accessor candidate chain (the open on-device
     * question). Every attempt is contained; the winning accessor name is
     * reported so a journal read settles it without another probe cycle.
     */
    private resolveDocumentViaChain(instance: Record<string, unknown>): {
        document: Document | null;
        accessor: string | null;
    } {
        const attempts: { holderName: string; holder: unknown }[] = [
            { holderName: "m_BrowserWindow", holder: instance["m_BrowserWindow"] },
            { holderName: "BrowserWindow", holder: instance["BrowserWindow"] },
            { holderName: "m_StoreBrowser", holder: instance["m_StoreBrowser"] },
            { holderName: "StoreBrowser", holder: instance["StoreBrowser"] },
        ];
        for (const { holderName, holder } of attempts) {
            if (!isObject(holder)) {
                continue;
            }
            if (isDocument(holder["document"])) {
                return { document: holder["document"], accessor: `${holderName}.document` };
            }
            for (const method of ["GetDocument", "getDocument"]) {
                if (typeof holder[method] === "function") {
                    try {
                        const value = (holder[method] as () => unknown).call(holder);
                        if (isDocument(value)) {
                            return {
                                document: value,
                                accessor: `${holderName}.${method}()`,
                            };
                        }
                    } catch (error) {
                        this.logger.warn("document accessor threw", {
                            accessor: `${holderName}.${method}()`,
                            detail: error instanceof Error ? error.message : String(error),
                        });
                    }
                }
            }
        }
        if (isDocument(instance["document"])) {
            return { document: instance["document"], accessor: "instance.document" };
        }
        return { document: null, accessor: null };
    }
}

const STORE_MAP_KEYS = [
    "m_mapAppWindows",
    "m_mapDesiredWindows",
    "m_mapDesiredWindowInstances",
    "m_mapOverlayPopupByPID",
] as const;

function registryToken(instance: Record<string, unknown>, index: number): string {
    for (const key of ["WindowName", "windowName", "m_windowName", "name"]) {
        const value = instance[key];
        if (typeof value === "string" && value.length > 0) {
            return value;
        }
    }
    return `window-${index}`;
}

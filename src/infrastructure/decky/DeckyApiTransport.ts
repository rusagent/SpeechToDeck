/**
 * Real `@decky/api` transport binding.
 *
 * Importing `@decky/api` executes Decky Loader connection side effects at
 * module load, so this module is imported ONLY by the composition root
 * (src/index.tsx). Tests and application code depend on the `DeckyTransport`
 * interface instead and inject fakes.
 */

import { addEventListener, call as deckyCall, executeInTab, removeEventListener } from "@decky/api";
import type { DeckyTransport } from "./DeckyBackendClient";
import type { TabExecutor } from "../steam/KeyboardTabBridge";

export function createDeckyApiTransport(): DeckyTransport {
    return {
        call: (route, ...args) => deckyCall<unknown[], unknown>(route, ...args),
        addEventListener: (event, listener) => {
            addEventListener<[unknown]>(event, listener);
        },
        removeEventListener: (event, listener) => {
            removeEventListener(event, listener);
        },
    };
}

/**
 * Real `executeInTab` binding for the v0.1.7 tab bridge (same module-load
 * side-effect boundary as `createDeckyApiTransport`: imported ONLY by the
 * composition root; tests inject fakes over the `TabExecutor` seam).
 */
export function createDeckyTabExecutor(): TabExecutor {
    return (tab, runAsync, code) => executeInTab(tab, runAsync, code);
}

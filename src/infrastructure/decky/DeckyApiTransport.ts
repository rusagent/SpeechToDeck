/**
 * Real `@decky/api` transport binding.
 *
 * Importing `@decky/api` executes Decky Loader connection side effects at
 * module load, so this module is imported ONLY by the composition root
 * (src/index.tsx). Tests and application code depend on the `DeckyTransport`
 * interface instead and inject fakes.
 */

import { addEventListener, call as deckyCall, removeEventListener } from "@decky/api";
import type { DeckyTransport } from "./DeckyBackendClient";

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

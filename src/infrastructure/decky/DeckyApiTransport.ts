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

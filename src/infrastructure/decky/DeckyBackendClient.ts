/**
 * DeckyBackendClient (spec §30) — thin transport over the Decky backend.
 *
 * Callables travel through `DeckyTransport.call`; backend events are
 * subscribed once per listener and the first emitted argument is handed to
 * the listener as the unvalidated payload (§67). Payload validation with the
 * boundary type guards happens in the adapters, before anything is emitted
 * into the application (§99).
 *
 * The transport is injected: the real `@decky/api` binding lives in
 * `DeckyApiTransport` and is imported only by the composition root, because
 * importing `@decky/api` executes Decky Loader connection side effects.
 */

import type { Disposable } from "../../shared/Disposable";
import { Logger } from "../../shared/Logger";

export interface DeckyTransport {
    call(route: string, ...args: unknown[]): Promise<unknown>;

    addEventListener(event: string, listener: (...args: unknown[]) => void): void;

    removeEventListener(event: string, listener: (...args: unknown[]) => void): void;
}

export class DeckyBackendClient {
    constructor(
        private readonly transport: DeckyTransport,
        private readonly logger: Logger = new Logger("speech.runtime"),
    ) {}

    async call(route: string, ...args: unknown[]): Promise<unknown> {
        return this.transport.call(route, ...args);
    }

    /**
     * Subscribes to a backend event (§30 names are the frozen contract).
     * The listener receives the first payload argument; a throwing listener
     * is contained so it cannot break Decky's event dispatch (§106 analog).
     */
    subscribe(eventName: string, listener: (payload: unknown) => void): Disposable {
        const rawListener = (...args: unknown[]) => {
            try {
                listener(args[0]);
            } catch (error) {
                this.logger.error("backend event listener failed", {
                    event: eventName,
                    detail: error instanceof Error ? error.message : String(error),
                });
            }
        };
        this.transport.addEventListener(eventName, rawListener);
        return {
            dispose: () => {
                this.transport.removeEventListener(eventName, rawListener);
            },
        };
    }
}

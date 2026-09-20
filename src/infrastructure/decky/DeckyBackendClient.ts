/**
 * DeckyBackendClient — thin transport over the Decky backend.
 *
 * Callables travel through `DeckyTransport.call`; backend events are
 * subscribed once per listener and the first emitted argument is handed to
 * the listener as the unvalidated payload. Payload validation with the
 * boundary type guards happens in the adapters, before anything is emitted
 * into the application.
 *
 * The transport is injected: the real `@decky/api` binding lives in
 * `DeckyApiTransport` and is imported only by the composition root, because
 * importing `@decky/api` executes Decky Loader connection side effects.
 */

import { DictationError, isDictationErrorCode } from "../../domain/DictationError";
import type { Disposable } from "../../shared/Disposable";
import { Logger } from "../../shared/Logger";

export interface DeckyTransport {
    call(route: string, ...args: unknown[]): Promise<unknown>;

    addEventListener(event: string, listener: (...args: unknown[]) => void): void;

    removeEventListener(event: string, listener: (...args: unknown[]) => void): void;
}

/**
 * Unwraps the backend's coded-result envelope: the Python `Plugin`
 * facade returns `{"ok": true, ...payload}` on success and
 * `{"ok": false, "code": <stable code>, ...}` on failure. A coded failure is
 * thrown as a `DictationError` so callers observe stable codes instead
 * of a silently swallowed `ok: false`. Responses that are not coded results
 * (payloads handed over directly by a transport) pass through unchanged.
 */
function unwrapCodedResult(response: unknown, route: string): unknown {
    if (typeof response !== "object" || response === null) {
        return response;
    }
    const record = response as Record<string, unknown>;
    if (record["ok"] !== true && record["ok"] !== false) {
        return response;
    }
    if (record["ok"]) {
        const payload: Record<string, unknown> = { ...record };
        delete payload["ok"];
        return payload;
    }
    const detail = record["detail"];
    throw new DictationError(
        isDictationErrorCode(record["code"]) ? record["code"] : "INTERNAL_ERROR",
        typeof detail === "string" && detail.length > 0 ? detail : `backend call ${route} failed`,
    );
}

export class DeckyBackendClient {
    constructor(
        private readonly transport: DeckyTransport,
        private readonly logger: Logger = new Logger("speech.runtime"),
    ) {}

    async call(route: string, ...args: unknown[]): Promise<unknown> {
        return unwrapCodedResult(await this.transport.call(route, ...args), route);
    }

    /**
     * Subscribes to a backend event (event names are the frozen contract).
     * The listener receives the first payload argument; a throwing listener
     * is contained so it cannot break Decky's event dispatch.
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

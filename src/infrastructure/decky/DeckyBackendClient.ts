import { DictationError, isDictationErrorCode } from "../../domain/DictationError";
import type { Disposable } from "../../shared/Disposable";
import { Logger } from "../../shared/Logger";

export interface DeckyTransport {
    call(route: string, ...args: unknown[]): Promise<unknown>;

    addEventListener(event: string, listener: (...args: unknown[]) => void): void;

    removeEventListener(event: string, listener: (...args: unknown[]) => void): void;
}

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

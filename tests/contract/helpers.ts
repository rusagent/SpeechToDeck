/**
 * Shared contract-test doubles for the output ports and the Decky transport.
 * These live beside the contract tests; the core fakes under
 * tests/frontend/fakes/ are owned by the core lane and stay untouched.
 */

import { MAX_TRANSCRIPT_UTF8_BYTES } from "../../src/domain/DictationError";
import type { ClipboardCapability, PasteCapability } from "../../src/domain/Capability";
import type { KeyboardContext } from "../../src/domain/DictationSession";
import type { ClipboardPort } from "../../src/application/ports/ClipboardPort";
import type { PasteActionPort } from "../../src/application/ports/PasteActionPort";
import type { Disposable } from "../../src/shared/Disposable";
import type { DictationState } from "../../src/domain/DictationState";
import type { StateStore } from "../../src/application/DictationController";
import type { DeckyTransport } from "../../src/infrastructure/decky/DeckyBackendClient";

export class FakeClipboardPort implements ClipboardPort {
    readonly writtenTexts: string[] = [];
    readonly writeCalls: string[] = [];
    available = true;
    /** When set, invoked before the write resolves (e.g. closes the keyboard). */
    onWrite: (() => void) | null = null;
    writeError: Error | null = null;

    async probe(context: KeyboardContext): Promise<ClipboardCapability> {
        void context;
        return { available: this.available, maxTextBytes: MAX_TRANSCRIPT_UTF8_BYTES };
    }

    async writeText(context: KeyboardContext, text: string): Promise<void> {
        this.writeCalls.push(`write:${context.id}`);
        if (this.onWrite !== null) {
            this.onWrite();
        }
        if (this.writeError !== null) {
            throw this.writeError;
        }
        this.writtenTexts.push(text);
    }
}

export class FakePasteActionPort implements PasteActionPort {
    readonly invokeCalls: string[] = [];
    available = true;
    invokeError: Error | null = null;

    async probe(context: KeyboardContext): Promise<PasteCapability> {
        return { available: this.available && context.visible };
    }

    async invokePaste(context: KeyboardContext): Promise<void> {
        if (this.invokeError !== null) {
            throw this.invokeError;
        }
        this.invokeCalls.push(context.id);
    }
}

/** In-memory StateStore double over the application state union. */
export class FakeStateStore implements StateStore<DictationState> {
    private listeners = new Set<() => void>();

    constructor(private state: DictationState) {}

    getSnapshot(): DictationState {
        return this.state;
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    set(state: DictationState): void {
        this.state = state;
        for (const listener of [...this.listeners]) {
            listener();
        }
    }
}

interface DeckySubscription {
    readonly listeners: Set<(...args: unknown[]) => void>;
}

/** Decky transport double: records callable routes and dispatches events. */
export class FakeDeckyTransport implements DeckyTransport {
    readonly calls: { route: string; args: unknown[] }[] = [];
    readonly callResponses = new Map<string, unknown>();
    readonly callErrors = new Map<string, Error>();
    readonly removedListeners: { event: string; listener: (...args: unknown[]) => void }[] = [];

    private readonly subscriptions = new Map<string, DeckySubscription>();

    async call(route: string, ...args: unknown[]): Promise<unknown> {
        this.calls.push({ route, args });
        const error = this.callErrors.get(route);
        if (error !== undefined) {
            throw error;
        }
        if (this.callResponses.has(route)) {
            return this.callResponses.get(route);
        }
        return undefined;
    }

    addEventListener(event: string, listener: (...args: unknown[]) => void): void {
        let subscription = this.subscriptions.get(event);
        if (subscription === undefined) {
            subscription = { listeners: new Set() };
            this.subscriptions.set(event, subscription);
        }
        subscription.listeners.add(listener);
    }

    removeEventListener(event: string, listener: (...args: unknown[]) => void): void {
        this.subscriptions.get(event)?.listeners.delete(listener);
        this.removedListeners.push({ event, listener });
    }

    /** Simulates the Python backend emitting an event with one payload. */
    emit(event: string, payload?: unknown): void {
        for (const listener of [...(this.subscriptions.get(event)?.listeners ?? [])]) {
            listener(payload);
        }
    }

    listenerCount(event: string): number {
        return this.subscriptions.get(event)?.listeners.size ?? 0;
    }
}

/** Adapter-free renderer double for host-adapter contract tests. */
export function fakeRenderer(): {
    rendered: { host: HTMLElement; props: unknown }[];
    renderer: import("../../src/application/ports/KeyboardHostPort").MicrophoneControlRenderer;
} {
    const rendered: { host: HTMLElement; props: unknown }[] = [];
    return {
        rendered,
        renderer: {
            render: (host, props) => {
                rendered.push({ host, props });
                return {
                    dispose: () => undefined,
                } satisfies Disposable;
            },
        },
    };
}

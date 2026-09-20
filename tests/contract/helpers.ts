/**
 * Shared contract-test doubles for the Decky transport and the panel stores.
 * These live beside the contract tests; the shared fakes under
 * tests/frontend/fakes/ are separate and stay untouched.
 */

import type { DictationState } from "../../src/domain/DictationState";
import type { StateStore } from "../../src/application/DictationController";
import type { SetupProgressSnapshot } from "../../src/application/ports/SetupProgressPort";
import type { DeckyTransport } from "../../src/infrastructure/decky/DeckyBackendClient";

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

/** Generic in-memory snapshot store double (e.g. the setup-progress store). */
export class FakeSnapshotStore<T> {
    private listeners = new Set<() => void>();

    constructor(private snapshot: T | null) {}

    getSnapshot(): T | null {
        return this.snapshot;
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    set(snapshot: T | null): void {
        this.snapshot = snapshot;
        for (const listener of [...this.listeners]) {
            listener();
        }
    }
}

interface DeckySubscription {
    readonly listeners: Set<(...args: unknown[]) => void>;
}

/**
 * Valid `setup_progress` payloads for the panel, adapter and harness tests.
 * Determinate download sits at 37% of step 1 (overall = 25 + 37/4 = 34);
 * the failed payload fails the daemon step with a mapped error code.
 */
export const SETUP_SNAPSHOTS = {
    download: {
        protocolVersion: 1,
        step: "model.ensure",
        labelKey: "setup.step.modelEnsure",
        stepIndex: 1,
        totalSteps: 4,
        percent: 37,
        indeterminate: false,
        detailKey: "setup.detail.downloading",
    },
    indeterminate: {
        protocolVersion: 1,
        step: "daemon.start",
        labelKey: "setup.step.daemonStart",
        stepIndex: 2,
        totalSteps: 4,
        percent: 0,
        indeterminate: true,
        detailKey: "setup.detail.spawning",
    },
    failed: {
        protocolVersion: 1,
        step: "failed",
        labelKey: "setup.state.failed",
        stepIndex: 2,
        totalSteps: 4,
        percent: 0,
        indeterminate: false,
        error: { code: "MODEL_DOWNLOAD_FAILED" },
    },
    ready: {
        protocolVersion: 1,
        step: "ready",
        labelKey: "setup.state.ready",
        stepIndex: 4,
        totalSteps: 4,
        percent: 100,
        indeterminate: false,
    },
} as const satisfies Record<string, SetupProgressSnapshot>;

/**
 * Real-shaped `get_status` failure report: the backend recorded a
 * failed startup (MODEL_DOWNLOAD_FAILED at the model.ensure step), the
 * daemon is down, the plugin is enabled and no download is in flight. Drives
 * the setup-panel failure hydration in the adapter, panel and harness tests.
 */
export const FAILED_GET_STATUS_REPORT = {
    protocolVersion: 1,
    runtime: {
        running: false,
        state: "stopped",
        restartAttempts: 0,
        enabled: true,
        lastFailure: { code: "MODEL_DOWNLOAD_FAILED", stepIndex: 1 },
    },
    speech: { protocolVersion: 1, state: "ready", activeSessionId: null, counters: {} },
    modelDownloadInProgress: false,
} as const;

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

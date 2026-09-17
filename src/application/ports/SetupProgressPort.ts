/**
 * Versioned backend `setup_progress` payload (frozen contract) with its
 * manual boundary type guard (§99) and the small dedicated snapshot store
 * the plugin panel consumes.
 *
 * Setup progress is transport-level UI state: it never enters the dictation
 * state machine (§8) and is only observed by the settings panel through
 * `useSyncExternalStore` (§102). Invalid payloads are dropped by the adapter
 * (count-logged), never rendered.
 */

/** The frozen setup steps plus the two terminal markers. */
export type SetupStep =
    "runtime.verify" | "model.ensure" | "daemon.start" | "model.warmup" | "ready" | "failed";

/** i18n keys for the current step (exactly the §108 message keys). */
export type SetupLabelKey =
    | "setup.step.runtimeVerify"
    | "setup.step.modelEnsure"
    | "setup.step.daemonStart"
    | "setup.step.modelWarmup"
    | "setup.state.ready"
    | "setup.state.failed";

/** Optional i18n keys describing what the current step is doing. */
export type SetupDetailKey =
    | "setup.detail.checksum"
    | "setup.detail.downloading"
    | "setup.detail.verifying"
    | "setup.detail.spawning"
    | "setup.detail.warmup";

/**
 * Latest setup-progress report. `ready` is terminal success (the panel
 * hides), `failed` is terminal failure (the panel offers retry).
 */
export interface SetupProgressSnapshot {
    readonly protocolVersion: 1;
    readonly step: SetupStep;
    readonly labelKey: SetupLabelKey;
    readonly stepIndex: number;
    readonly totalSteps: number;
    /** 0–100 progress of the current step; 0 while indeterminate. */
    readonly percent: number;
    readonly indeterminate: boolean;
    readonly detailKey?: SetupDetailKey;
    readonly error?: { readonly code: string };
}

const SETUP_STEPS: readonly SetupStep[] = [
    "runtime.verify",
    "model.ensure",
    "daemon.start",
    "model.warmup",
    "ready",
    "failed",
];

const SETUP_LABEL_KEYS: readonly SetupLabelKey[] = [
    "setup.step.runtimeVerify",
    "setup.step.modelEnsure",
    "setup.step.daemonStart",
    "setup.step.modelWarmup",
    "setup.state.ready",
    "setup.state.failed",
];

const SETUP_DETAIL_KEYS: readonly SetupDetailKey[] = [
    "setup.detail.checksum",
    "setup.detail.downloading",
    "setup.detail.verifying",
    "setup.detail.spawning",
    "setup.detail.warmup",
];

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function isPercent(value: unknown): value is number {
    return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100;
}

/** Manual type guard for payloads crossing the backend boundary (§99). */
export function isSetupProgressSnapshot(value: unknown): value is SetupProgressSnapshot {
    if (!isRecord(value)) {
        return false;
    }
    if (value["protocolVersion"] !== 1) {
        return false;
    }
    if (!SETUP_STEPS.includes(value["step"] as SetupStep)) {
        return false;
    }
    if (!SETUP_LABEL_KEYS.includes(value["labelKey"] as SetupLabelKey)) {
        return false;
    }
    const stepIndex = value["stepIndex"];
    const totalSteps = value["totalSteps"];
    if (
        typeof stepIndex !== "number" ||
        !Number.isInteger(stepIndex) ||
        stepIndex < 0 ||
        typeof totalSteps !== "number" ||
        !Number.isInteger(totalSteps) ||
        totalSteps <= 0 ||
        stepIndex > totalSteps
    ) {
        return false;
    }
    if (!isPercent(value["percent"]) || typeof value["indeterminate"] !== "boolean") {
        return false;
    }
    const detailKey = value["detailKey"];
    if (detailKey !== undefined && !SETUP_DETAIL_KEYS.includes(detailKey as SetupDetailKey)) {
        return false;
    }
    const error = value["error"];
    if (error !== undefined) {
        if (!isRecord(error) || typeof error["code"] !== "string" || error["code"].length === 0) {
            return false;
        }
    }
    return true;
}

/**
 * Minimal external store for the latest setup snapshot (§102 shape:
 * `getSnapshot`/`subscribe` pair consumed by `useSyncExternalStore`).
 * Structurally compatible with `StateStore<T>`; the latest valid payload
 * wins, listeners are notified on every publish.
 */
export class SetupProgressStore {
    private readonly listeners = new Set<() => void>();
    private snapshot: SetupProgressSnapshot | null = null;

    getSnapshot(): SetupProgressSnapshot | null {
        return this.snapshot;
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    /** Publishes an already guarded payload (the adapter owns validation). */
    publish(snapshot: SetupProgressSnapshot): void {
        this.snapshot = snapshot;
        for (const listener of [...this.listeners]) {
            listener();
        }
    }
}

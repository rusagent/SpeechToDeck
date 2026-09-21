export type SetupStep =
    "runtime.verify" | "model.ensure" | "daemon.start" | "model.warmup" | "ready" | "failed";

export type SetupLabelKey =
    | "setup.step.runtimeVerify"
    | "setup.step.modelEnsure"
    | "setup.step.daemonStart"
    | "setup.step.modelWarmup"
    | "setup.state.ready"
    | "setup.state.failed";

export type SetupDetailKey =
    | "setup.detail.checksum"
    | "setup.detail.downloading"
    | "setup.detail.verifying"
    | "setup.detail.spawning"
    | "setup.detail.warmup";

export interface SetupProgressSnapshot {
    readonly protocolVersion: 1;
    readonly step: SetupStep;
    readonly labelKey: SetupLabelKey;
    readonly stepIndex: number;
    readonly totalSteps: number;
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

    publish(snapshot: SetupProgressSnapshot): void {
        this.snapshot = snapshot;
        for (const listener of [...this.listeners]) {
            listener();
        }
    }
}

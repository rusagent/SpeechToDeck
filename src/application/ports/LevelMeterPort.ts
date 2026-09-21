export const LEVEL_BAR_COUNT = 24;

export interface RecordingLevelPayload {
    readonly protocolVersion: 1;
    readonly kind: "recording_level";
    readonly seq: number;
    readonly frames: readonly (readonly [number, number, number])[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

function isFrameTriple(value: unknown): value is readonly [number, number, number] {
    return (
        Array.isArray(value) &&
        value.length === 3 &&
        value.every((item) => typeof item === "number" && Number.isFinite(item))
    );
}

export function isRecordingLevelPayload(value: unknown): value is RecordingLevelPayload {
    if (!isRecord(value)) {
        return false;
    }
    return (
        value["protocolVersion"] === 1 &&
        value["kind"] === "recording_level" &&
        typeof value["seq"] === "number" &&
        Number.isInteger(value["seq"]) &&
        value["seq"] >= 0 &&
        Array.isArray(value["frames"]) &&
        (value["frames"] as unknown[]).every(isFrameTriple)
    );
}

export interface LevelMeterSnapshot {
    readonly bars: readonly number[];
    readonly frameCount: number;
    readonly lastSeq: number | null;
}

const EMPTY_BARS: readonly number[] = Object.freeze(
    Array.from({ length: LEVEL_BAR_COUNT }, () => 0),
);

const IDLE_SNAPSHOT: LevelMeterSnapshot = {
    bars: EMPTY_BARS,
    frameCount: 0,
    lastSeq: null,
};

const FLOOR_DBFS = -60;

function clamp01(value: number): number {
    return Math.min(1, Math.max(0, value));
}

function frameLevel(peakDbfs: number): number {
    return clamp01((peakDbfs - FLOOR_DBFS) / (0 - FLOOR_DBFS));
}

export class LevelMeterStore {
    private readonly listeners = new Set<() => void>();
    private snapshot: LevelMeterSnapshot = IDLE_SNAPSHOT;

    getSnapshot(): LevelMeterSnapshot {
        return this.snapshot;
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    publish(payload: RecordingLevelPayload): void {
        if (payload.frames.length === 0) {
            return;
        }
        const nextBars = [...this.snapshot.bars];
        for (const [, , peakDbfs] of payload.frames) {
            nextBars.push(frameLevel(peakDbfs));
        }
        this.snapshot = {
            bars: Object.freeze(nextBars.slice(-LEVEL_BAR_COUNT)),
            frameCount: this.snapshot.frameCount + payload.frames.length,
            lastSeq: payload.seq,
        };
        for (const listener of [...this.listeners]) {
            listener();
        }
    }

    reset(): void {
        this.snapshot = IDLE_SNAPSHOT;
        for (const listener of [...this.listeners]) {
            listener();
        }
    }
}

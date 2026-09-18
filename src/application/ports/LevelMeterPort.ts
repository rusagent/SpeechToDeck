/**
 * Versioned backend `recording_level` payload (additive v0.2 event) with its
 * manual boundary type guard (§99) and the small dedicated level store the
 * plugin panel's dictation card consumes.
 *
 * The payload carries the coalesced amplitude envelope of the RUNNING
 * recording — `frames` are `[min, max, peakDbfs]` triples (min/max sample
 * extrema in -1..1, peak in dBFS) received from the daemon's audio.sock
 * broadcast, exactly as the backend parsed them. This is a live LEVEL meter,
 * not an FFT: the strip renders ONLY real received frames, never synthetic
 * content.
 *
 * Like setup progress this is transport-level UI state: it never enters the
 * dictation state machine (§8 — a 15 Hz event stream must not touch the
 * session flow) and is observed only by the dictation card through
 * `useSyncExternalStore` (§102). Invalid payloads are dropped by the adapter
 * (count-logged), never rendered.
 */

/** Fixed bar count of the panel level strip (24 frames ≈ 240 ms window). */
export const LEVEL_BAR_COUNT = 24;

export interface RecordingLevelPayload {
    readonly protocolVersion: 1;
    readonly kind: "recording_level";
    /** Monotonic frame counter (u32, wraps) of the last frame in the batch. */
    readonly seq: number;
    /** `[min, max, peakDbfs]` triples in stream order. */
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

/** Manual type guard for payloads crossing the backend boundary (§99). */
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

/** Immutable render snapshot of the level strip (§102: stable identity). */
export interface LevelMeterSnapshot {
    /** Bar heights 0..1, oldest first, exactly `LEVEL_BAR_COUNT` long. */
    readonly bars: readonly number[];
    /** Total frames received since the last reset (diagnostics). */
    readonly frameCount: number;
    /** seq of the last received frame; null before the first event. */
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

/**
 * Rolling 24-bar window over the received frames (§102 store shape:
 * `getSnapshot`/`subscribe`). Each frame contributes one bar whose height is
 * the window's amplitude `max(|min|, |max|)` clamped to 0..1; the snapshot
 * identity changes only when frames actually arrived, so a quiet stream
 * causes no render churn.
 */
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

    /** Ingests an already guarded payload (the adapter owns validation). */
    publish(payload: RecordingLevelPayload): void {
        if (payload.frames.length === 0) {
            return;
        }
        const nextBars = [...this.snapshot.bars];
        for (const [minimum, maximum] of payload.frames) {
            const amplitude = Math.min(
                1,
                Math.max(0, Math.max(Math.abs(minimum), Math.abs(maximum))),
            );
            nextBars.push(amplitude);
        }
        // Keep the LAST window: the newest frame is the rightmost bar.
        this.snapshot = {
            bars: Object.freeze(nextBars.slice(-LEVEL_BAR_COUNT)),
            frameCount: this.snapshot.frameCount + payload.frames.length,
            lastSeq: payload.seq,
        };
        for (const listener of [...this.listeners]) {
            listener();
        }
    }

    /** Fresh window for a new recording session (called on recording start). */
    reset(): void {
        this.snapshot = IDLE_SNAPSHOT;
        for (const listener of [...this.listeners]) {
            listener();
        }
    }
}

/**
 * Versioned backend `recording_level` payload (additive event) with its
 * manual boundary type guard and the small dedicated level store the
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
 * dictation state machine (a 15 Hz event stream must not touch the session
 * flow) and is observed only by the dictation card through
 * `useSyncExternalStore`. Invalid payloads are dropped by the adapter
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

/** Manual type guard for payloads crossing the backend boundary. */
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

/** Immutable render snapshot of the level strip (stable identity for React). */
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
 * Quiet end of the level meter in dBFS: frames at or below this level render
 * as an empty bar. Loud speech peaks near 0 dBFS, typical speech sits around
 * -30 dBFS — a LINEAR extremum mapping throws that perceptual range away
 * (0.02..0.3 sample amplitude ≈ the visualizer's floor colors), so the bar
 * height is derived from `peakDbfs` instead.
 */
const FLOOR_DBFS = -60;

function clamp01(value: number): number {
    return Math.min(1, Math.max(0, value));
}

/** One frame's perceived level: peakDbfs normalized over [FLOOR_DBFS, 0]. */
function frameLevel(peakDbfs: number): number {
    return clamp01((peakDbfs - FLOOR_DBFS) / (0 - FLOOR_DBFS));
}

/**
 * Rolling 24-bar window over the received frames (external-store shape:
 * `getSnapshot`/`subscribe`). Each frame contributes one bar whose height is
 * the frame's `peakDbfs` normalized over the -60..0 dBFS range (clamped to
 * 0..1) — NOT the min/max sample extrema, which rendered typical speech
 * nearly invisible; the snapshot identity changes only when frames actually
 * arrived, so a quiet stream causes no render churn.
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
        for (const [, , peakDbfs] of payload.frames) {
            nextBars.push(frameLevel(peakDbfs));
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

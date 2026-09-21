import { describe, expect, it } from "vitest";

import {
    LEVEL_BAR_COUNT,
    LevelMeterStore,
    isRecordingLevelPayload,
} from "../../src/application/ports/LevelMeterPort";

const FRAME = (min: number, max: number, peak = -6.0): [number, number, number] => [min, max, peak];

describe("isRecordingLevelPayload", () => {
    it("accepts a valid versioned recording_level payload", () => {
        expect(
            isRecordingLevelPayload({
                protocolVersion: 1,
                kind: "recording_level",
                seq: 7,
                frames: [FRAME(-0.5, 0.5)],
            }),
        ).toBe(true);
    });

    it("rejects wrong kind, version, seq or frames", () => {
        expect(
            isRecordingLevelPayload({
                protocolVersion: 1,
                kind: "something_else",
                seq: 7,
                frames: [],
            }),
        ).toBe(false);
        expect(
            isRecordingLevelPayload({
                protocolVersion: 2,
                kind: "recording_level",
                seq: 7,
                frames: [],
            }),
        ).toBe(false);
        expect(
            isRecordingLevelPayload({
                protocolVersion: 1,
                kind: "recording_level",
                seq: 1.5,
                frames: [],
            }),
        ).toBe(false);
        expect(
            isRecordingLevelPayload({
                protocolVersion: 1,
                kind: "recording_level",
                seq: 7,
                frames: [[0, "loud", -6]],
            }),
        ).toBe(false);
        expect(isRecordingLevelPayload(null)).toBe(false);
    });
});

describe("LevelMeterStore", () => {
    it("starts idle with an all-zero 24-bar window", () => {
        const store = new LevelMeterStore();
        const snapshot = store.getSnapshot();
        expect(snapshot.bars).toHaveLength(LEVEL_BAR_COUNT);
        expect(snapshot.bars.every((bar) => bar === 0)).toBe(true);
        expect(snapshot.frameCount).toBe(0);
        expect(snapshot.lastSeq).toBeNull();
    });

    it("normalizes each frame's peakDbfs over the -60..0 dBFS range", () => {
        const store = new LevelMeterStore();
        store.publish({
            protocolVersion: 1,
            kind: "recording_level",
            seq: 1,
            frames: [
                FRAME(0, 0, -6),
                FRAME(0, 0, -30),
                FRAME(0, 0, -60),
                FRAME(0, 0, 3),
                FRAME(0, 0, -120),
            ],
        });
        const bars = store.getSnapshot().bars;
        expect(bars[19]).toBeCloseTo(0.9, 5);
        expect(bars[20]).toBeCloseTo(0.5, 5);
        expect(bars[21]).toBe(0);
        expect(bars[22]).toBe(1);
        expect(bars[23]).toBe(0);
    });

    it("derives magnitude from peakDbfs only — min/max extrema no longer drive it", () => {
        const store = new LevelMeterStore();
        store.publish({
            protocolVersion: 1,
            kind: "recording_level",
            seq: 2,
            frames: [FRAME(-1.0, 1.0, -30), FRAME(-0.01, 0.01, -6)],
        });
        const bars = store.getSnapshot().bars;
        expect(bars[22]).toBeCloseTo(0.5, 5);
        expect(bars[23]).toBeCloseTo(0.9, 5);
    });

    it("maps received frames to dB-derived levels in stream order (oldest → leftmost)", () => {
        const store = new LevelMeterStore();
        store.publish({
            protocolVersion: 1,
            kind: "recording_level",
            seq: 5,
            frames: [FRAME(0, 0, -30), FRAME(0, 0, -6)],
        });
        const snapshot = store.getSnapshot();
        expect(snapshot.frameCount).toBe(2);
        expect(snapshot.lastSeq).toBe(5);
        expect(snapshot.bars[22]).toBeCloseTo(0.5, 5);
        expect(snapshot.bars[23]).toBeCloseTo(0.9, 5);
    });

    it("keeps a rolling window: the last 24 frames win", () => {
        const store = new LevelMeterStore();
        store.publish({
            protocolVersion: 1,
            kind: "recording_level",
            seq: 29,
            frames: Array.from({ length: 30 }, (_, i) => FRAME(0, 0, -(60 - i))),
        });
        const snapshot = store.getSnapshot();
        expect(snapshot.frameCount).toBe(30);
        expect(snapshot.bars[0]).toBeCloseTo(6 / 60, 5);
        expect(snapshot.bars[23]).toBeCloseTo(29 / 60, 5);
    });

    it("clamps out-of-range dBFS into 0..1 (defensive, not fabricating)", () => {
        const store = new LevelMeterStore();
        store.publish({
            protocolVersion: 1,
            kind: "recording_level",
            seq: 1,
            frames: [FRAME(-2, 2, 6)],
        });
        expect(store.getSnapshot().bars[23]).toBe(1);
    });

    it("ignores empty frame batches without notifying", () => {
        const store = new LevelMeterStore();
        let notifications = 0;
        store.subscribe(() => {
            notifications += 1;
        });
        store.publish({
            protocolVersion: 1,
            kind: "recording_level",
            seq: 2,
            frames: [],
        });
        expect(notifications).toBe(0);
        expect(store.getSnapshot().lastSeq).toBeNull();
    });

    it("reset returns to the idle window for a fresh recording session", () => {
        const store = new LevelMeterStore();
        store.publish({
            protocolVersion: 1,
            kind: "recording_level",
            seq: 9,
            frames: [FRAME(-0.5, 0.5)],
        });
        store.reset();
        const snapshot = store.getSnapshot();
        expect(snapshot.bars.every((bar) => bar === 0)).toBe(true);
        expect(snapshot.frameCount).toBe(0);
        expect(snapshot.lastSeq).toBeNull();
    });

    it("notifies subscribers on publish and reset, with stable unsubscribe", () => {
        const store = new LevelMeterStore();
        let notifications = 0;
        const unsubscribe = store.subscribe(() => {
            notifications += 1;
        });
        store.publish({
            protocolVersion: 1,
            kind: "recording_level",
            seq: 1,
            frames: [FRAME(-0.1, 0.1)],
        });
        store.reset();
        unsubscribe();
        store.publish({
            protocolVersion: 1,
            kind: "recording_level",
            seq: 2,
            frames: [FRAME(-0.1, 0.1)],
        });
        expect(notifications).toBe(2);
    });
});

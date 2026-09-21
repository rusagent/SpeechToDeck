import { act, cleanup, fireEvent, render } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { LevelMeterStore } from "../../src/application/ports/LevelMeterPort";
import {
    LEVEL_STYLE_STORAGE_KEY,
    LevelVisualizer,
    heatColor,
    loadLevelStyle,
} from "../../src/presentation/settings/LevelVisualizer";

afterEach(() => {
    cleanup();
    window.localStorage.clear();
});

function framePayload(seq: number, peakDbfs: number) {
    const amplitude = 10 ** (peakDbfs / 20);
    return {
        protocolVersion: 1 as const,
        kind: "recording_level" as const,
        seq,
        frames: [[-amplitude, amplitude, peakDbfs] as const],
    };
}

function VisualizerHarness({ store }: { store: LevelMeterStore }): React.ReactElement {
    const snapshot = React.useSyncExternalStore(
        (onChange) => store.subscribe(onChange),
        () => store.getSnapshot(),
    );
    return <LevelVisualizer bars={snapshot.bars} locale="en" />;
}

async function renderVisualizer(store: LevelMeterStore) {
    const view = render(<VisualizerHarness store={store} />);
    await act(async () => undefined);
    return view;
}

function levelBars(): HTMLElement[] {
    return [...document.querySelectorAll("[data-level-bar]")] as HTMLElement[];
}

function levelValue(index: number): string {
    const bar = document.querySelector(`[data-level-bar="${index}"]`);
    expect(bar).not.toBeNull();
    const attribute = bar?.getAttribute("data-level-value");
    expect(attribute).not.toBeNull();
    return attribute as string;
}

function stripStyleAttribute(): string | null {
    return (
        document.querySelector("[data-level-strip]")?.getAttribute("data-visualizer-style") ?? null
    );
}

function channelValues(color: string): number[] {
    return (color.match(/\d+/g) ?? []).map(Number);
}

describe("LevelVisualizer", () => {
    it("defaults to heatmap and renders ONLY real frames behind the pinned contract", async () => {
        const store = new LevelMeterStore();
        await renderVisualizer(store);

        const strip = document.querySelector("[data-level-strip]");
        expect(strip).not.toBeNull();
        expect(strip?.getAttribute("data-visualizer-style")).toBe("heatmap");
        expect(strip?.getAttribute("role")).toBe("img");
        expect(strip?.getAttribute("aria-label")).toBe("Live microphone level");
        expect(levelBars()).toHaveLength(24);
        expect(levelValue(23)).toBe("0.00");

        await act(async () => {
            store.publish(framePayload(1, -30));
            store.publish(framePayload(2, -6));
        });
        expect(levelValue(23)).toBe("0.90");
        expect(levelValue(22)).toBe("0.50");
        expect(levelValue(0)).toBe("0.00");

        const loud = levelBars()[23] as HTMLElement;
        expect(loud.style.background).toContain("linear-gradient");
        expect(loud.style.boxShadow).not.toBe("none");
        const quiet = levelBars()[0] as HTMLElement;
        expect(quiet.style.boxShadow).toBe("none");
    });

    it("classic keeps the previous strip's exact bar semantics", async () => {
        window.localStorage.setItem(LEVEL_STYLE_STORAGE_KEY, "classic");
        const store = new LevelMeterStore();
        await renderVisualizer(store);
        expect(stripStyleAttribute()).toBe("classic");

        await act(async () => {
            store.publish(framePayload(1, -30));
            store.publish(framePayload(2, -6));
            store.publish(framePayload(3, -59));
        });
        const columns = levelBars();
        expect(columns).toHaveLength(24);
        expect(levelValue(23)).toBe("0.02");
        expect(levelValue(22)).toBe("0.90");
        expect(levelValue(21)).toBe("0.50");
        const loud = columns[22] as HTMLElement;
        expect(loud.className).toContain("speechtodeck-level-bar");
        expect(loud.style.height).toBe("90%");
        expect(loud.style.background).toContain("255, 92, 92");
        const mid = columns[21] as HTMLElement;
        expect(mid.style.height).toBe("50%");
        expect(mid.style.background).toContain("255, 255, 255");
        const quiet = columns[23] as HTMLElement;
        expect(quiet.style.height).toBe("4%");
    });

    it("mirror folds each amplitude around the center line", async () => {
        window.localStorage.setItem(LEVEL_STYLE_STORAGE_KEY, "mirror");
        const store = new LevelMeterStore();
        await renderVisualizer(store);
        expect(stripStyleAttribute()).toBe("mirror");

        await act(async () => {
            store.publish(framePayload(1, -6));
        });
        const columns = levelBars();
        expect(columns).toHaveLength(24);
        expect(levelValue(23)).toBe("0.90");
        const loud = columns[23];
        expect(loud).not.toBeNull();
        const halves = Array.from(loud?.children ?? []) as HTMLElement[];
        expect(halves).toHaveLength(2);
        expect(halves[0]?.style.height).toBe("45%");
        expect(halves[1]?.style.height).toBe("45%");
    });

    it("the combobox switches styles and persists the choice (readback oracle)", async () => {
        const store = new LevelMeterStore();
        await renderVisualizer(store);
        const picker = document.querySelector(
            "[data-level-style-picker]",
        ) as HTMLSelectElement | null;
        expect(picker).not.toBeNull();

        await act(async () => {
            fireEvent.change(picker as HTMLSelectElement, { target: { value: "classic" } });
        });
        expect(window.localStorage.getItem(LEVEL_STYLE_STORAGE_KEY)).toBe("classic");
        expect(stripStyleAttribute()).toBe("classic");

        await act(async () => {
            fireEvent.change(picker as HTMLSelectElement, { target: { value: "mirror" } });
        });
        expect(window.localStorage.getItem(LEVEL_STYLE_STORAGE_KEY)).toBe("mirror");
        expect(stripStyleAttribute()).toBe("mirror");
    });

    it("falls back to heatmap on garbage or missing stored values and without storage", async () => {
        window.localStorage.setItem(LEVEL_STYLE_STORAGE_KEY, "neon-rain");
        expect(loadLevelStyle(window.localStorage)).toBe("heatmap");
        const store = new LevelMeterStore();
        await renderVisualizer(store);
        expect(stripStyleAttribute()).toBe("heatmap");

        window.localStorage.clear();
        expect(loadLevelStyle(window.localStorage)).toBe("heatmap");

        expect(loadLevelStyle(null)).toBe("heatmap");
    });

    it("maps amplitude onto the acceptance's magma ramp (dark floor → near-white core)", () => {
        const brightness = (color: string): number =>
            channelValues(color).reduce((sum, channel) => sum + channel, 0);

        const [floorRed = 0, , floorBlue = 0] = channelValues(heatColor(0));
        expect(brightness(heatColor(0))).toBeLessThan(90);
        expect(floorBlue).toBeGreaterThan(floorRed);

        const [midRed = 0, , midBlue = 0] = channelValues(heatColor(0.6));
        expect(midRed).toBeGreaterThan(midBlue);

        const [hotRed = 0, hotGreen = 0, hotBlue = 0] = channelValues(heatColor(1));
        for (const channel of [hotRed, hotGreen, hotBlue]) {
            expect(channel).toBeGreaterThan(150);
        }
        expect(hotRed).toBeGreaterThanOrEqual(hotGreen);
        expect(hotGreen).toBeGreaterThan(hotBlue);

        const temperatures = [0, 0.2, 0.4, 0.6, 0.8, 1].map((value) =>
            brightness(heatColor(value)),
        );
        let previous = temperatures[0] ?? 0;
        for (const temperature of temperatures.slice(1)) {
            expect(temperature).toBeGreaterThan(previous);
            previous = temperature;
        }
    });
});

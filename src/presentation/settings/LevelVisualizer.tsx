import * as React from "react";
import { LEVEL_BAR_COUNT } from "../../application/ports/LevelMeterPort";
import { translate } from "../i18n/messages";
import type { Locale, MessageKey } from "../i18n/messages";

export type VisualizerStyle = "heatmap" | "classic" | "mirror";

export const LEVEL_STYLE_STORAGE_KEY = "speechtodeck.levelStyle";

const DEFAULT_STYLE: VisualizerStyle = "heatmap";

const STYLE_VALUES: readonly VisualizerStyle[] = ["heatmap", "classic", "mirror"];

const STYLE_LABEL_KEYS: Record<VisualizerStyle, MessageKey> = {
    heatmap: "dictation.level.style.heatmap",
    classic: "dictation.level.style.classic",
    mirror: "dictation.level.style.mirror",
};

function isVisualizerStyle(value: unknown): value is VisualizerStyle {
    return typeof value === "string" && (STYLE_VALUES as readonly string[]).includes(value);
}

export function loadLevelStyle(storage: Pick<Storage, "getItem"> | null): VisualizerStyle {
    if (storage === null) {
        return DEFAULT_STYLE;
    }
    try {
        const raw = storage.getItem(LEVEL_STYLE_STORAGE_KEY);
        return isVisualizerStyle(raw) ? raw : DEFAULT_STYLE;
    } catch {
        return DEFAULT_STYLE;
    }
}

function safeStorage(): Storage | null {
    try {
        return typeof window === "undefined" ? null : window.localStorage;
    } catch {
        return null;
    }
}

function clamp01(value: number): number {
    return Math.min(1, Math.max(0, value));
}

type RgbChannels = readonly [number, number, number];

const MAGMA_STOPS: readonly (readonly [number, RgbChannels])[] = [
    [0.0, [16, 8, 44]],
    [0.25, [86, 24, 118]],
    [0.5, [186, 34, 106]],
    [0.7, [232, 74, 46]],
    [0.85, [250, 160, 56]],
    [1.0, [255, 243, 186]],
];

function heatChannels(amplitude: number): RgbChannels {
    const value = clamp01(amplitude);
    for (let index = 1; index < MAGMA_STOPS.length; index += 1) {
        const upper = MAGMA_STOPS[index];
        const lower = MAGMA_STOPS[index - 1];
        if (upper === undefined || lower === undefined || value > upper[0]) {
            continue;
        }
        const [lowerValue, lowerColor] = lower;
        const [upperValue, upperColor] = upper;
        const t = upperValue === lowerValue ? 0 : (value - lowerValue) / (upperValue - lowerValue);
        return [
            Math.round(lowerColor[0] + (upperColor[0] - lowerColor[0]) * t),
            Math.round(lowerColor[1] + (upperColor[1] - lowerColor[1]) * t),
            Math.round(lowerColor[2] + (upperColor[2] - lowerColor[2]) * t),
        ];
    }
    return [255, 243, 186];
}

export function heatColor(amplitude: number): string {
    const [red, green, blue] = heatChannels(amplitude);
    return `rgb(${red}, ${green}, ${blue})`;
}

function heatAlpha(amplitude: number, alpha: number): string {
    const [red, green, blue] = heatChannels(amplitude);
    return `rgba(${red}, ${green}, ${blue}, ${alpha.toFixed(2)})`;
}

function heatColumn(amplitude: number): { background: string; boxShadow: string } {
    const value = clamp01(amplitude);
    const hot = heatColor(value);
    const cap = heatColor(Math.min(1, value + 0.25));
    const rise = Math.round(value * 100);
    const background =
        `linear-gradient(to top, ${hot} 0%, ${hot} ${rise}%, ` +
        `${cap} ${Math.min(100, rise + 6)}%, ${heatColor(0.06)} ${Math.min(100, rise + 20)}%)`;
    const boxShadow =
        value <= 0.02
            ? "none"
            : `0 0 ${Math.round(2 + 7 * value)}px 0 ${heatAlpha(value, 0.2 + 0.45 * value)}`;
    return { background, boxShadow };
}

function barColor(amplitude: number): string {
    return amplitude > 0.75 ? "rgba(255, 92, 92, 0.9)" : "rgba(255, 255, 255, 0.55)";
}

export const DARK_PANEL_SURFACE: React.CSSProperties = {
    background: "rgba(25, 28, 34, 0.85)",
    border: "1px solid rgba(255, 255, 255, 0.25)",
    borderRadius: 6,
};

const STRIP_BASE_STYLE: React.CSSProperties = {
    ...DARK_PANEL_SURFACE,
    display: "flex",
    height: 44,
    padding: "3px 6px",
    marginTop: 8,
    position: "relative",
};

const SCANLINE_OVERLAY_STYLE: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
    backgroundImage:
        "repeating-linear-gradient(to bottom, rgba(255, 255, 255, 0.14) 0px, " +
        "rgba(255, 255, 255, 0.14) 1px, transparent 1px, transparent 9px)",
};

const CENTER_LINE_STYLE: React.CSSProperties = {
    position: "absolute",
    left: 6,
    right: 6,
    top: "50%",
    height: 1,
    marginTop: -0.5,
    background: "rgba(255, 255, 255, 0.25)",
    pointerEvents: "none",
};

const VISUALIZER_MOTION_STYLES = `
.speechtodeck-level-bar { transition: height 90ms linear; }
.speechtodeck-heat-col { transition: background 90ms linear, box-shadow 90ms linear; }
@media (prefers-reduced-motion: reduce) {
    .speechtodeck-level-bar, .speechtodeck-heat-col { transition: none; }
}
`;

let visualizerStylesInjected = false;

function injectVisualizerStyles(): void {
    if (visualizerStylesInjected || typeof document === "undefined") {
        return;
    }
    const element = document.createElement("style");
    element.textContent = VISUALIZER_MOTION_STYLES;
    document.head.append(element);
    visualizerStylesInjected = true;
}

function HeatmapStrip({
    bars,
    label,
}: {
    bars: readonly number[];
    label: string;
}): React.ReactElement {
    return (
        <div
            role="img"
            aria-label={label}
            data-level-strip="true"
            data-visualizer-style="heatmap"
            style={{ ...STRIP_BASE_STYLE, alignItems: "stretch", gap: 1 }}
        >
            {Array.from({ length: LEVEL_BAR_COUNT }, (_, index) => {
                const column = heatColumn(bars[index] ?? 0);
                return (
                    <div
                        key={index}
                        aria-hidden="true"
                        className="speechtodeck-heat-col"
                        data-level-bar={index}
                        data-level-value={(bars[index] ?? 0).toFixed(2)}
                        style={{
                            flex: 1,
                            minWidth: 2,
                            borderRadius: 2,
                            background: column.background,
                            boxShadow: column.boxShadow,
                        }}
                    />
                );
            })}
            <div aria-hidden="true" style={SCANLINE_OVERLAY_STYLE} />
        </div>
    );
}

function ClassicStrip({
    bars,
    label,
}: {
    bars: readonly number[];
    label: string;
}): React.ReactElement {
    return (
        <div
            role="img"
            aria-label={label}
            data-level-strip="true"
            data-visualizer-style="classic"
            style={{ ...STRIP_BASE_STYLE, alignItems: "flex-end", gap: 2 }}
        >
            {Array.from({ length: LEVEL_BAR_COUNT }, (_, index) => {
                const bar = bars[index] ?? 0;
                return (
                    <div
                        key={index}
                        aria-hidden="true"
                        className="speechtodeck-level-bar"
                        data-level-bar={index}
                        data-level-value={bar.toFixed(2)}
                        style={{
                            flex: 1,
                            minWidth: 2,
                            height: `${Math.max(4, Math.round(bar * 100))}%`,
                            background: barColor(bar),
                            borderRadius: 2,
                        }}
                    />
                );
            })}
        </div>
    );
}

function MirrorStrip({
    bars,
    label,
}: {
    bars: readonly number[];
    label: string;
}): React.ReactElement {
    return (
        <div
            role="img"
            aria-label={label}
            data-level-strip="true"
            data-visualizer-style="mirror"
            style={{ ...STRIP_BASE_STYLE, alignItems: "stretch", gap: 2 }}
        >
            {Array.from({ length: LEVEL_BAR_COUNT }, (_, index) => {
                const bar = bars[index] ?? 0;
                const half = `${Math.max(2, Math.round(bar * 50))}%`;
                return (
                    <div
                        key={index}
                        data-level-bar={index}
                        data-level-value={bar.toFixed(2)}
                        style={{
                            flex: 1,
                            minWidth: 2,
                            display: "flex",
                            flexDirection: "column",
                            justifyContent: "center",
                        }}
                    >
                        <div
                            aria-hidden="true"
                            className="speechtodeck-level-bar"
                            style={{
                                height: half,
                                background: barColor(bar),
                                borderRadius: "2px 2px 0 0",
                            }}
                        />
                        <div
                            aria-hidden="true"
                            className="speechtodeck-level-bar"
                            style={{
                                height: half,
                                background: barColor(bar),
                                borderRadius: "0 0 2px 2px",
                            }}
                        />
                    </div>
                );
            })}
            <div aria-hidden="true" style={CENTER_LINE_STYLE} />
        </div>
    );
}

const STRIPS: Record<
    VisualizerStyle,
    (props: { bars: readonly number[]; label: string }) => React.ReactElement
> = {
    heatmap: HeatmapStrip,
    classic: ClassicStrip,
    mirror: MirrorStrip,
};

const STYLE_PICKER_ROW_STYLE: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    marginTop: 6,
    fontSize: 11,
};

const STYLE_PICKER_SELECT_STYLE: React.CSSProperties = {
    ...DARK_PANEL_SURFACE,
    flex: 1,
    minWidth: 0,
    padding: "3px 6px",
    color: "#ffffff",
    fontSize: 11,
};

export interface LevelVisualizerProps {
    readonly bars: readonly number[];
    readonly showStrip?: boolean;
    readonly locale?: Locale;
}

export function LevelVisualizer({
    bars,
    showStrip = true,
    locale = "en",
}: LevelVisualizerProps): React.ReactElement {
    injectVisualizerStyles();
    const [style, setStyle] = React.useState<VisualizerStyle>(() => loadLevelStyle(safeStorage()));

    const selectStyle = (raw: string): void => {
        if (!isVisualizerStyle(raw)) {
            return;
        }
        setStyle(raw);
        const storage = safeStorage();
        if (storage !== null) {
            try {
                storage.setItem(LEVEL_STYLE_STORAGE_KEY, raw);
            } catch {}
        }
    };

    const Strip = STRIPS[style];
    return (
        <div data-level-visualizer="true">
            {showStrip ? (
                <Strip bars={bars} label={translate(locale, "dictation.level.label")} />
            ) : null}
            <div style={STYLE_PICKER_ROW_STYLE}>
                <label
                    htmlFor="speechtodeck-level-style"
                    style={{ opacity: 0.7, whiteSpace: "nowrap" }}
                >
                    {translate(locale, "dictation.level.style")}
                </label>
                <select
                    id="speechtodeck-level-style"
                    data-level-style-picker="true"
                    value={style}
                    onChange={(event) => selectStyle(event.target.value)}
                    style={STYLE_PICKER_SELECT_STYLE}
                >
                    {STYLE_VALUES.map((value) => (
                        <option key={value} value={value}>
                            {translate(locale, STYLE_LABEL_KEYS[value])}
                        </option>
                    ))}
                </select>
            </div>
        </div>
    );
}

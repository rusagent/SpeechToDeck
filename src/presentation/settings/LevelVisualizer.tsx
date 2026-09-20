/**
 * LevelVisualizer — the dictation card's live level
 * strip with three user-selectable styles over the SAME real-frame window:
 *
 * - `heatmap` (default): a scrolling time-column heat map in a
 *   magma/fire palette (deep purple floor →
 *   magenta → red-orange → amber → near-white yellow core) where each column
 *   is one real frame, the newest stays on the right, and amplitude maps to
 *   color temperature with a soft glow on hot columns. Faint horizontal
 *   scanlines echo the reference image.
 * - `classic`: the extracted 24-bar strip, pixel-identical.
 * - `mirror`: the same bars folded vertically around a center line.
 *
 * Privacy/no fabrication: every style renders ONLY the real received
 * `recording_level` amplitudes passed in `bars` (the adapter-guarded
 * LevelMeterStore window) — a level visualization, never synthetic content.
 * Bars re-render on publishes, never on a timer; the height/color
 * transitions run only while events arrive and are disabled under
 * `prefers-reduced-motion`. All strings via i18n.
 *
 * The style choice is frontend-local by design (a pure presentation
 * preference, NOT a backend setting): it persists in `localStorage` under the
 * `speechtodeck.` prefix; unknown or unavailable stored values fail closed to
 * the `heatmap` default.
 */

import * as React from "react";
import { LEVEL_BAR_COUNT } from "../../application/ports/LevelMeterPort";
import { translate } from "../i18n/messages";
import type { Locale, MessageKey } from "../i18n/messages";

/** The selectable visualizer styles (stable storage values). */
export type VisualizerStyle = "heatmap" | "classic" | "mirror";

/** Frontend-local storage key (a presentation preference, not a backend setting). */
export const LEVEL_STYLE_STORAGE_KEY = "speechtodeck.levelStyle";

/** Default when nothing (or garbage) is stored: the headline style. */
const DEFAULT_STYLE: VisualizerStyle = "heatmap";

const STYLE_VALUES: readonly VisualizerStyle[] = ["heatmap", "classic", "mirror"];

const STYLE_LABEL_KEYS: Record<VisualizerStyle, MessageKey> = {
    heatmap: "dictation.level.style.heatmap",
    classic: "dictation.level.style.classic",
    mirror: "dictation.level.style.mirror",
};

/** Manual guard for the value read back across the localStorage boundary. */
function isVisualizerStyle(value: unknown): value is VisualizerStyle {
    return typeof value === "string" && (STYLE_VALUES as readonly string[]).includes(value);
}

/**
 * Reads the persisted style, failing closed to the default on garbage,
 * missing keys, or unavailable storage. The storage parameter is injectable
 * for tests; production passes the (guarded) global localStorage.
 */
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

/** localStorage can throw on access in embedded webviews; never fatal. */
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

/**
 * Magma-style color ramp matching the `heatmap` style: deep
 * purple-black floor → violet → magenta → red-orange → amber → near-white
 * yellow core. Piecewise-linear in RGB; `amplitude` is clamped to 0..1.
 */
const MAGMA_STOPS: readonly (readonly [number, RgbChannels])[] = [
    [0.0, [16, 8, 44]], // deep purple-black (the spectrogram floor)
    [0.25, [86, 24, 118]], // violet
    [0.5, [186, 34, 106]], // magenta
    [0.7, [232, 74, 46]], // red-orange
    [0.85, [250, 160, 56]], // amber
    [1.0, [255, 243, 186]], // near-white yellow (the hottest cores)
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
    // Unreachable in practice: the clamped value is ≤ the final stop's 1.0.
    return [255, 243, 186];
}

/** Amplitude → magma temperature as an `rgb()` color string. */
export function heatColor(amplitude: number): string {
    const [red, green, blue] = heatChannels(amplitude);
    return `rgb(${red}, ${green}, ${blue})`;
}

function heatAlpha(amplitude: number, alpha: number): string {
    const [red, green, blue] = heatChannels(amplitude);
    return `rgba(${red}, ${green}, ${blue}, ${alpha.toFixed(2)})`;
}

/**
 * One heat-map time column: a bottom-up gradient whose hot region rises with
 * the amplitude (a brighter cap at the leading edge, like the reference's
 * hot cores), plus a soft glow scaled by the amplitude. Silent frames stay
 * on the dark floor with no glow.
 */
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

/** The classic strip's bar color (hot tip past 75%, otherwise neutral). */
function barColor(amplitude: number): string {
    return amplitude > 0.75 ? "rgba(255, 92, 92, 0.9)" : "rgba(255, 255, 255, 0.55)";
}

/**
 * The dictation card's shared dark-panel surface fragment: ONE palette
 * source for the strip frame, the style picker, the transcript preview and
 * the copy controls, so every inset panel of the card reads as the same
 * surface (visually identical to the previous per-element literals).
 */
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

/** Faint horizontal scanlines echoing the reference spectrogram's grid. */
const SCANLINE_OVERLAY_STYLE: React.CSSProperties = {
    position: "absolute",
    inset: 0,
    pointerEvents: "none",
    backgroundImage:
        "repeating-linear-gradient(to bottom, rgba(255, 255, 255, 0.14) 0px, " +
        "rgba(255, 255, 255, 0.14) 1px, transparent 1px, transparent 9px)",
};

/** Mirror style's center line. */
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

/** Motion styles, injected once; off under `prefers-reduced-motion`. */
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

/** The compact picker row beneath the button/strip area (always visible). */
const STYLE_PICKER_ROW_STYLE: React.CSSProperties = {
    display: "flex",
    alignItems: "center",
    gap: 6,
    marginTop: 6,
    fontSize: 11,
};

/** The style select: the shared dark-panel surface in a compact control. */
const STYLE_PICKER_SELECT_STYLE: React.CSSProperties = {
    ...DARK_PANEL_SURFACE,
    flex: 1,
    minWidth: 0,
    padding: "3px 6px",
    color: "#ffffff",
    fontSize: 11,
};

export interface LevelVisualizerProps {
    /** Real amplitudes 0..1 from the guarded LevelMeterStore window. */
    readonly bars: readonly number[];
    /**
     * Whether the live strip renders. The card shows the strip only while
     * `recording`; the style picker row stays visible in every state so the
     * style can be chosen before a recording starts.
     */
    readonly showStrip?: boolean;
    readonly locale?: Locale;
}

/**
 * The dictation card's level visualizer: the strip in the selected style
 * (rendered only when `showStrip`, default true) plus the compact style
 * picker, which is always visible. The choice persists frontend-local; it
 * never touches the backend settings schema.
 */
export function LevelVisualizer({
    bars,
    showStrip = true,
    locale = "en",
}: LevelVisualizerProps): React.ReactElement {
    injectVisualizerStyles();
    const [style, setStyle] = React.useState<VisualizerStyle>(() => loadLevelStyle(safeStorage()));

    const selectStyle = (raw: string): void => {
        if (!isVisualizerStyle(raw)) {
            return; // fail closed: unknown values never leave the default
        }
        setStyle(raw);
        const storage = safeStorage();
        if (storage !== null) {
            try {
                storage.setItem(LEVEL_STYLE_STORAGE_KEY, raw);
            } catch {
                // Persistence is best-effort (quota/security errors): the
                // in-memory choice still applies for this session.
            }
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

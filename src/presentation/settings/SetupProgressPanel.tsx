/**
 * SetupProgressPanel — animated multi-step setup progress for the plugin
 * panel.
 *
 * Renders the backend's `setup_progress` stream (frozen contract, guarded in
 * the adapter): four step rows with per-step state and percent, an animated
 * overall bar, a description line and — on the terminal `failed` step — the
 * mapped §68 error plus a retry control wired to the existing
 * `restart_runtime` callable path. Terminal `ready` never reaches this
 * component: the settings panel hides it as soon as the snapshot is ready.
 *
 * Motion (§20/§66): the bar width moves via CSS `transform: scaleX(...)`
 * with a transition; shimmer and the indeterminate slide are CSS keyframes.
 * There are no JS animation loops and no idle timers; every animation is
 * switched off under `prefers-reduced-motion`. Steps never rely on color
 * alone — each state has a distinct glyph (§107).
 */

import * as React from "react";
import { ButtonItem } from "@decky/ui";
import type { SetupProgressSnapshot } from "../../application/ports/SetupProgressPort";
import { isDictationErrorCode } from "../../domain/DictationError";
import { translate, translateError } from "../i18n/messages";
import type { Locale } from "../i18n/messages";
import { CodeChip } from "./DiagnosticsPanel";

export interface SetupProgressPanelProps {
    readonly snapshot: SetupProgressSnapshot;
    readonly locale: Locale;
    /** Invoked by the failed-state retry button (the restart_runtime path). */
    readonly onRetry: () => Promise<void>;
}

/** Display order of the four setup steps with their i18n label keys. */
const STEP_ROWS: readonly { readonly labelKey: SetupProgressSnapshot["labelKey"] }[] = [
    { labelKey: "setup.step.runtimeVerify" },
    { labelKey: "setup.step.modelEnsure" },
    { labelKey: "setup.step.daemonStart" },
    { labelKey: "setup.step.modelWarmup" },
];

const ACCENT = "#1a9fff";
const ERROR_COLOR = "#ff5c5c";
const DONE_COLOR = "#5ac189";

type StepState = "pending" | "active" | "done" | "error";

function stepState(snapshot: SetupProgressSnapshot, index: number): StepState {
    if (snapshot.step === "failed") {
        const failing = Math.min(snapshot.stepIndex, STEP_ROWS.length - 1);
        return index < failing ? "done" : index === failing ? "error" : "pending";
    }
    if (snapshot.step === "ready") {
        return "done";
    }
    return index < snapshot.stepIndex
        ? "done"
        : index === snapshot.stepIndex
          ? "active"
          : "pending";
}

/**
 * Overall picture, render-only arithmetic (never sent anywhere):
 * completed steps count 25 each, the running step contributes percent/4.
 */
function overallPercent(snapshot: SetupProgressSnapshot): number {
    if (snapshot.step === "ready") {
        return 100;
    }
    const completed = Math.min(snapshot.stepIndex, STEP_ROWS.length);
    const value = Math.round(completed * 25 + snapshot.percent / 4);
    return Math.max(0, Math.min(100, value));
}

function setupErrorMessage(locale: Locale, snapshot: SetupProgressSnapshot): string | null {
    if (snapshot.error === undefined) {
        return null;
    }
    return isDictationErrorCode(snapshot.error.code)
        ? translateError(locale, snapshot.error.code)
        : translate(locale, "setup.errorUnknown");
}

/**
 * Motion styles, injected once (same idiom as the microphone button).
 * Every animation is active-state feedback and switches off under
 * `prefers-reduced-motion`.
 */
const SETUP_MOTION_STYLES = `
@keyframes speechtodeck-setup-spin {
    to { transform: rotate(360deg); }
}
@keyframes speechtodeck-setup-slide {
    0% { transform: translateX(-105%) scaleX(0.3); }
    100% { transform: translateX(360%) scaleX(0.3); }
}
@keyframes speechtodeck-setup-shimmer {
    0% { transform: translateX(-160%); }
    100% { transform: translateX(280%); }
}
.speechtodeck-setup-spinner { animation: speechtodeck-setup-spin 1.1s linear infinite; }
.speechtodeck-setup-fill-indeterminate { animation: speechtodeck-setup-slide 1.4s ease-in-out infinite; }
.speechtodeck-setup-shimmer { animation: speechtodeck-setup-shimmer 1.2s linear infinite; }
@media (prefers-reduced-motion: reduce) {
    .speechtodeck-setup-spinner { animation: none; }
    .speechtodeck-setup-fill-indeterminate { animation: none; }
    .speechtodeck-setup-shimmer { animation: none; opacity: 0; }
}
`;

let setupStylesInjected = false;

function injectSetupStyles(): void {
    if (setupStylesInjected || typeof document === "undefined") {
        return;
    }
    const element = document.createElement("style");
    element.textContent = SETUP_MOTION_STYLES;
    document.head.append(element);
    setupStylesInjected = true;
}

function StepIcon({ state }: { state: StepState }): React.ReactElement {
    if (state === "active") {
        return (
            <svg
                className="speechtodeck-setup-spinner"
                width="12"
                height="12"
                viewBox="0 0 24 24"
                fill="none"
                aria-hidden="true"
                focusable="false"
                style={{ flex: "none" }}
            >
                <circle cx="12" cy="12" r="9" stroke="rgba(255, 255, 255, 0.18)" strokeWidth="3" />
                <path
                    d="M21 12a9 9 0 0 0-9-9"
                    stroke="rgba(255, 255, 255, 0.9)"
                    strokeWidth="3"
                    strokeLinecap="round"
                />
            </svg>
        );
    }
    const glyph = state === "done" ? "✓" : state === "error" ? "!" : "○";
    const color =
        state === "done"
            ? DONE_COLOR
            : state === "error"
              ? ERROR_COLOR
              : "rgba(255, 255, 255, 0.35)";
    return (
        <span
            aria-hidden="true"
            data-step-marker={state}
            style={{
                flex: "none",
                width: 12,
                textAlign: "center",
                fontSize: 11,
                fontWeight: 700,
                lineHeight: "12px",
                color,
            }}
        >
            {glyph}
        </span>
    );
}

export function SetupProgressPanel({
    snapshot,
    locale,
    onRetry,
}: SetupProgressPanelProps): React.ReactElement {
    injectSetupStyles();
    const [restarting, setRestarting] = React.useState(false);

    const failed = snapshot.step === "failed";
    const running = !failed && snapshot.step !== "ready";
    const determinate = !snapshot.indeterminate;
    const overall = overallPercent(snapshot);
    const title = translate(locale, failed ? "setup.errorPrefix" : "setup.title");
    const detail = snapshot.detailKey === undefined ? null : translate(locale, snapshot.detailKey);
    const errorMessage = setupErrorMessage(locale, snapshot);

    const retry = (): void => {
        setRestarting(true);
        void onRetry()
            .catch(() => undefined)
            .finally(() => {
                setRestarting(false);
            });
    };

    return (
        <div data-setup-progress={snapshot.step} style={{ padding: "2px 0 6px" }}>
            {/* Overall picture: title plus the render-only overall percent. */}
            <div
                style={{
                    display: "flex",
                    alignItems: "baseline",
                    justifyContent: "space-between",
                    gap: 12,
                    marginBottom: 6,
                }}
            >
                <span
                    style={{
                        fontSize: 13.5,
                        fontWeight: 600,
                        color: failed ? ERROR_COLOR : "#eef0f2",
                    }}
                >
                    {title}
                </span>
                {determinate ? (
                    <span
                        aria-hidden="true"
                        style={{
                            fontSize: 12,
                            fontVariantNumeric: "tabular-nums",
                            color: "rgba(255, 255, 255, 0.55)",
                        }}
                    >
                        {overall}%
                    </span>
                ) : null}
            </div>

            {/* Overall bar: transform-only width, transition between steps. */}
            <div
                role="progressbar"
                aria-label={title}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={determinate ? overall : undefined}
                data-indeterminate={snapshot.indeterminate ? "true" : "false"}
                style={{
                    position: "relative",
                    height: 4,
                    borderRadius: 2,
                    background: "rgba(255, 255, 255, 0.16)",
                    overflow: "hidden",
                }}
            >
                <div
                    className={
                        snapshot.indeterminate ? "speechtodeck-setup-fill-indeterminate" : ""
                    }
                    style={{
                        position: "absolute",
                        inset: 0,
                        background: failed ? ERROR_COLOR : ACCENT,
                        transformOrigin: "left center",
                        transform: determinate ? `scaleX(${overall / 100})` : undefined,
                        transition: "transform 240ms ease",
                    }}
                />
                {/* Shimmer only while the setup is still running. */}
                {running ? (
                    <div
                        aria-hidden="true"
                        className="speechtodeck-setup-shimmer"
                        style={{
                            position: "absolute",
                            top: 0,
                            bottom: 0,
                            left: 0,
                            width: "40%",
                            background:
                                "linear-gradient(90deg, rgba(255,255,255,0) 0%, rgba(255,255,255,0.35) 50%, rgba(255,255,255,0) 100%)",
                        }}
                    />
                ) : null}
            </div>

            {/* Description line: current step label plus the step detail. */}
            <div
                style={{
                    marginTop: 6,
                    fontSize: 12,
                    color: failed ? "rgba(255, 210, 210, 0.9)" : "rgba(255, 255, 255, 0.55)",
                }}
            >
                {translate(locale, snapshot.labelKey)}
                {detail !== null ? ` — ${detail}` : ""}
            </div>

            {failed && errorMessage !== null ? (
                <div role="alert" style={{ marginTop: 6, fontSize: 12, display: "flex", gap: 6 }}>
                    {snapshot.error !== undefined ? <CodeChip code={snapshot.error.code} /> : null}
                    <span style={{ minWidth: 0 }}>{errorMessage}</span>
                </div>
            ) : null}

            <ol style={{ listStyle: "none", margin: "6px 0 0", padding: 0 }}>
                {STEP_ROWS.map((row, index) => {
                    const state = stepState(snapshot, index);
                    const label = translate(locale, row.labelKey);
                    const showPercent =
                        state === "active" && determinate
                            ? `${Math.round(snapshot.percent)}%`
                            : null;
                    return (
                        <li
                            key={row.labelKey}
                            // Explicit accessible name: the marker glyphs are
                            // decorative and the list style is removed, so the
                            // name must not rely on content computation (§107).
                            aria-label={showPercent !== null ? `${label} ${showPercent}` : label}
                            aria-current={state === "active" ? "step" : undefined}
                            data-step-state={state}
                            style={{
                                display: "flex",
                                alignItems: "center",
                                gap: 8,
                                padding: "3px 0",
                                fontSize: 13,
                                color:
                                    state === "pending"
                                        ? "rgba(255, 255, 255, 0.45)"
                                        : "rgba(255, 255, 255, 0.85)",
                            }}
                        >
                            <StepIcon state={state} />
                            <span style={{ flex: "1 1 auto", minWidth: 0 }}>{label}</span>
                            {showPercent !== null ? (
                                <span
                                    aria-hidden="true"
                                    style={{
                                        flex: "none",
                                        fontSize: 12,
                                        fontVariantNumeric: "tabular-nums",
                                        color: "rgba(255, 255, 255, 0.55)",
                                    }}
                                >
                                    {showPercent}
                                </span>
                            ) : null}
                        </li>
                    );
                })}
            </ol>

            {failed ? (
                <div style={{ marginTop: 8 }}>
                    <ButtonItem
                        label={translate(locale, "setup.retry")}
                        disabled={restarting}
                        onClick={retry}
                    >
                        {translate(locale, "setup.retry")}
                    </ButtonItem>
                </div>
            ) : null}
        </div>
    );
}

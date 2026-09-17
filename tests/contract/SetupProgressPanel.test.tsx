/**
 * SetupProgressPanel render tests (frozen `setup_progress` contract).
 *
 * Decision points: the four step rows derive their state from the guarded
 * payload, subsequent payloads advance the active step and per-step/overall
 * percents (render-only arithmetic: completed × 25 + percent/4), the
 * terminal failed state surfaces the mapped §68 error with a retry control,
 * and the bar exposes progressbar ARIA semantics (no `aria-valuenow` while
 * indeterminate). The store and adapter boundary is covered in
 * DeckyAdapters.test.ts.
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SetupProgressPanel } from "../../src/presentation/settings/SetupProgressPanel";
import type { SetupProgressSnapshot } from "../../src/application/ports/SetupProgressPort";
import { SETUP_SNAPSHOTS } from "./helpers";

vi.mock("@decky/ui", async () => {
    const React = await import("react");
    const h = React.createElement;
    type Children = import("react").ReactNode;
    return {
        ButtonItem: (props: {
            label?: string;
            disabled?: boolean;
            onClick?: () => void;
            children?: Children;
        }) =>
            h(
                "button",
                { disabled: props.disabled === true, onClick: props.onClick },
                props.children ?? props.label,
            ),
    };
});

afterEach(cleanup);

function renderPanel(
    snapshot: SetupProgressSnapshot,
    onRetry: () => Promise<void> = async () => undefined,
) {
    return render(<SetupProgressPanel snapshot={snapshot} locale="en" onRetry={onRetry} />);
}

describe("SetupProgressPanel", () => {
    it("renders the four steps with state, per-step percent and overall picture", () => {
        renderPanel(SETUP_SNAPSHOTS.download);

        const steps = screen.getAllByRole("listitem");
        expect(steps).toHaveLength(4);
        // Accessible names come from the visible labels; the state glyphs
        // are aria-hidden and never color-only (§107).
        expect(steps.map((step) => step.getAttribute("data-step-state"))).toEqual([
            "done",
            "active",
            "pending",
            "pending",
        ]);
        expect(screen.getByRole("listitem", { name: "Verify runtime" })).toBe(steps[0]);
        expect(screen.getByRole("listitem", { name: "Model 37%" })).toBe(steps[1]);
        expect(screen.getByRole("listitem", { name: "Start daemon" })).toBe(steps[2]);
        expect(screen.getByRole("listitem", { name: "Load model" })).toBe(steps[3]);
        expect(steps[1]?.textContent).toContain("37%");
        expect(steps[1]?.getAttribute("aria-current")).toBe("step");
        // Description line: current labelKey + detailKey text.
        expect(screen.getByText("Model — Downloading…")).not.toBeNull();
        // Overall percent: completed(1) × 25 + 37/4 = 34 (render-only).
        const bar = screen.getByRole("progressbar");
        expect(bar.getAttribute("aria-valuenow")).toBe("34");
        expect(bar.getAttribute("aria-valuemin")).toBe("0");
        expect(bar.getAttribute("aria-valuemax")).toBe("100");
    });

    it("advances the active step and percents on subsequent payloads", () => {
        const { rerender } = renderPanel(SETUP_SNAPSHOTS.download);
        rerender(
            <SetupProgressPanel
                snapshot={{
                    protocolVersion: 1,
                    step: "daemon.start",
                    labelKey: "setup.step.daemonStart",
                    stepIndex: 2,
                    totalSteps: 4,
                    percent: 40,
                    indeterminate: false,
                    detailKey: "setup.detail.spawning",
                }}
                locale="en"
                onRetry={async () => undefined}
            />,
        );

        const steps = screen.getAllByRole("listitem");
        expect(steps.map((step) => step.getAttribute("data-step-state"))).toEqual([
            "done",
            "done",
            "active",
            "pending",
        ]);
        // 2 completed × 25 + 40/4 = 60.
        expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("60");
    });

    it("keeps the bar indeterminate (no valuenow, no percents) on indeterminate payloads", () => {
        renderPanel(SETUP_SNAPSHOTS.indeterminate);

        const bar = screen.getByRole("progressbar");
        expect(bar.getAttribute("data-indeterminate")).toBe("true");
        expect(bar.hasAttribute("aria-valuenow")).toBe(false);
        expect(bar.getAttribute("aria-valuemin")).toBe("0");
        expect(bar.getAttribute("aria-valuemax")).toBe("100");
        // Indeterminate payloads never render percent figures.
        expect(screen.queryByText(/^\d+%$/)).toBeNull();
    });

    it("marks the failing step, maps the §68 error code and offers retry", async () => {
        let resolveRetry: (() => void) | null = null;
        const onRetry = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    resolveRetry = resolve;
                }),
        );
        renderPanel(SETUP_SNAPSHOTS.failed, onRetry);

        const steps = screen.getAllByRole("listitem");
        expect(steps.map((step) => step.getAttribute("data-step-state"))).toEqual([
            "done",
            "done",
            "error",
            "pending",
        ]);
        // Raw code chip plus mapped §68 text, announced via role="alert".
        expect(screen.getByText("MODEL_DOWNLOAD_FAILED")).not.toBeNull();
        expect(screen.getByRole("alert").textContent).toContain("Downloading the model failed.");

        const retry = screen.getByRole("button", { name: "Retry" }) as HTMLButtonElement;
        fireEvent.click(retry);
        expect(onRetry).toHaveBeenCalledTimes(1);
        expect(retry.disabled).toBe(true); // in-flight retry is not re-entrant

        await act(async () => {
            resolveRetry?.();
        });
        expect(retry.disabled).toBe(false);
    });

    it("falls back to a localized generic message for unknown error codes", () => {
        renderPanel({
            ...SETUP_SNAPSHOTS.failed,
            error: { code: "NOT_IN_THE_VOCABULARY" },
        });
        expect(screen.getByText("NOT_IN_THE_VOCABULARY")).not.toBeNull();
        expect(screen.getByRole("alert").textContent).toContain(
            "An unexpected setup error occurred.",
        );
    });
});

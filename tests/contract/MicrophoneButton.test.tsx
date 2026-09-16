/**
 * MicrophoneButton contract tests (spec §19/§20/§107): pure rendering of the
 * four visual states with §107 a11y — accessible name, pressed state,
 * disabled state, and per-state glyphs so state never relies on color only.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MicrophoneButton } from "../../src/presentation/keyboard/MicrophoneButton";

afterEach(cleanup);

describe("MicrophoneButton", () => {
    it.each([
        ["ready", { pressed: false, disabled: false }],
        ["recording", { pressed: true, disabled: false }],
        ["processing", { pressed: false, disabled: true }],
        ["error", { pressed: false, disabled: true }],
    ] as const)("renders the %s state with correct a11y attributes", (state, expected) => {
        const onPress = vi.fn();
        render(<MicrophoneButton state={state} disabled={expected.disabled} onPress={onPress} />);

        const button = screen.getByRole("button");
        expect(button.getAttribute("data-state")).toBe(state);
        expect(button.getAttribute("aria-label")?.length ?? 0).toBeGreaterThan(0);
        expect(button.getAttribute("aria-pressed")).toBe(expected.pressed ? "true" : null);
        expect((button as HTMLButtonElement).disabled).toBe(expected.disabled);
    });

    it("changes accessible name and glyph per state (not color-only, §107)", () => {
        const onPress = vi.fn();
        const { rerender } = render(
            <MicrophoneButton state="ready" disabled={false} onPress={onPress} />,
        );
        const readyName = screen.getByRole("button").getAttribute("aria-label");
        const readyText = screen.getByRole("button").textContent;

        rerender(<MicrophoneButton state="recording" disabled={false} onPress={onPress} />);
        const recordingName = screen.getByRole("button").getAttribute("aria-label");
        const recordingText = screen.getByRole("button").textContent;

        rerender(<MicrophoneButton state="error" disabled={true} onPress={onPress} />);
        const errorText = screen.getByRole("button").textContent;

        expect(recordingName).not.toBe(readyName);
        expect(recordingText).not.toBe(readyText); // glyph changed
        expect(errorText).not.toBe(readyText);
    });

    it("forwards presses only while enabled", () => {
        const onPress = vi.fn();
        const { rerender } = render(
            <MicrophoneButton state="ready" disabled={false} onPress={onPress} />,
        );

        fireEvent.click(screen.getByRole("button"));
        expect(onPress).toHaveBeenCalledTimes(1);

        rerender(<MicrophoneButton state="processing" disabled={true} onPress={onPress} />);
        fireEvent.click(screen.getByRole("button"));
        expect(onPress).toHaveBeenCalledTimes(1); // disabled press ignored
    });

    it("localizes the accessible name", () => {
        const onPress = vi.fn();
        render(
            <MicrophoneButton state="recording" disabled={false} onPress={onPress} locale="de" />,
        );
        expect(screen.getByRole("button").getAttribute("aria-label")).toContain("Aufnahme");
    });
});

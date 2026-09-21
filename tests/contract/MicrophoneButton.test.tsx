import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MicrophoneButton } from "../../src/presentation/controls/MicrophoneButton";

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

    it("changes accessible name and state markers per state (not color-only)", () => {
        const onPress = vi.fn();
        const { rerender } = render(
            <MicrophoneButton state="ready" disabled={false} onPress={onPress} />,
        );
        const readyName = screen.getByRole("button").getAttribute("aria-label");
        expect(screen.getByRole("button").querySelector("[data-state-marker]")).toBeNull();

        rerender(
            <MicrophoneButton
                state="recording"
                disabled={false}
                onPress={onPress}
                elapsedLabel="00:42"
            />,
        );
        const recordingButton = screen.getByRole("button");
        const recordingName = recordingButton.getAttribute("aria-label");
        expect(recordingButton.textContent).toBe("00:42");
        expect(recordingButton.querySelector('[data-state-marker="recording"]')).not.toBeNull();

        rerender(<MicrophoneButton state="processing" disabled={true} onPress={onPress} />);
        expect(
            screen.getByRole("button").querySelector('[data-state-marker="recording"]'),
        ).toBeNull();

        rerender(<MicrophoneButton state="error" disabled={true} onPress={onPress} />);
        const errorButton = screen.getByRole("button");
        expect(errorButton.querySelector('[data-state-marker="error"]')?.textContent).toBe("!");

        expect(recordingName).not.toBe(readyName);
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
        expect(onPress).toHaveBeenCalledTimes(1);
    });

    it("localizes the accessible name", () => {
        const onPress = vi.fn();
        render(
            <MicrophoneButton state="recording" disabled={false} onPress={onPress} locale="de" />,
        );
        expect(screen.getByRole("button").getAttribute("aria-label")).toContain("Aufnahme");
    });

    it("shows the localized error flash briefly and cleans up its timer", () => {
        vi.useFakeTimers();
        try {
            const onPress = vi.fn();
            const { rerender } = render(
                <MicrophoneButton
                    state="error"
                    disabled={true}
                    onPress={onPress}
                    errorMessage="Transcription failed."
                />,
            );
            const status = screen.getByRole("status");
            expect(status.textContent).toBe("Transcription failed.");

            rerender(
                <MicrophoneButton
                    state="error"
                    disabled={true}
                    onPress={onPress}
                    errorMessage="Transcription failed."
                />,
            );
            expect(screen.getByRole("status").textContent).toBe("Transcription failed.");

            rerender(<MicrophoneButton state="ready" disabled={false} onPress={onPress} />);
            expect(screen.queryByRole("status")).toBeNull();

            rerender(
                <MicrophoneButton
                    state="error"
                    disabled={true}
                    onPress={onPress}
                    errorMessage="Transcription failed."
                />,
            );
            expect(screen.getByRole("status")).not.toBeNull();
            act(() => {
                vi.advanceTimersByTime(4000);
            });
            expect(screen.queryByRole("status")).toBeNull();
        } finally {
            vi.useRealTimers();
        }
    });
});

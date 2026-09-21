import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DictationCard } from "../../src/presentation/settings/DictationCard";
import { LevelMeterStore } from "../../src/application/ports/LevelMeterPort";
import type { PanelTranscriptSnapshot } from "../../src/application/ports/PanelTranscriptPort";
import type { DictationState } from "../../src/domain/DictationState";
import { DictationError } from "../../src/domain/DictationError";
import { FakeSnapshotStore } from "./helpers";

vi.mock("@decky/ui", async () => {
    const React = await import("react");
    const h = React.createElement;
    return {
        PanelSectionRow: (props: { children?: React.ReactNode }) => h("div", null, props.children),
    };
});

afterEach(cleanup);

const RECORDING: DictationState = {
    kind: "recording",
    session: { sessionId: "panel-1", startedAtMonotonicMs: 0 },
};
const READY: DictationState = { kind: "ready" };
const ERROR: DictationState = {
    kind: "error",
    error: new DictationError("RUNTIME_UNAVAILABLE"),
    recoverable: true,
};

function framePayload(seq: number, min: number, max: number, peakDbfs: number) {
    return {
        protocolVersion: 1 as const,
        kind: "recording_level" as const,
        seq,
        frames: [[min, max, peakDbfs] as const],
    };
}

async function renderCard(
    state: DictationState,
    levelMeter: LevelMeterStore,
    transcript: FakeSnapshotStore<PanelTranscriptSnapshot | null>,
    onCopy: (text: string) => Promise<boolean> = async () => true,
    onPress: () => void = () => undefined,
) {
    const view = render(
        <DictationCard
            state={state}
            levelMeter={levelMeter}
            transcript={transcript.getSnapshot()}
            onPress={onPress}
            onCopy={onCopy}
            locale="en"
        />,
    );
    await act(async () => undefined);
    return view;
}

describe("DictationCard", () => {
    it("renders the big button from the state union and routes the press", async () => {
        const onPress = vi.fn();
        const store = new LevelMeterStore();
        await renderCard(
            READY,
            store,
            new FakeSnapshotStore<PanelTranscriptSnapshot | null>(null),
            async () => true,
            onPress,
        );

        const button = screen.getByRole("button", { name: /start voice input/i });
        expect(button.getAttribute("data-state")).toBe("ready");
        expect((button as HTMLButtonElement).disabled).toBe(false);

        fireEvent.click(button);
        expect(onPress).toHaveBeenCalledTimes(1);
        expect(document.querySelector("[data-level-strip]")).toBeNull();
        expect(document.querySelector("[data-transcript-block]")).toBeNull();
    });

    it("renders the code chip and the translated message inline in the error state", async () => {
        await renderCard(
            ERROR,
            new LevelMeterStore(),
            new FakeSnapshotStore<PanelTranscriptSnapshot | null>(null),
        );

        const details = document.querySelector("[data-dictation-error]");
        expect(details).not.toBeNull();
        expect(details?.textContent).toContain("RUNTIME_UNAVAILABLE");
        expect(details?.textContent).toContain("The speech runtime is not available.");
    });

    it("never points to the removed diagnostics section from the error state", async () => {
        await renderCard(
            ERROR,
            new LevelMeterStore(),
            new FakeSnapshotStore<PanelTranscriptSnapshot | null>(null),
        );

        expect(document.body.textContent).not.toContain("plugin panel");
        expect(document.querySelector("[data-dictation-error]")).not.toBeNull();
    });

    it("renders the level strip with real published frames while recording", async () => {
        const store = new LevelMeterStore();
        await renderCard(
            RECORDING,
            store,
            new FakeSnapshotStore<PanelTranscriptSnapshot | null>(null),
        );

        const strip = document.querySelector("[data-level-strip]");
        expect(strip).not.toBeNull();
        expect(document.querySelectorAll("[data-level-bar]")).toHaveLength(24);
        expect(document.querySelector("[data-level-style-picker]")).not.toBeNull();
        expect(
            strip?.querySelector('[data-level-bar="23"]')?.getAttribute("data-level-value"),
        ).toBe("0.00");

        await act(async () => {
            store.publish(framePayload(41, -0.03, 0.03, -30));
            store.publish(framePayload(42, -0.5, 0.5, -6));
        });
        expect(
            strip?.querySelector('[data-level-bar="23"]')?.getAttribute("data-level-value"),
        ).toBe("0.90");
        expect(
            strip?.querySelector('[data-level-bar="22"]')?.getAttribute("data-level-value"),
        ).toBe("0.50");
        expect(strip?.getAttribute("aria-label")).toBe("Live microphone level");
    });

    it("keeps the style picker visible before a recording starts", async () => {
        await renderCard(
            READY,
            new LevelMeterStore(),
            new FakeSnapshotStore<PanelTranscriptSnapshot | null>(null),
        );

        expect(document.querySelector("[data-level-style-picker]")).not.toBeNull();
        expect(document.querySelector("[data-level-strip]")).toBeNull();
    });

    it("hides the strip once the flow leaves recording and shows the transcript block", async () => {
        const store = new LevelMeterStore();
        const transcript = new FakeSnapshotStore<PanelTranscriptSnapshot | null>({
            sessionId: "panel-1",
            text: "hello world",
            clipboard: "ok",
        });
        const props = (state: DictationState) => ({
            state,
            levelMeter: store,
            transcript: transcript.getSnapshot(),
            onPress: () => undefined,
            onCopy: async () => true,
            locale: "en" as const,
        });
        const view = render(<DictationCard {...props(RECORDING)} />);
        expect(document.querySelector("[data-level-strip]")).not.toBeNull();
        expect(document.querySelector("[data-transcript-block]")).toBeNull();

        await act(async () => {
            view.rerender(<DictationCard {...props(READY)} />);
        });
        expect(document.querySelector("[data-level-strip]")).toBeNull();
        expect(document.querySelector("[data-level-style-picker]")).not.toBeNull();
        const block = document.querySelector("[data-transcript-block]");
        expect(block).not.toBeNull();
        expect(block?.querySelector("[data-transcript-preview]")?.textContent).toBe("hello world");
        expect(block?.querySelector('[data-clipboard-status="copied"]')?.textContent).toContain(
            "STEAM+X",
        );
    });

    it("truncates the preview and never auto-copies when the backend copied already", async () => {
        const onCopy = vi.fn(async () => true);
        const long = "x".repeat(200);
        const transcript = new FakeSnapshotStore<PanelTranscriptSnapshot | null>({
            sessionId: "panel-1",
            text: long,
            clipboard: "ok",
        });
        await renderCard(READY, new LevelMeterStore(), transcript, onCopy);

        const preview = document.querySelector("[data-transcript-preview]");
        expect(preview?.textContent).toBe(`${"x".repeat(140)}…`);
        expect(onCopy).not.toHaveBeenCalled();
    });

    it("auto-copies a skipped backend leg and reports the panel outcome", async () => {
        const onCopy = vi.fn(async (text: string) => text === "hallo");
        const transcript = new FakeSnapshotStore<PanelTranscriptSnapshot | null>({
            sessionId: "panel-1",
            text: "hallo",
            clipboard: "skipped",
        });
        await renderCard(READY, new LevelMeterStore(), transcript, onCopy);

        expect(onCopy).toHaveBeenCalledWith("hallo");
        expect(document.querySelector('[data-clipboard-status="copied"]')).not.toBeNull();
    });

    it("reports a failed copy and re-runs it from the copy-again button", async () => {
        let outcome = false;
        const onCopy = vi.fn(async () => outcome);
        const transcript = new FakeSnapshotStore<PanelTranscriptSnapshot | null>({
            sessionId: "panel-1",
            text: "hallo",
            clipboard: "failed",
        });
        await renderCard(READY, new LevelMeterStore(), transcript, onCopy);

        expect(document.querySelector('[data-clipboard-status="failed"]')).not.toBeNull();

        outcome = true;
        const again = document.querySelector("[data-copy-again]") as HTMLButtonElement | null;
        expect(again).not.toBeNull();
        await act(async () => {
            fireEvent.click(again as HTMLButtonElement);
        });
        expect(document.querySelector('[data-clipboard-status="copied"]')).not.toBeNull();
        expect(onCopy).toHaveBeenCalledTimes(2);
    });
});

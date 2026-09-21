import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DictationController } from "../../src/application/DictationController";
import { DictationCard } from "../../src/presentation/settings/DictationCard";
import { DeckyBackendClient } from "../../src/infrastructure/decky/DeckyBackendClient";
import { DeckySpeechAdapter } from "../../src/infrastructure/decky/DeckySpeechAdapter";
import type { DeckyTransport } from "../../src/infrastructure/decky/DeckyBackendClient";
import { copyTextToClipboard } from "../../src/infrastructure/system/PanelClipboard";
import { Deferred } from "../../src/shared/Deferred";
import type { Disposable } from "../../src/shared/Disposable";
import { FakeClipboardPort } from "../frontend/fakes/FakeClipboardPort";
import { FakeClock } from "../frontend/fakes/FakeClock";
import { FakeIdGenerator } from "../frontend/fakes/FakeIdGenerator";
import { FakeSettingsPort } from "../frontend/fakes/FakeSettingsPort";
import { flush } from "../frontend/fakes/TestRig";

vi.mock("@decky/ui", async () => {
    const React = await import("react");
    const h = React.createElement;
    return {
        PanelSectionRow: (props: { children?: React.ReactNode }) => h("div", null, props.children),
    };
});

afterEach(cleanup);

class ScriptedLoaderTransport implements DeckyTransport {
    readonly calls: { route: string; args: unknown[] }[] = [];

    private readonly deferreds = new Map<string, Deferred<unknown>>();
    private readonly envelopes = new Map<string, Record<string, unknown>>();
    private readonly behaviors = new Map<string, () => void>();
    private readonly subscriptions = new Map<string, Set<(...args: unknown[]) => void>>();

    async call(route: string, ...args: unknown[]): Promise<unknown> {
        this.calls.push({ route, args });
        const deferred = new Deferred<unknown>();
        this.deferreds.set(route, deferred);
        this.behaviors.get(route)?.();
        const envelope = this.envelopes.get(route);
        if (envelope !== undefined) {
            deferred.resolve(envelope);
        }
        return deferred.promise;
    }

    respond(route: string, payload: Record<string, unknown> = {}): void {
        this.envelopes.set(route, { ok: true, ...payload });
    }

    duringCall(route: string, behavior: () => void): void {
        this.behaviors.set(route, behavior);
    }

    emit(event: string, payload?: unknown): void {
        for (const listener of [...(this.subscriptions.get(event) ?? [])]) {
            listener(payload);
        }
    }

    addEventListener(event: string, listener: (...args: unknown[]) => void): Disposable {
        let listeners = this.subscriptions.get(event);
        if (listeners === undefined) {
            listeners = new Set();
            this.subscriptions.set(event, listeners);
        }
        listeners.add(listener);
        return {
            dispose: () => {
                listeners.delete(listener);
            },
        };
    }

    removeEventListener(event: string, listener: (...args: unknown[]) => void): void {
        this.subscriptions.get(event)?.delete(listener);
    }
}

const GET_CAPABILITIES = {
    speechRuntimeAvailable: true,
    microphoneAvailable: true,
    cpuAvailable: true,
    vulkanAvailable: true,
    modelInstalled: true,
};
const SESSION_ID = "id-1";
const TRANSCRIPT_TEXT = "Input, voice input, voice input, yeah Okay, läuft";
const TRANSCRIPT_READY_PAYLOAD = {
    protocolVersion: 1,
    sessionId: SESSION_ID,
    text: TRANSCRIPT_TEXT,
    metrics: {
        audioDurationMs: 9300,
        transcriptionDurationMs: 2500,
        modelId: "base",
        computeBackend: "vulkan",
    },
    clipboard: "skipped",
};
const LEVEL_EVENT = (seq: number) => ({
    protocolVersion: 1,
    kind: "recording_level",
    seq,
    frames: [[0.12, 0.88, 0.95] as [number, number, number]],
});

function JourneyHarness({
    controller,
    speech,
    onCopy,
}: {
    controller: DictationController;
    speech: DeckySpeechAdapter;
    onCopy: (text: string) => Promise<boolean>;
}): React.ReactElement {
    const state = React.useSyncExternalStore(
        (onChange) => controller.subscribe(onChange),
        () => controller.getSnapshot(),
    );
    const transcript = React.useSyncExternalStore(
        (onChange) => speech.panelTranscript.subscribe(onChange),
        () => speech.panelTranscript.getSnapshot(),
    );
    return (
        <DictationCard
            state={state}
            levelMeter={speech.levelMeter}
            transcript={transcript}
            onPress={() => {
                void controller.handlePanelMicrophonePressed();
            }}
            onCopy={onCopy}
            locale="en"
        />
    );
}

describe("panel dictation journey: press → levels → stop → transcript → clipboard (paste leg)", () => {
    it("drives the whole shipped clipboard flow over the real stack, in the real decky event order", async () => {
        const transport = new ScriptedLoaderTransport();
        transport.respond("get_capabilities", GET_CAPABILITIES);
        transport.respond("start_recording");
        transport.duringCall("stop_recording", () => {
            transport.emit("transcript_ready", TRANSCRIPT_READY_PAYLOAD);
            transport.respond("stop_recording");
        });

        const backend = new DeckyBackendClient(transport);
        const speech = new DeckySpeechAdapter(backend);
        const controller = new DictationController(
            speech,
            new FakeClipboardPort([]),
            new FakeSettingsPort(),
            new FakeClock(),
            new FakeIdGenerator(),
        );

        let copiedViaExecCommand: string | null = null;
        Object.defineProperty(document, "execCommand", {
            configurable: true,
            writable: true,
            value: (command: string) => {
                if (command === "copy") {
                    const input = document.body.querySelector("textarea");
                    copiedViaExecCommand =
                        input instanceof HTMLTextAreaElement ? input.value : null;
                }
                return true;
            },
        });
        const onCopy = (text: string) => copyTextToClipboard(text);

        render(<JourneyHarness controller={controller} speech={speech} onCopy={onCopy} />);

        await act(async () => {
            await controller.start();
            await flush();
        });
        expect(controller.getSnapshot().kind).toBe("ready");
        expect(transport.calls.map((call) => call.route)).toEqual(["get_capabilities"]);
        const mic = screen.getByRole("button");
        expect(mic.hasAttribute("disabled")).toBe(false);

        await act(async () => {
            fireEvent.click(mic);
            await flush();
        });
        expect(transport.calls.map((call) => call.route)).toEqual([
            "get_capabilities",
            "start_recording",
        ]);
        expect(transport.calls[1]!.args).toEqual([SESSION_ID]);
        expect(controller.getSnapshot().kind).toBe("recording");
        expect(document.querySelector("[data-level-strip]")).not.toBeNull();

        await act(async () => {
            transport.emit("recording_level", LEVEL_EVENT(1));
            transport.emit("recording_level", LEVEL_EVENT(2));
            transport.emit("recording_level", LEVEL_EVENT(3));
        });
        const bars = [...document.querySelectorAll("[data-level-bar]")];
        expect(bars).toHaveLength(24);
        const lit = bars.filter((bar) => Number(bar.getAttribute("data-level-value")) > 0);
        expect(lit.length).toBeGreaterThan(0);

        await act(async () => {
            fireEvent.click(screen.getByRole("button"));
            await flush();
        });
        const stopCall = transport.calls[transport.calls.length - 1];
        expect(stopCall).toMatchObject({ route: "stop_recording", args: [SESSION_ID] });

        const finalKind = controller.getSnapshot().kind;
        expect(finalKind).not.toBe("transcribing");
        expect(finalKind).not.toBe("stopping");
        expect(finalKind).toBe("ready");

        const preview = document.querySelector("[data-transcript-preview]");
        expect(preview?.textContent).toContain(TRANSCRIPT_TEXT);
        expect(copiedViaExecCommand).toBe(TRANSCRIPT_TEXT);
        expect(document.querySelector('[data-clipboard-status="copied"]')).not.toBeNull();
        expect(document.querySelector("[data-level-strip]")).toBeNull();
    });
});

describe("panel dictation journey: empty speech must never lock the mic", () => {
    it("settles back to ready with the button pressable again when nothing was said", async () => {
        const transport = new ScriptedLoaderTransport();
        transport.respond("get_capabilities", GET_CAPABILITIES);
        transport.respond("start_recording");
        transport.duringCall("stop_recording", () => {
            transport.emit("transcript_ready", {
                ...TRANSCRIPT_READY_PAYLOAD,
                text: "",
                clipboard: "skipped",
            });
            transport.respond("stop_recording");
        });

        const backend = new DeckyBackendClient(transport);
        const speech = new DeckySpeechAdapter(backend);
        const controller = new DictationController(
            speech,
            new FakeClipboardPort([]),
            new FakeSettingsPort(),
            new FakeClock(),
            new FakeIdGenerator(),
        );

        render(
            <JourneyHarness controller={controller} speech={speech} onCopy={async () => true} />,
        );

        await act(async () => {
            await controller.start();
            await flush();
        });

        await act(async () => {
            fireEvent.click(screen.getByRole("button"));
            await flush();
        });
        expect(controller.getSnapshot().kind).toBe("recording");
        await act(async () => {
            fireEvent.click(screen.getByRole("button"));
            await flush();
        });

        expect(controller.getSnapshot().kind).toBe("ready");
        expect(document.querySelector("[data-transcript-preview]")).toBeNull();
        expect(document.querySelector('[data-clipboard-status="copied"]')).toBeNull();

        await act(async () => {
            fireEvent.click(screen.getByRole("button"));
            await flush();
        });
        expect(controller.getSnapshot().kind).toBe("recording");
        const startCalls = transport.calls.filter((call) => call.route === "start_recording");
        expect(startCalls).toHaveLength(2);
        expect(startCalls[1]!.args).toEqual(["id-2"]);
    });
});

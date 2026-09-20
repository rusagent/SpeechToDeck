/**
 * Panel dictation journey: ONE test drives the shipped
 * flow end to end over the REAL frontend stack — decky envelope unwrap →
 * boundary guards → state machine → panel card render → system
 * clipboard (the paste leg's input; the physical paste is the user's
 * STEAM+X on-screen-keyboard key, which no test can press).
 *
 * The transport mimics the loader's observable semantics exactly: a single
 * FIFO socket carrying coded `{"ok": ...}` envelopes plus backend events,
 * where an event emitted INSIDE a callable's window is dispatched before
 * that callable's response. That ordering is the on-device finding
 * (transcript_ready always precedes the stop acknowledgement;
 * rejecting it in `stopping` wedged the card in "transcribing" forever).
 */

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
import { FakeBulkTextInserter } from "../frontend/fakes/FakeBulkTextInserter";
import { FakeClock } from "../frontend/fakes/FakeClock";
import { FakeIdGenerator } from "../frontend/fakes/FakeIdGenerator";
import { FakeKeyboardHost } from "../frontend/fakes/FakeKeyboardHost";
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

/**
 * Loader stand-in: FIFO dispatch, coded Python envelopes, and scripted
 * backend behavior inside a callable's window (the real `stop_recording`
 * emits transcript_ready before its response travels back).
 */
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

    /** The Python callable's coded success envelope `{"ok": true, ...}`. */
    respond(route: string, payload: Record<string, unknown> = {}): void {
        this.envelopes.set(route, { ok: true, ...payload });
    }

    /** Backend behavior that runs INSIDE the callable window, before the response. */
    duringCall(route: string, behavior: () => void): void {
        this.behaviors.set(route, behavior);
    }

    /** The Python side emitting one event over the socket. */
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

/** Exact backend payload shapes (captured from a live vulkan daemon). */
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

/** Renders the card exactly like the panel: reactive to store/controller state. */
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
        // The real stop_recording emits transcript_ready INSIDE the callable
        // window, before its response — FIFO socket ordering.
        transport.duringCall("stop_recording", () => {
            transport.emit("transcript_ready", TRANSCRIPT_READY_PAYLOAD);
            transport.respond("stop_recording");
        });

        const backend = new DeckyBackendClient(transport);
        const speech = new DeckySpeechAdapter(backend);
        // No keyboard context: presses route through the panel clipboard flow.
        const controller = new DictationController(
            speech,
            new FakeKeyboardHost([]),
            new FakeBulkTextInserter([]),
            new FakeSettingsPort(),
            new FakeClock(),
            new FakeIdGenerator(),
        );

        // The real panel clipboard path; execCommand is the CEF success seam.
        // jsdom limitation (see KeyboardBridgeBootstrap.test.ts): the API does
        // not exist, so the seam is defined rather than spied.
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

        // ── boot → ready ─────────────────────────────────────────────────────
        await act(async () => {
            await controller.start();
            await flush();
        });
        expect(controller.getSnapshot().kind).toBe("ready");
        expect(transport.calls.map((call) => call.route)).toEqual(["get_capabilities"]);
        const mic = screen.getByRole("button");
        expect(mic.hasAttribute("disabled")).toBe(false);

        // ── press 1: start recording ─────────────────────────────────────────
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

        // ── the user speaks: real recording_level frames light the strip ────
        await act(async () => {
            transport.emit("recording_level", LEVEL_EVENT(1));
            transport.emit("recording_level", LEVEL_EVENT(2));
            transport.emit("recording_level", LEVEL_EVENT(3));
        });
        const bars = [...document.querySelectorAll("[data-level-bar]")];
        expect(bars).toHaveLength(24);
        const lit = bars.filter((bar) => Number(bar.getAttribute("data-level-value")) > 0);
        expect(lit.length).toBeGreaterThan(0);

        // ── press 2: stop; the backend emits the transcript BEFORE the ack ──
        await act(async () => {
            fireEvent.click(screen.getByRole("button"));
            await flush();
        });
        const stopCall = transport.calls[transport.calls.length - 1];
        expect(stopCall).toMatchObject({ route: "stop_recording", args: [SESSION_ID] });

        // ── settled: never stuck transcribing, clipboard leg done ───────────
        const finalKind = controller.getSnapshot().kind;
        expect(finalKind).not.toBe("transcribing");
        expect(finalKind).not.toBe("stopping");
        expect(finalKind).toBe("ready");

        const preview = document.querySelector("[data-transcript-preview]");
        expect(preview?.textContent).toContain(TRANSCRIPT_TEXT);
        // The paste leg: the exact transcript reached the clipboard mechanism;
        // on device the user's STEAM+X paste key inserts it from there.
        expect(copiedViaExecCommand).toBe(TRANSCRIPT_TEXT);
        expect(document.querySelector('[data-clipboard-status="copied"]')).not.toBeNull();
        // Recording ended: the strip window is gone again.
        expect(document.querySelector("[data-level-strip]")).toBeNull();
    });
});

describe("panel dictation journey: empty speech must never lock the mic", () => {
    it("settles back to ready with the button pressable again when nothing was said", async () => {
        // Live-device scenario: press, say NOTHING, stop.
        // The daemon reports empty speech (CLI exit 3) and — since the
        // empty-outcome fix — the backend emits an EMPTY transcript_ready
        // inside the stop callable window instead of staying silent.
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
            new FakeKeyboardHost([]),
            new FakeBulkTextInserter([]),
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

        // Recording 1: press, silence, stop.
        await act(async () => {
            fireEvent.click(screen.getByRole("button"));
            await flush();
        });
        expect(controller.getSnapshot().kind).toBe("recording");
        await act(async () => {
            fireEvent.click(screen.getByRole("button"));
            await flush();
        });

        // Silently back to ready — never wedged in transcribing.
        expect(controller.getSnapshot().kind).toBe("ready");
        // No transcript block, no copied status, nothing to copy.
        expect(document.querySelector("[data-transcript-preview]")).toBeNull();
        expect(document.querySelector('[data-clipboard-status="copied"]')).toBeNull();

        // The lock regression: the mic must accept a NEW session immediately.
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

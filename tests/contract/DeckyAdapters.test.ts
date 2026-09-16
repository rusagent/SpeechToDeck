/**
 * Decky adapter contract tests (spec §30/§67/§99): the frozen callable/event
 * names travel verbatim, backend payloads are guarded before they reach the
 * application, and unvalidated payloads are dropped instead of passed on.
 */

import { describe, expect, it } from "vitest";
import { DeckyBackendClient } from "../../src/infrastructure/decky/DeckyBackendClient";
import { DeckySpeechAdapter } from "../../src/infrastructure/decky/DeckySpeechAdapter";
import { DeckySettingsAdapter } from "../../src/infrastructure/decky/DeckySettingsAdapter";
import { FakeDeckyTransport } from "./helpers";
import { TEST_SETTINGS } from "../frontend/fakes/FakeSettingsPort";

const VALID_CAPABILITIES = {
    speechRuntimeAvailable: true,
    microphoneAvailable: true,
    cpuAvailable: true,
    vulkanAvailable: false,
    modelInstalled: true,
};

const VALID_TRANSCRIPT_PAYLOAD = {
    protocolVersion: 1,
    sessionId: "session-1",
    text: "Hallo Welt",
    metrics: {
        audioDurationMs: 1200,
        transcriptionDurationMs: 340,
        modelId: "base",
        computeBackend: "cpu",
    },
};

describe("DeckySpeechAdapter", () => {
    it("maps SpeechPort calls onto the frozen §30 callable names", async () => {
        const transport = new FakeDeckyTransport();
        transport.callResponses.set("get_capabilities", VALID_CAPABILITIES);
        const adapter = new DeckySpeechAdapter(new DeckyBackendClient(transport));

        await adapter.initialize();
        await adapter.startRecording("session-1");
        await adapter.stopRecording("session-1");
        await adapter.cancelRecording("session-2");

        expect(transport.calls.map((call) => call.route)).toEqual([
            "get_capabilities",
            "start_recording",
            "stop_recording",
            "cancel_recording",
        ]);
        expect(transport.calls[1]!.args).toEqual(["session-1"]);
        expect(transport.calls[3]!.args).toEqual(["session-2"]);
    });

    it("emits guarded transcript events and drops unvalidated payloads", async () => {
        const transport = new FakeDeckyTransport();
        const adapter = new DeckySpeechAdapter(new DeckyBackendClient(transport));
        const events: string[] = [];
        adapter.subscribe((event) => events.push(event.type));
        adapter.subscribe(() => undefined); // second subscriber shares one transport subscription

        transport.emit("transcript_ready", VALID_TRANSCRIPT_PAYLOAD);
        transport.emit("transcript_ready", { garbage: true });

        expect(events).toEqual(["transcript-ready"]); // invalid payload dropped (§99)
    });

    it("maps speech_error and runtime_status payloads onto typed events", async () => {
        const transport = new FakeDeckyTransport();
        const adapter = new DeckySpeechAdapter(new DeckyBackendClient(transport));
        const received: unknown[] = [];
        adapter.subscribe((event) => received.push(event));

        transport.emit("speech_error", { code: "TRANSCRIPTION_FAILED", sessionId: "session-1" });
        transport.emit("speech_error", { code: "NOT_A_REAL_CODE" });
        transport.emit("runtime_status", "crashed");
        transport.emit("runtime_status", "exploded");

        expect(received).toHaveLength(2);
        expect(received[0]).toMatchObject({
            type: "speech-error",
            sessionId: "session-1",
            error: { code: "TRANSCRIPTION_FAILED" },
        });
        expect(received[1]).toEqual({ type: "runtime-status", status: "crashed" });
    });

    it("unsubscribe removes exactly its backend event listeners", async () => {
        const transport = new FakeDeckyTransport();
        const adapter = new DeckySpeechAdapter(new DeckyBackendClient(transport));
        const events: string[] = [];
        const subscription = adapter.subscribe((event) => events.push(event.type));

        subscription.dispose();
        await adapter.shutdown();
        transport.emit("transcript_ready", VALID_TRANSCRIPT_PAYLOAD);

        expect(events).toEqual([]);
        expect(transport.removedListeners.map((entry) => entry.event).sort()).toEqual([
            "runtime_status",
            "speech_error",
            "transcript_ready",
        ]);
    });

    it("initialize fails with a stable error when the payload guard rejects", async () => {
        const transport = new FakeDeckyTransport();
        transport.callResponses.set("get_capabilities", { nope: 1 });
        const adapter = new DeckySpeechAdapter(new DeckyBackendClient(transport));

        await expect(adapter.initialize()).rejects.toMatchObject({ code: "RUNTIME_START_FAILED" });
    });
});

describe("DeckySettingsAdapter", () => {
    it("loads and updates settings through the frozen §30 callables with guards", async () => {
        const transport = new FakeDeckyTransport();
        transport.callResponses.set("get_settings", TEST_SETTINGS);
        const adapter = new DeckySettingsAdapter(new DeckyBackendClient(transport));

        const loaded = await adapter.load();
        expect(loaded).toEqual(TEST_SETTINGS);

        await adapter.save({ ...TEST_SETTINGS, enabled: false });
        expect(transport.calls[1]).toEqual({
            route: "update_settings",
            args: [{ ...TEST_SETTINGS, enabled: false }],
        });
    });

    it("rejects malformed settings payloads instead of passing them into the app", async () => {
        const transport = new FakeDeckyTransport();
        transport.callResponses.set("get_settings", { schemaVersion: 99 });
        const adapter = new DeckySettingsAdapter(new DeckyBackendClient(transport));

        await expect(adapter.load()).rejects.toBeInstanceOf(Error);
    });

    it("refuses to save a malformed settings document", async () => {
        const transport = new FakeDeckyTransport();
        const adapter = new DeckySettingsAdapter(new DeckyBackendClient(transport));
        const malformed = { ...TEST_SETTINGS, modelId: "giant" } as unknown as typeof TEST_SETTINGS;

        await expect(adapter.save(malformed)).rejects.toBeInstanceOf(Error);
        expect(transport.calls).toHaveLength(0);
    });
});

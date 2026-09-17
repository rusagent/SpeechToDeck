/**
 * Decky adapter contract tests (spec §30/§67/§99): the frozen callable/event
 * names travel verbatim, backend payloads are guarded before they reach the
 * application, and unvalidated payloads are dropped instead of passed on.
 */

import { describe, expect, it } from "vitest";
import { DeckyBackendClient } from "../../src/infrastructure/decky/DeckyBackendClient";
import { DeckySpeechAdapter } from "../../src/infrastructure/decky/DeckySpeechAdapter";
import { DeckySettingsAdapter } from "../../src/infrastructure/decky/DeckySettingsAdapter";
import { DictationError } from "../../src/domain/DictationError";
import type { LogEntry } from "../../src/shared/Logger";
import { Logger } from "../../src/shared/Logger";
import { SETUP_SNAPSHOTS, FakeDeckyTransport } from "./helpers";
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

    it("maps the backend's versioned runtime_status payloads onto typed events", async () => {
        const transport = new FakeDeckyTransport();
        const adapter = new DeckySpeechAdapter(new DeckyBackendClient(transport));
        const received: { type: string; status?: string }[] = [];
        adapter.subscribe((event) => received.push(event));

        // Supervisor payloads (§37) and daemon/monitor payloads (§41) with
        // their real state vocabularies.
        transport.emit("runtime_status", {
            protocolVersion: 1,
            available: true,
            state: "starting",
            pid: 4242,
        });
        transport.emit("runtime_status", { protocolVersion: 1, available: true, state: "idle" });
        transport.emit("runtime_status", {
            protocolVersion: 1,
            available: true,
            state: "recording",
        });
        transport.emit("runtime_status", {
            protocolVersion: 1,
            available: false,
            state: "crashed",
        });
        transport.emit("runtime_status", { protocolVersion: 1, available: true, state: "error" });
        transport.emit("runtime_status", {
            protocolVersion: 1,
            available: true,
            state: "restarted",
        });
        transport.emit("runtime_status", {
            protocolVersion: 1,
            available: false,
            state: "unavailable",
            detail: "restart policy exhausted",
        });
        transport.emit("runtime_status", {
            protocolVersion: 1,
            available: false,
            state: "stopped",
        });
        // Unknown state and wrong protocol version are dropped (§99).
        transport.emit("runtime_status", { protocolVersion: 1, state: "exploded" });
        transport.emit("runtime_status", { protocolVersion: 2, state: "idle" });

        expect(received).toEqual([
            { type: "runtime-status", status: "starting" },
            { type: "runtime-status", status: "ready" },
            { type: "runtime-status", status: "ready" },
            { type: "runtime-status", status: "crashed" },
            { type: "runtime-status", status: "crashed" },
            { type: "runtime-status", status: "ready" },
            { type: "runtime-status", status: "unavailable" },
            { type: "runtime-status", status: "unavailable" },
        ]);
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
            "setup_progress",
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

    it("publishes guarded setup_progress payloads to the dedicated store, not the dictation stream", () => {
        const transport = new FakeDeckyTransport();
        const adapter = new DeckySpeechAdapter(new DeckyBackendClient(transport));
        const speechEvents: string[] = [];
        adapter.subscribe((event) => speechEvents.push(event.type)); // arms the backend subscriptions

        transport.emit("setup_progress", SETUP_SNAPSHOTS.download);

        expect(adapter.setupProgress.getSnapshot()).toEqual(SETUP_SNAPSHOTS.download);
        expect(speechEvents).toEqual([]); // setup progress stays out of the §29 events
    });

    it("drops invalid setup_progress payloads count-logged instead of rendering them", () => {
        const entries: LogEntry[] = [];
        const transport = new FakeDeckyTransport();
        const adapter = new DeckySpeechAdapter(
            new DeckyBackendClient(transport),
            new Logger("speech.runtime", (entry) => entries.push(entry)),
        );
        adapter.subscribe(() => undefined);

        transport.emit("setup_progress", { garbage: true });
        transport.emit("setup_progress", { ...SETUP_SNAPSHOTS.download, percent: 137 });

        expect(adapter.setupProgress.getSnapshot()).toBeNull();
        const warnings = entries.filter((entry) => entry.message.includes("setup_progress"));
        expect(warnings).toHaveLength(2);
        expect(warnings.map((entry) => entry.fields.dropped)).toEqual([1, 2]);
    });

    it("unsubscribes setup_progress in the existing shutdown path (§83)", async () => {
        const transport = new FakeDeckyTransport();
        const adapter = new DeckySpeechAdapter(new DeckyBackendClient(transport));
        adapter.subscribe(() => undefined);

        await adapter.shutdown();
        transport.emit("setup_progress", SETUP_SNAPSHOTS.download);

        expect(adapter.setupProgress.getSnapshot()).toBeNull();
        expect(transport.removedListeners.map((entry) => entry.event)).toContain("setup_progress");
    });
});

describe("DeckyBackendClient coded-result envelope (§68)", () => {
    it("unwraps the backend's {ok: true, ...} result and drops the envelope flag", async () => {
        const transport = new FakeDeckyTransport();
        transport.callResponses.set("get_settings", { ok: true, ...TEST_SETTINGS });
        const client = new DeckyBackendClient(transport);

        await expect(client.call("get_settings")).resolves.toEqual(TEST_SETTINGS);
    });

    it("throws a stable §68 DictationError for a coded {ok: false} failure", async () => {
        const transport = new FakeDeckyTransport();
        transport.callResponses.set("start_recording", {
            ok: false,
            protocolVersion: 1,
            code: "RUNTIME_UNAVAILABLE",
            detail: "native runtime is not running",
        });
        const client = new DeckyBackendClient(transport);

        await expect(client.call("start_recording", "session-1")).rejects.toMatchObject({
            code: "RUNTIME_UNAVAILABLE",
            message: "native runtime is not running",
        });
    });

    it("maps an unknown failure code onto INTERNAL_ERROR", async () => {
        const transport = new FakeDeckyTransport();
        transport.callResponses.set("restart_runtime", { ok: false, code: "MYSTERY" });
        const client = new DeckyBackendClient(transport);

        const error = await client.call("restart_runtime").catch((caught: unknown) => caught);
        expect(error).toBeInstanceOf(DictationError);
        expect(error).toMatchObject({ code: "INTERNAL_ERROR" });
    });

    it("passes non-envelope payloads through unchanged", async () => {
        const transport = new FakeDeckyTransport();
        transport.callResponses.set("get_capabilities", { custom: true });
        const client = new DeckyBackendClient(transport);

        await expect(client.call("get_capabilities")).resolves.toEqual({ custom: true });
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
        // §55: schemaVersion is backend-owned and never travels in the update.
        expect(transport.calls[1]).toEqual({
            route: "update_settings",
            args: [
                {
                    enabled: false,
                    computeBackend: TEST_SETTINGS.computeBackend,
                    modelId: TEST_SETTINGS.modelId,
                    language: TEST_SETTINGS.language,
                    maxRecordingSeconds: TEST_SETTINGS.maxRecordingSeconds,
                    vadEnabled: TEST_SETTINGS.vadEnabled,
                    outputMode: TEST_SETTINGS.outputMode,
                },
            ],
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

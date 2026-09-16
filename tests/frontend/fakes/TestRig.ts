import { expect } from "vitest";

import { DictationController } from "../../../src/application/DictationController";
import type { PluginSettings } from "../../../src/application/ports/SettingsPort";
import { FakeBulkTextInserter } from "./FakeBulkTextInserter";
import { FakeClock } from "./FakeClock";
import { FakeIdGenerator } from "./FakeIdGenerator";
import { FakeKeyboardHost } from "./FakeKeyboardHost";
import { FakeSettingsPort } from "./FakeSettingsPort";
import { FakeSpeechPort } from "./FakeSpeechPort";

export interface TestRig {
    readonly controller: DictationController;
    readonly speech: FakeSpeechPort;
    readonly keyboard: FakeKeyboardHost;
    readonly inserter: FakeBulkTextInserter;
    readonly settings: FakeSettingsPort;
    readonly clock: FakeClock;
    readonly ids: FakeIdGenerator;
    /** Shared ordered call log across every fake, for ordering assertions. */
    readonly trace: string[];
}

export function createTestRig(settingsOverride?: Partial<PluginSettings>): TestRig {
    const trace: string[] = [];
    const speech = new FakeSpeechPort(trace);
    const keyboard = new FakeKeyboardHost(trace);
    const inserter = new FakeBulkTextInserter(trace);
    const settings = new FakeSettingsPort();
    settings.value = { ...settings.value, ...settingsOverride };
    const clock = new FakeClock();
    const ids = new FakeIdGenerator();
    const controller = new DictationController(speech, keyboard, inserter, settings, clock, ids);
    return { controller, speech, keyboard, inserter, settings, clock, ids, trace };
}

/**
 * Drains pending microtasks and macrotask hops without wall-clock sleeps:
 * controller effect chains settle entirely between macrotask boundaries.
 */
export async function flush(): Promise<void> {
    for (let hop = 0; hop < 6; hop += 1) {
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
        });
    }
}

/** Startup to `ready`, with a keyboard context open. */
export async function startReady(rig: TestRig): Promise<void> {
    rig.keyboard.open();
    await rig.controller.start();
    expect(rig.controller.getSnapshot().kind).toBe("ready");
}

/** Press-to-acknowledged-recording; returns the session id. */
export async function startRecording(rig: TestRig): Promise<string> {
    await rig.controller.handleMicrophonePressed();
    await flush();
    const sessionId = "id-1";
    expect(rig.controller.getSnapshot()).toMatchObject({
        kind: "starting",
        session: { sessionId },
    });
    rig.speech.resolveStart(sessionId);
    await flush();
    expect(rig.controller.getSnapshot().kind).toBe("recording");
    return sessionId;
}

/** Recording → stopping → acknowledged transcription; returns the session id. */
export async function startTranscribing(rig: TestRig): Promise<string> {
    const sessionId = await startRecording(rig);
    await rig.controller.handleMicrophonePressed();
    await flush();
    expect(rig.controller.getSnapshot().kind).toBe("stopping");
    rig.speech.resolveStop(sessionId);
    await flush();
    expect(rig.controller.getSnapshot().kind).toBe("transcribing");
    return sessionId;
}

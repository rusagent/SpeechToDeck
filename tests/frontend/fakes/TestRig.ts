import { expect } from "vitest";

import { DictationController } from "../../../src/application/DictationController";
import type { PluginSettings } from "../../../src/application/ports/SettingsPort";
import { FakeClipboardPort } from "./FakeClipboardPort";
import { FakeClock } from "./FakeClock";
import { FakeIdGenerator } from "./FakeIdGenerator";
import { FakeSettingsPort } from "./FakeSettingsPort";
import { FakeSpeechPort } from "./FakeSpeechPort";

export interface TestRig {
    readonly controller: DictationController;
    readonly speech: FakeSpeechPort;
    readonly clipboard: FakeClipboardPort;
    readonly settings: FakeSettingsPort;
    readonly clock: FakeClock;
    readonly ids: FakeIdGenerator;
    readonly trace: string[];
}

export function createTestRig(settingsOverride?: Partial<PluginSettings>): TestRig {
    const trace: string[] = [];
    const speech = new FakeSpeechPort(trace);
    const clipboard = new FakeClipboardPort(trace);
    const settings = new FakeSettingsPort();
    settings.value = { ...settings.value, ...settingsOverride };
    const clock = new FakeClock();
    const ids = new FakeIdGenerator();
    const controller = new DictationController(speech, clipboard, settings, clock, ids);
    return { controller, speech, clipboard, settings, clock, ids, trace };
}

export async function flush(): Promise<void> {
    for (let hop = 0; hop < 6; hop += 1) {
        await new Promise<void>((resolve) => {
            setTimeout(resolve, 0);
        });
    }
}

export async function startReady(rig: TestRig): Promise<void> {
    await rig.controller.start();
    expect(rig.controller.getSnapshot().kind).toBe("ready");
}

export async function startRecording(rig: TestRig): Promise<string> {
    await rig.controller.handlePanelMicrophonePressed();
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

export async function startTranscribing(rig: TestRig): Promise<string> {
    const sessionId = await startRecording(rig);
    await rig.controller.handlePanelMicrophonePressed();
    await flush();
    expect(rig.controller.getSnapshot().kind).toBe("stopping");
    rig.speech.resolveStop(sessionId);
    await flush();
    expect(rig.controller.getSnapshot().kind).toBe("transcribing");
    return sessionId;
}

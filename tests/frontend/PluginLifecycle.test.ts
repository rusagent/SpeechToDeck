/**
 * PluginLifecycle tests (spec §82/§83/§84): startup delegation, §83 unload
 * sequence executed through §84 reverse-order disposal, idempotent dispose,
 * and teardown failure containment.
 */

import { describe, expect, it } from "vitest";

import { DictationController } from "../../src/application/DictationController";
import { PluginLifecycle } from "../../src/application/PluginLifecycle";
import { createTestRig, flush, type TestRig } from "./fakes/TestRig";

class TracingController extends DictationController {
    disposeCount = 0;
    disposeError: Error | null = null;

    constructor(private readonly ownedRig: TestRig) {
        super(
            ownedRig.speech,
            ownedRig.keyboard,
            ownedRig.inserter,
            ownedRig.settings,
            ownedRig.clock,
            ownedRig.ids,
        );
    }

    override async dispose(): Promise<void> {
        this.disposeCount += 1;
        this.ownedRig.trace.push("controller.dispose");
        if (this.disposeError !== null) {
            throw this.disposeError;
        }
        await super.dispose();
    }
}

function createLifecycleRig(): {
    rig: TestRig;
    controller: TracingController;
    lifecycle: PluginLifecycle;
} {
    const base = createTestRig();
    const controller = new TracingController(base);
    const rig: TestRig = { ...base, controller };
    const lifecycle = new PluginLifecycle(controller, rig.keyboard, rig.speech);
    return { rig, controller, lifecycle };
}

describe("startup (§82)", () => {
    it("a repeated lifecycle.start does not re-run the startup sequence", async () => {
        const { rig, lifecycle } = createLifecycleRig();
        rig.keyboard.open();
        await lifecycle.start();
        await lifecycle.start();

        expect(rig.trace.filter((entry) => entry === "keyboard.start")).toHaveLength(1);
        expect(rig.trace.filter((entry) => entry === "speech.initialize")).toHaveLength(1);
        expect(rig.controller.getSnapshot().kind).toBe("ready");
    });

    it("reaches ready through the lifecycle", async () => {
        const { rig, lifecycle } = createLifecycleRig();
        rig.keyboard.open();
        await lifecycle.start();
        expect(rig.controller.getSnapshot().kind).toBe("ready");
    });
});

describe("unload (§83 via §84 reverse-order disposal)", () => {
    it("disposes controller → keyboard → speech", async () => {
        const { rig, lifecycle } = createLifecycleRig();
        rig.keyboard.open();
        await lifecycle.start();

        await lifecycle.dispose();

        const sequenced = rig.trace.filter((entry) =>
            ["controller.dispose", "keyboard.stop", "speech.shutdown"].includes(entry),
        );
        expect(sequenced).toEqual(["controller.dispose", "keyboard.stop", "speech.shutdown"]);
    });

    it("is idempotent: a second dispose runs nothing again", async () => {
        const { rig, controller, lifecycle } = createLifecycleRig();
        await lifecycle.dispose();
        await lifecycle.dispose();

        expect(controller.disposeCount).toBe(1);
        expect(rig.trace.filter((entry) => entry === "keyboard.stop")).toHaveLength(1);
        expect(rig.trace.filter((entry) => entry === "speech.shutdown")).toHaveLength(1);
    });

    it("works without start: every cleanup operation is idempotent (§83)", async () => {
        const { rig, lifecycle } = createLifecycleRig();
        await lifecycle.dispose();
        expect(rig.trace).toContain("controller.dispose");
        expect(rig.trace).toContain("keyboard.stop");
        expect(rig.trace).toContain("speech.shutdown");
    });

    it("a failing step does not block the remaining teardown", async () => {
        const { rig, controller, lifecycle } = createLifecycleRig();
        controller.disposeError = new Error("cancel exploded");

        await lifecycle.dispose();
        await flush();

        expect(rig.trace).toContain("keyboard.stop");
        expect(rig.trace).toContain("speech.shutdown");
    });
});

/**
 * TabBridgePasteActionAdapter contract tests (v0.1.7, §24 fallback step 5).
 *
 * Decision points (owner-approved Task 5 coverage):
 * - the single native paste is invoked in the keyboard document ONLY on the
 *   still-current context (fail-closed otherwise, §26/§24);
 * - a declined in-window paste is a controlled PASTE_ACTION_UNAVAILABLE error,
 *   not an exception leak;
 * - the probe never pastes — it reports mechanism recognition only (§57).
 */

import { describe, expect, it } from "vitest";

import { TabBridgePasteActionAdapter } from "../../src/infrastructure/steam/TabBridgePasteActionAdapter";
import { DictationError } from "../../src/domain/DictationError";
import type { KeyboardContext } from "../../src/domain/DictationSession";

function context(id: string): KeyboardContext {
    return { id, windowToken: "sp-tab", visible: true };
}

class StubPasteBridge {
    currentId: string | null = "vk-1-id-1";
    pasteOutcome: boolean = true;
    probeOutcome: boolean = true;
    pasteCalls = 0;

    currentContext(): KeyboardContext | null {
        return this.currentId === null ? null : context(this.currentId);
    }

    async invokePaste(): Promise<boolean> {
        this.pasteCalls += 1;
        return this.pasteOutcome;
    }

    async probePasteMechanism(): Promise<boolean> {
        return this.probeOutcome;
    }
}

describe("TabBridgePasteActionAdapter", () => {
    it("invokes exactly one paste on the current context", async () => {
        const bridge = new StubPasteBridge();
        const adapter = new TabBridgePasteActionAdapter(bridge);

        await expect(adapter.invokePaste(context("vk-1-id-1"))).resolves.toBeUndefined();
        expect(bridge.pasteCalls).toBe(1);
    });

    it("fails closed with KEYBOARD_CONTEXT_CHANGED for a stale context", async () => {
        const bridge = new StubPasteBridge();
        bridge.currentId = "vk-2-id-2";
        const adapter = new TabBridgePasteActionAdapter(bridge);

        const promise = adapter.invokePaste(context("vk-1-id-1"));
        await expect(promise).rejects.toMatchObject({ code: "KEYBOARD_CONTEXT_CHANGED" });
        expect(bridge.pasteCalls).toBe(0);
    });

    it("maps a declined paste to PASTE_ACTION_UNAVAILABLE", async () => {
        const bridge = new StubPasteBridge();
        bridge.pasteOutcome = false;
        const adapter = new TabBridgePasteActionAdapter(bridge);

        await expect(adapter.invokePaste(context("vk-1-id-1"))).rejects.toMatchObject({
            code: "PASTE_ACTION_UNAVAILABLE",
        });
    });

    it("probes mechanism recognition without pasting", async () => {
        const bridge = new StubPasteBridge();
        bridge.probeOutcome = true;
        const adapter = new TabBridgePasteActionAdapter(bridge);

        await expect(adapter.probe(context("vk-1-id-1"))).resolves.toEqual({ available: true });
        expect(bridge.pasteCalls).toBe(0);

        bridge.probeOutcome = false;
        await expect(adapter.probe(context("vk-1-id-1"))).resolves.toEqual({ available: false });
        expect(bridge.pasteCalls).toBe(0);
    });

    it("keeps DictationError as the failure transport", async () => {
        const bridge = new StubPasteBridge();
        bridge.currentId = null;
        const adapter = new TabBridgePasteActionAdapter(bridge);

        const error = await adapter.invokePaste(context("vk-1-id-1")).catch((caught) => caught);
        expect(error).toBeInstanceOf(DictationError);
    });
});

/**
 * KeyboardBridgeInserter contract tests (v0.1.7, Task 5/§24 reading).
 *
 * Decision points (owner-approved Task 5 coverage):
 * - the bridge one-payload path is PRIMARY: success short-circuits the §24
 *   clipboard+paste fallback (no clipboard write, no paste);
 * - the §24 fallback runs ONLY when the bridge insertion declines or the
 *   context is no longer current (see IMPLEMENTATION_STATUS.md §2.2 reading);
 * - text validation happens once, before any path (§24 step 1 / §78).
 */

import { describe, expect, it } from "vitest";

import { KeyboardBridgeInserter } from "../../src/infrastructure/steam/KeyboardBridgeInserter";
import type { KeyboardContext } from "../../src/domain/DictationSession";
import type {
    BulkInsertResult,
    BulkTextInserter,
} from "../../src/application/ports/BulkTextInserter";
import { err, ok } from "../../src/domain/Result";
import { DictationError } from "../../src/domain/DictationError";

function context(id: string): KeyboardContext {
    return { id, windowToken: "sp-tab", visible: true };
}

class StubBridge {
    currentId: string | null = "vk-1-id-1";
    insertOutcome: boolean | Error = true;
    readonly insertTexts: string[] = [];

    currentContext(): KeyboardContext | null {
        return this.currentId === null ? null : context(this.currentId);
    }

    async insertText(text: string): Promise<boolean> {
        this.insertTexts.push(text);
        if (this.insertOutcome instanceof Error) {
            throw this.insertOutcome;
        }
        return this.insertOutcome;
    }
}

class StubFallback implements BulkTextInserter {
    readonly insertCalls: { contextId: string; text: string }[] = [];
    outcome: BulkInsertResult = ok(undefined);

    async probe(): Promise<import("../../src/domain/Capability").BulkInsertionCapability> {
        return {
            available: true,
            directInsert: true,
            clipboardOnly: false,
            maxTextBytes: 16384,
        };
    }

    async insert(insertContext: KeyboardContext, text: string): Promise<BulkInsertResult> {
        this.insertCalls.push({ contextId: insertContext.id, text });
        return this.outcome;
    }
}

describe("KeyboardBridgeInserter path selection", () => {
    it("short-circuits on bridge success — the §24 fallback stays untouched", async () => {
        const bridge = new StubBridge();
        const fallback = new StubFallback();
        const inserter = new KeyboardBridgeInserter(bridge, fallback);

        const result = await inserter.insert(context("vk-1-id-1"), "Hallo Welt");

        expect(result).toEqual(ok(undefined));
        expect(bridge.insertTexts).toEqual(["Hallo Welt"]);
        expect(fallback.insertCalls).toEqual([]);
    });

    it("takes the §24 clipboard+paste path only when the bridge declines", async () => {
        const bridge = new StubBridge();
        const fallback = new StubFallback();
        const inserter = new KeyboardBridgeInserter(bridge, fallback);
        bridge.insertOutcome = false;

        await inserter.insert(context("vk-1-id-1"), "zweiter Versuch");

        expect(bridge.insertTexts).toEqual(["zweiter Versuch"]);
        expect(fallback.insertCalls).toEqual([{ contextId: "vk-1-id-1", text: "zweiter Versuch" }]);
    });

    it("skips the bridge entirely when the context is no longer current", async () => {
        const bridge = new StubBridge();
        bridge.currentId = "vk-2-id-2"; // a newer appearance owns the window now
        const fallback = new StubFallback();
        const inserter = new KeyboardBridgeInserter(bridge, fallback);

        await inserter.insert(context("vk-1-id-1"), "veraltet");

        expect(bridge.insertTexts).toEqual([]);
        expect(fallback.insertCalls).toEqual([{ contextId: "vk-1-id-1", text: "veraltet" }]);
    });

    it("propagates the fallback verdict when the §24 path also fails", async () => {
        const bridge = new StubBridge();
        bridge.insertOutcome = new Error("transport down");
        const fallback = new StubFallback();
        fallback.outcome = err(new DictationError("PASTE_ACTION_UNAVAILABLE"));
        const inserter = new KeyboardBridgeInserter(bridge, fallback);

        const result = await inserter.insert(context("vk-1-id-1"), "Hallo");

        expect(result.ok).toBe(false);
        expect(result.ok === false && result.error.code).toBe("PASTE_ACTION_UNAVAILABLE");
    });

    it("rejects invalid text before touching any path (§24 step 1)", async () => {
        const bridge = new StubBridge();
        const fallback = new StubFallback();
        const inserter = new KeyboardBridgeInserter(bridge, fallback);

        const result = await inserter.insert(context("vk-1-id-1"), "");

        expect(result.ok).toBe(false);
        expect(result.ok === false && result.error.code).toBe("TRANSCRIPT_INVALID");
        expect(bridge.insertTexts).toEqual([]);
        expect(fallback.insertCalls).toEqual([]);
    });

    it("delegates the capability probe to the §24 mechanisms", async () => {
        const bridge = new StubBridge();
        const fallback = new StubFallback();
        const inserter = new KeyboardBridgeInserter(bridge, fallback);

        const capability = await inserter.probe(context("vk-1-id-1"));

        expect(capability.directInsert).toBe(true);
        expect(capability.available).toBe(true);
    });
});

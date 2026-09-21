import { beforeEach, describe, expect, it } from "vitest";
import {
    LOADER_IMPORT_EVENT,
    LOADER_RELOAD_ROUTE,
    SELF_HEAL_PLUGIN_NAME,
    DeckySelfHeal,
    resetDeckySelfHealForTests,
} from "../../src/infrastructure/decky/DeckySelfHeal";
import { FakeDeckyTransport } from "./helpers";

describe("DeckySelfHeal", () => {
    beforeEach(() => {
        resetDeckySelfHealForTests();
    });

    it("fires the loader reload exactly once after two consecutive timeouts", () => {
        const transport = new FakeDeckyTransport();
        const heal = new DeckySelfHeal(transport);

        expect(heal.reportLoadOutcome("timeout", { canReload: true })).toBe(false);
        expect(transport.calls).toEqual([]);
        expect(heal.reportLoadOutcome("timeout", { canReload: true })).toBe(true);

        expect(transport.calls).toEqual([
            { route: LOADER_RELOAD_ROUTE, args: [SELF_HEAL_PLUGIN_NAME] },
        ]);
    });

    it("never fires on coded replies: a rejection or success resets the streak", () => {
        const transport = new FakeDeckyTransport();
        const heal = new DeckySelfHeal(transport);

        heal.reportLoadOutcome("timeout", { canReload: true });
        expect(heal.reportLoadOutcome("rejected", { canReload: true })).toBe(false);
        heal.reportLoadOutcome("timeout", { canReload: true });
        expect(heal.reportLoadOutcome("success", { canReload: true })).toBe(false);
        expect(transport.calls).toEqual([]);
    });

    it("latches per module session: no second reload, even from a fresh instance", () => {
        const transport = new FakeDeckyTransport();
        const first = new DeckySelfHeal(transport);
        first.reportLoadOutcome("timeout", { canReload: true });
        expect(first.reportLoadOutcome("timeout", { canReload: true })).toBe(true);
        expect(transport.calls).toHaveLength(1);

        const second = new DeckySelfHeal(transport);
        expect(second.reportLoadOutcome("timeout", { canReload: true })).toBe(false);
        expect(second.reportLoadOutcome("timeout", { canReload: true })).toBe(false);
        expect(transport.calls).toHaveLength(1);
    });

    it("holds the reload while a gate is closed and fires at the first clear report", () => {
        const transport = new FakeDeckyTransport();
        const heal = new DeckySelfHeal(transport);

        expect(heal.reportLoadOutcome("timeout", { canReload: false })).toBe(false);
        expect(heal.reportLoadOutcome("timeout", { canReload: false })).toBe(false);
        expect(transport.calls).toEqual([]);

        expect(heal.reportLoadOutcome("timeout", { canReload: true })).toBe(true);
        expect(transport.calls).toHaveLength(1);
    });

    it("fans the loader re-import out to subscribers and resets the streak", () => {
        const transport = new FakeDeckyTransport();
        const heal = new DeckySelfHeal(transport);
        let imports = 0;
        const unsubscribe = heal.onImportPlugin(() => {
            imports += 1;
        });

        heal.reportLoadOutcome("timeout", { canReload: true });
        transport.emit(LOADER_IMPORT_EVENT, "SpeechToDeck");
        expect(imports).toBe(1);
        expect(heal.reportLoadOutcome("timeout", { canReload: true })).toBe(false);

        unsubscribe();
        transport.emit(LOADER_IMPORT_EVENT, "SpeechToDeck");
        expect(imports).toBe(1);
    });

    it("registers exactly one loader listener no matter how often panels subscribe", () => {
        const transport = new FakeDeckyTransport();
        const heal = new DeckySelfHeal(transport);
        const unsubscribeA = heal.onImportPlugin(() => undefined);
        const unsubscribeB = heal.onImportPlugin(() => undefined);
        expect(transport.listenerCount(LOADER_IMPORT_EVENT)).toBe(1);

        unsubscribeA();
        unsubscribeB();
        expect(transport.listenerCount(LOADER_IMPORT_EVENT)).toBe(1);
    });
});

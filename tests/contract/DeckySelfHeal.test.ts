/**
 * DeckySelfHeal contract tests (self-heal after a torn loader install).
 *
 * Named production defect: loader v3.2.9 UI reinstalls can orphan the
 * frontend→backend call channel — the settings load never settles (no coded
 * reply) and store users were stuck with a dead panel. The self-heal must
 * fire the loader reload on exactly the wedged signature (TWO consecutive
 * full-deadline timeouts, gates clear), exactly ONCE per frontend module
 * session, and re-arm on the loader's re-import broadcast. Oracle: the
 * recorded transport call (route + args) and the listener fan-out of the
 * injected FakeDeckyTransport.
 */

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

        // The latch is module state: another panel mount (a new instance) in
        // the same frontend module session can never reload again — this is
        // the no-loop guarantee.
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

        // Two full deadlines already elapsed; the first report with clear
        // gates is the earliest moment every trigger condition holds.
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
        // The re-import proves a fresh backend: the streak restarted.
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
        // The panel listeners are gone; the idempotent loader listener stays
        // registered for the next mount (module-session lifetime).
        expect(transport.listenerCount(LOADER_IMPORT_EVENT)).toBe(1);
    });
});

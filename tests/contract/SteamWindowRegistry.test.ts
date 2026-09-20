/**
 * SteamWindowRegistry contract tests (live-probe-driven).
 *
 * Decision points, each named against the live SharedJSContext probe evidence
 * ("LIVE SharedJSContext probe findings"):
 *
 * - the verified m_WindowStore map chain resolves window instances and their
 *   managers (Map/object containers), with capability checking (an instance
 *   whose manager lacks a callable lifecycle method is skipped);
 * - chain fallbacks (SteamUIWindows array, SteamUIStore.Windows,
 *   DEBUG_GetDesiredSteamUIWindows()) each satisfy `registryFound`;
 * - a missing or empty store resolves to `registryFound: false` with no
 *   entries — fail closed, never throw;
 * - the document accessor chain resolves `m_BrowserWindow.document` and
 *   method candidates, recording WHICH accessor won (the open on-device
 *   question is settled by journal evidence, not optimism).
 */

import { afterEach, describe, expect, it } from "vitest";
import { createManagerStub } from "../fixtures/steam-keyboard-dom";
import { SteamWindowRegistry } from "../../src/infrastructure/steam/SteamWindowRegistry";

interface GlobalsWithRegistry {
    SteamUIStore?: unknown;
    SteamUIWindows?: unknown;
    DEBUG_GetDesiredSteamUIWindows?: unknown;
}

function globals(): GlobalsWithRegistry {
    return window as unknown as GlobalsWithRegistry;
}

function setStore(store: unknown): void {
    globals().SteamUIStore = store;
}

function instanceWith(manager: object, overrides: Record<string, unknown> = {}): object {
    return {
        WindowName: "SP",
        m_VirtualKeyboardManager: manager,
        m_BrowserWindow: { document },
        ...overrides,
    };
}

describe("SteamWindowRegistry", () => {
    afterEach(() => {
        // Registry chains read window globals: isolate every test.
        delete globals().SteamUIStore;
        delete globals().SteamUIWindows;
        delete globals().DEBUG_GetDesiredSteamUIWindows;
    });

    it("enumerates the verified m_WindowStore map chain with capability checks", () => {
        const good = createManagerStub();
        const broken = { SetVirtualKeyboardVisible: () => undefined }; // missing hidden
        setStore({
            m_WindowStore: {
                m_mapAppWindows: new Map([
                    [1, instanceWith(good)],
                    [2, instanceWith(broken, { WindowName: "QuickAccess_uid2" })],
                ]),
                m_mapDesiredWindows: new Map(),
                m_mapDesiredWindowInstances: new Map(),
                m_mapOverlayPopupByPID: new Map(),
                m_setSuppressedWindowTypes: new Set(),
            },
        });

        const snapshot = new SteamWindowRegistry().enumerate();

        expect(snapshot.registryFound).toBe(true);
        expect(snapshot.storeKeysWalked).toContain("SteamUIStore.m_WindowStore");
        expect(snapshot.storeKeysWalked).toContain("m_WindowStore.m_mapAppWindows");
        expect(snapshot.instancesInspected).toBe(2);
        expect(snapshot.managersFound).toBe(1); // the broken manager is skipped
        expect(snapshot.documentsResolved).toBe(1);
        expect(snapshot.entries).toHaveLength(1);
        expect(snapshot.entries[0]).toMatchObject({
            token: "SP",
            manager: good,
            documentAccessor: "m_BrowserWindow.document",
        });
        expect(snapshot.entries[0]?.document).toBe(document);
    });

    it("accepts the SteamUIWindows array fallback chain", () => {
        delete globals().SteamUIStore;
        const manager = createManagerStub();
        globals().SteamUIWindows = [instanceWith(manager)];

        const snapshot = new SteamWindowRegistry().enumerate();

        expect(snapshot.registryFound).toBe(true);
        expect(snapshot.storeKeysWalked).toContain("SteamUIWindows");
        expect(snapshot.entries[0]?.manager).toBe(manager);
    });

    it("accepts the SteamUIStore.Windows fallback chain", () => {
        const manager = createManagerStub();
        setStore({ Windows: { SP: instanceWith(manager) } });

        const snapshot = new SteamWindowRegistry().enumerate();

        expect(snapshot.registryFound).toBe(true);
        expect(snapshot.storeKeysWalked).toContain("SteamUIStore.Windows");
        expect(snapshot.entries[0]?.token).toBe("SP");
    });

    it("accepts the DEBUG_GetDesiredSteamUIWindows() accessor chain", () => {
        delete globals().SteamUIStore;
        const manager = createManagerStub();
        globals().DEBUG_GetDesiredSteamUIWindows = () => ({ SP: instanceWith(manager) });

        const snapshot = new SteamWindowRegistry().enumerate();

        expect(snapshot.registryFound).toBe(true);
        expect(snapshot.storeKeysWalked).toContain("DEBUG_GetDesiredSteamUIWindows()");
        expect(snapshot.entries[0]?.manager).toBe(manager);
    });

    it("resolves the document through a GetDocument() method when no property exists", () => {
        const manager = createManagerStub();
        setStore({
            m_WindowStore: {
                m_mapAppWindows: new Map([
                    [
                        1,
                        instanceWith(manager, {
                            m_BrowserWindow: { GetDocument: () => document },
                        }),
                    ],
                ]),
            },
        });

        const snapshot = new SteamWindowRegistry().enumerate();

        expect(snapshot.documentsResolved).toBe(1);
        expect(snapshot.entries[0]?.documentAccessor).toBe("m_BrowserWindow.GetDocument()");
    });

    it("fails closed with an empty snapshot when no store exists", () => {
        delete globals().SteamUIStore;
        delete globals().SteamUIWindows;
        delete globals().DEBUG_GetDesiredSteamUIWindows;

        const snapshot = new SteamWindowRegistry().enumerate();

        expect(snapshot.registryFound).toBe(false);
        expect(snapshot.entries).toEqual([]);
        expect(snapshot.storeKeysWalked).toEqual([]);
    });

    it("reports the empty verified store shape as found-but-without-instances", () => {
        // Live probe finding: with the keyboard closed the maps exist but the
        // transient window instances are gone.
        setStore({
            m_WindowStore: {
                m_mapAppWindows: new Map(),
                m_mapDesiredWindows: new Map(),
                m_mapDesiredWindowInstances: new Map(),
                m_mapOverlayPopupByPID: new Map(),
                m_setSuppressedWindowTypes: new Set(),
            },
        });

        const snapshot = new SteamWindowRegistry().enumerate();

        expect(snapshot.registryFound).toBe(true);
        expect(snapshot.instancesInspected).toBe(0);
        expect(snapshot.entries).toEqual([]);
    });

    it("never throws when a container value explodes during the walk", () => {
        const hostile = {
            get m_VirtualKeyboardManager(): unknown {
                throw new Error("steam updated the store shape");
            },
        };
        setStore({
            m_WindowStore: { m_mapAppWindows: new Map([[1, hostile]]) },
        });

        const snapshot = new SteamWindowRegistry().enumerate();

        expect(snapshot.registryFound).toBe(true);
        expect(snapshot.entries).toEqual([]);
    });
});

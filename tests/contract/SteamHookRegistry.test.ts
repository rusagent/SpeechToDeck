/**
 * SteamHookRegistry contract tests.
 *
 * Decision points: the lifecycle wrapper contract (args/this/return/exception
 * preserved), restore-only-own-wrapper ownership, and idempotent
 * cleanup — a Steam-update or double-unload regression here breaks other
 * plugins and the Steam keyboard itself.
 */

import { describe, expect, it, vi } from "vitest";
import { SteamHookRegistry } from "../../src/infrastructure/steam/SteamHookRegistry";

function passthroughWrapper(original: (...args: unknown[]) => unknown) {
    return function (this: unknown, ...args: unknown[]) {
        return original.apply(this, args);
    };
}

describe("SteamHookRegistry", () => {
    it("wrapper preserves arguments, this and return value", () => {
        const registry = new SteamHookRegistry();
        const original = vi.fn(function (this: { tag: string }, a: number, b: number) {
            return `${this.tag}:${a + b}`;
        });
        const target = { method: original };

        let seenThisTag: string | undefined;
        let seenArgs: unknown[] = [];
        const hook = registry.install(
            target,
            "method",
            (original) =>
                function (this: { tag?: string }, ...args: unknown[]) {
                    seenThisTag = this.tag; // `this` flows through the wrapper
                    seenArgs = args;
                    return original.apply(this, args);
                },
        );
        expect(hook).not.toBeNull();

        const result = target.method.call({ tag: "ctx" }, 2, 3);

        expect(result).toBe("ctx:5");
        expect(seenThisTag).toBe("ctx");
        expect(seenArgs).toEqual([2, 3]);
        expect(original).toHaveBeenCalledWith(2, 3);
    });

    it("wrapper propagates exceptions of the original untouched", () => {
        const registry = new SteamHookRegistry();
        const failure = new Error("steam internal failure");
        const target = {
            method: vi.fn(() => {
                throw failure;
            }),
        };
        registry.install(target, "method", passthroughWrapper);

        expect(() => target.method()).toThrow(failure);
    });

    it("restore returns the original function only while our wrapper is installed", () => {
        const registry = new SteamHookRegistry();
        const original = vi.fn();
        const target = { method: original };
        const hook = registry.install(target, "method", passthroughWrapper);
        expect(target.method).not.toBe(original);

        hook?.dispose();

        expect(target.method).toBe(original);
    });

    it("does not overwrite a later foreign wrapper on restore", () => {
        const registry = new SteamHookRegistry();
        const original = vi.fn();
        const target = { method: original };
        const hook = registry.install(target, "method", passthroughWrapper);

        const foreignWrapper = vi.fn();
        target.method = foreignWrapper;

        hook?.dispose();

        // Another plugin's modification stays installed.
        expect(target.method).toBe(foreignWrapper);
    });

    it("cleanup is idempotent and restoreAll is repeatable", () => {
        const registry = new SteamHookRegistry();
        const original = vi.fn();
        const target = { method: original };
        const hook = registry.install(target, "method", passthroughWrapper);

        hook?.dispose();
        hook?.dispose();
        registry.restoreAll();
        registry.restoreAll();

        expect(target.method).toBe(original);
        expect(registry.size).toBe(0);
    });

    it("refuses to install twice on the same target property while active", () => {
        const registry = new SteamHookRegistry();
        const target = { method: vi.fn() };
        const first = registry.install(target, "method", passthroughWrapper);
        const second = registry.install(target, "method", passthroughWrapper);

        expect(first).not.toBeNull();
        expect(second).toBeNull();

        first?.dispose();
        expect(registry.install(target, "method", passthroughWrapper)).not.toBeNull();
    });

    it("fails closed on missing, non-callable or non-restorable properties", () => {
        const registry = new SteamHookRegistry();

        expect(registry.install({}, "missing", passthroughWrapper)).toBeNull();
        expect(registry.install({ prop: 42 }, "prop", passthroughWrapper)).toBeNull();

        const frozen = {};
        Object.defineProperty(frozen, "locked", {
            value: vi.fn(),
            writable: false,
            configurable: false,
        });
        expect(registry.install(frozen, "locked", passthroughWrapper)).toBeNull();
    });
});

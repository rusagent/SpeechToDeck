/**
 * Mutex tests (async operation mutex): serialized critical sections,
 * rejection containment, result propagation.
 */

import { describe, expect, it } from "vitest";

import { Deferred } from "../../src/shared/Deferred";
import { Mutex } from "../../src/shared/Mutex";

describe("Mutex (async operation mutex)", () => {
    it("runs queued sections strictly one after another", async () => {
        const mutex = new Mutex();
        const events: string[] = [];
        const firstEntered = new Deferred<void>();
        const releaseFirst = new Deferred<void>();

        const first = mutex.runExclusive(async () => {
            events.push("first:start");
            firstEntered.resolve(undefined);
            await releaseFirst.promise;
            events.push("first:end");
        });

        const second = mutex.runExclusive(async () => {
            events.push("second:start");
            events.push("second:end");
        });

        await firstEntered.promise;
        expect(events).toEqual(["first:start"]);

        releaseFirst.resolve(undefined);
        await Promise.all([first, second]);
        expect(events).toEqual(["first:start", "first:end", "second:start", "second:end"]);
    });

    it("propagates the section result and rejection to its own caller only", async () => {
        const mutex = new Mutex();
        await expect(mutex.runExclusive(() => 42)).resolves.toBe(42);
        await expect(
            mutex.runExclusive(async () => {
                throw new Error("boom");
            }),
        ).rejects.toThrow("boom");
    });

    it("a failed section does not block the next one", async () => {
        const mutex = new Mutex();
        await expect(
            mutex.runExclusive(async () => {
                throw new Error("first failed");
            }),
        ).rejects.toThrow("first failed");
        const order: string[] = [];
        await mutex.runExclusive(async () => {
            order.push("ran");
        });
        expect(order).toEqual(["ran"]);
    });
});

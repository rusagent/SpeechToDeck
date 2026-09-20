/**
 * Async operation mutex.
 *
 * Exactly one critical section runs at a time. Queued sections run after the
 * previous one settles; a failed section neither breaks the chain nor leaks
 * the lock, and its rejection propagates only to its own caller.
 */
export class Mutex {
    private tail: Promise<unknown> = Promise.resolve();

    runExclusive<T>(operation: () => T | Promise<T>): Promise<T> {
        const run = this.tail.then(operation, operation);
        this.tail = run.then(
            () => undefined,
            () => undefined,
        );
        return run;
    }
}

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

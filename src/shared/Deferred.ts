/**
 * A promise with externally callable resolve/reject handles.
 *
 * Used to bridge callback-style port interactions into awaited application
 * flows (and by test fakes) without polling or wall-clock sleeps.
 */
export class Deferred<T> {
    readonly promise: Promise<T>;

    private settled = false;
    private resolveFn!: (value: T | PromiseLike<T>) => void;
    private rejectFn!: (reason?: unknown) => void;

    constructor() {
        this.promise = new Promise<T>((resolve, reject) => {
            this.resolveFn = resolve;
            this.rejectFn = reject;
        });
    }

    resolve(value: T | PromiseLike<T>): void {
        if (this.settled) {
            return;
        }
        this.settled = true;
        this.resolveFn(value);
    }

    reject(reason?: unknown): void {
        if (this.settled) {
            return;
        }
        this.settled = true;
        this.rejectFn(reason);
    }
}

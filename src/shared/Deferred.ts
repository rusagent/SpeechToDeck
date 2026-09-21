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

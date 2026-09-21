import type { ClockPort } from "../../../src/application/ports/ClockPort";

export class FakeClock implements ClockPort {
    private currentMs: number;

    constructor(startMs = 0) {
        this.currentMs = startMs;
    }

    nowMonotonicMs(): number {
        return this.currentMs;
    }

    advance(ms: number): void {
        this.currentMs += ms;
    }
}

import type { ClockPort } from "../../application/ports/ClockPort";

export class SystemClock implements ClockPort {
    nowMonotonicMs(): number {
        if (typeof performance !== "undefined" && typeof performance.now === "function") {
            return performance.now();
        }
        return Date.now();
    }
}

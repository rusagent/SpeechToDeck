/**
 * Monotonic clock port (feeds `startedAtMonotonicMs` and the display-only
 * elapsed timer). Never a wall-clock date: monotonic orderings and durations
 * only.
 */
export interface ClockPort {
    nowMonotonicMs(): number;
}

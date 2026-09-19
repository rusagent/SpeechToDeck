/**
 * Monotonic clock port (spec §7.1 `startedAtMonotonicMs`; also feeds the
 * display-only elapsed timer). Never a wall-clock date: monotonic orderings
 * and durations only.
 */
export interface ClockPort {
    nowMonotonicMs(): number;
}

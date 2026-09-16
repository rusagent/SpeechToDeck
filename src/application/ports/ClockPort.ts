/**
 * Monotonic clock port (spec §7.1 `startedAtMonotonicMs`, §76 max-duration
 * deadline). Never a wall-clock date: monotonic orderings and durations only.
 */
export interface ClockPort {
    nowMonotonicMs(): number;
}

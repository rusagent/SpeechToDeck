/**
 * Domain value object for a dictation session.
 *
 * The session id is generated per press and is the stale-result guard:
 * every acknowledgement, transcript and error carries it, and results for
 * any other session are discarded.
 */

export interface DictationSession {
    readonly sessionId: string;
    readonly startedAtMonotonicMs: number;
}

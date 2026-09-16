/**
 * Domain value objects for sessions and keyboard contexts (spec §7.1/§7.2).
 *
 * A session always belongs to the keyboard context that existed when recording
 * began; every keyboard appearance generates a new context id and a transcript
 * MUST NOT be inserted into a different context.
 */

export interface DictationSession {
    readonly sessionId: string;
    readonly keyboardContextId: string;
    readonly startedAtMonotonicMs: number;
}

export interface KeyboardContext {
    readonly id: string;
    readonly windowToken: string;
    readonly visible: boolean;
}

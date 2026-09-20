/**
 * Domain value objects for sessions and keyboard contexts.
 *
 * A session belongs to the keyboard context that existed when recording
 * began; every keyboard appearance generates a new context id and a
 * transcript MUST NOT be inserted into a different context.
 *
 * `keyboardContextId: null` marks a PANEL/clipboard-flow session started
 * without any keyboard context (the QAM dictation card). Its transcript is
 * never inserted — suppression retains it for the panel and the system
 * clipboard — and a keyboard closing can never cancel it (a null context
 * matches no keyboard context id).
 */

export interface DictationSession {
    readonly sessionId: string;
    readonly keyboardContextId: string | null;
    readonly startedAtMonotonicMs: number;
}

export interface KeyboardContext {
    readonly id: string;
    readonly windowToken: string;
    readonly visible: boolean;
}

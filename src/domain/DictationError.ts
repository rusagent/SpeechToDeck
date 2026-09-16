/**
 * Stable error codes (spec §68) and the §78 transcript validation.
 *
 * UI text maps from codes; frontend logic never parses arbitrary exception
 * strings. The §68 list is illustrative ("Examples"); the two transcript
 * validation codes extend it per §78.
 */

export const DICTATION_ERROR_CODES = [
    "STEAM_KEYBOARD_NOT_FOUND",
    "STEAM_PROFILE_UNSUPPORTED",
    "PASTE_ACTION_UNAVAILABLE",
    "CLIPBOARD_WRITE_FAILED",

    "MICROPHONE_UNAVAILABLE",
    "RUNTIME_START_FAILED",
    "RUNTIME_CRASHED",
    "RECORDING_START_FAILED",
    "RECORDING_STOP_FAILED",
    "TRANSCRIPTION_FAILED",
    "TRANSCRIPTION_TIMEOUT",

    "MODEL_NOT_INSTALLED",
    "MODEL_DOWNLOAD_FAILED",
    "MODEL_CHECKSUM_FAILED",

    "SESSION_CONFLICT",
    "STALE_SESSION",
    "KEYBOARD_CONTEXT_CHANGED",

    "TRANSCRIPT_INVALID",
    "TRANSCRIPT_TOO_LARGE",
] as const;

export type DictationErrorCode = (typeof DICTATION_ERROR_CODES)[number];

export function isDictationErrorCode(value: unknown): value is DictationErrorCode {
    return (
        typeof value === "string" && (DICTATION_ERROR_CODES as readonly string[]).includes(value)
    );
}

/** Maximum supported transcript size in UTF-8 bytes (spec §25/§78: 16 KiB). */
export const MAX_TRANSCRIPT_UTF8_BYTES = 16 * 1024;

export class DictationError extends Error {
    readonly code: DictationErrorCode;

    constructor(code: DictationErrorCode, message?: string, options?: { cause?: unknown }) {
        super(message ?? code, options);
        this.name = "DictationError";
        this.code = code;
    }
}

/**
 * Raised by `validateTranscript` for whitespace-only input. Per spec §77 an
 * empty transcript is not an error state: the caller returns to ready with no
 * clipboard write, no paste and no error.
 */
export class EmptyTranscriptError extends Error {
    constructor() {
        super("Transcript is empty");
        this.name = "EmptyTranscriptError";
    }
}

export class InvalidTranscriptError extends DictationError {
    constructor(message?: string) {
        super("TRANSCRIPT_INVALID", message ?? "Transcript contains invalid characters");
        this.name = "InvalidTranscriptError";
    }
}

export class TranscriptTooLargeError extends DictationError {
    readonly actualBytes: number;

    constructor(actualBytes: number) {
        super(
            "TRANSCRIPT_TOO_LARGE",
            `Transcript exceeds ${MAX_TRANSCRIPT_UTF8_BYTES} UTF-8 bytes (${actualBytes})`,
        );
        this.name = "TranscriptTooLargeError";
        this.actualBytes = actualBytes;
    }
}

/**
 * Transcript validation before insertion — verbatim semantics of spec §78.
 * Returns the trimmed transcript; no character escaping alters valid Unicode.
 */
export function validateTranscript(text: string): string {
    const normalized = text.trim();

    if (normalized.length === 0) {
        throw new EmptyTranscriptError();
    }

    if (normalized.includes("\0")) {
        throw new InvalidTranscriptError();
    }

    const byteLength = new TextEncoder().encode(normalized).byteLength;
    if (byteLength > MAX_TRANSCRIPT_UTF8_BYTES) {
        throw new TranscriptTooLargeError(byteLength);
    }

    return normalized;
}

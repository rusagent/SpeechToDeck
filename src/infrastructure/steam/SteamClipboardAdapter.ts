/**
 * SteamClipboardAdapter.
 *
 * Accepts only the complete transcript string — never chunks. The 16 KiB
 * UTF-8 limit is enforced with the core validation constant; larger
 * transcripts are rejected with the controlled `TRANSCRIPT_TOO_LARGE` error.
 * No clipboard restoration is performed.
 */

import {
    MAX_TRANSCRIPT_UTF8_BYTES,
    DictationError,
    TranscriptTooLargeError,
} from "../../domain/DictationError";
import type { ClipboardCapability } from "../../domain/Capability";
import type { KeyboardContext } from "../../domain/DictationSession";
import type { ClipboardPort } from "../../application/ports/ClipboardPort";

function clipboardWriteMechanism(): ClipboardTextWriter | null {
    if (typeof navigator === "undefined") {
        return null;
    }
    const clipboard = (navigator as Navigator).clipboard;
    if (clipboard === undefined || typeof clipboard.writeText !== "function") {
        return null;
    }
    return clipboard.writeText.bind(clipboard) as ClipboardTextWriter;
}

type ClipboardTextWriter = (text: string) => Promise<void>;

export class SteamClipboardAdapter implements ClipboardPort {
    async probe(context: KeyboardContext): Promise<ClipboardCapability> {
        void context; // mechanism is window-global; the context is caller-verified
        return {
            available: clipboardWriteMechanism() !== null,
            maxTextBytes: MAX_TRANSCRIPT_UTF8_BYTES,
        };
    }

    async writeText(context: KeyboardContext, text: string): Promise<void> {
        void context; // mechanism is window-global; the context is caller-verified
        const writeText = clipboardWriteMechanism();
        if (writeText === null) {
            throw new DictationError(
                "CLIPBOARD_WRITE_FAILED",
                "clipboard write mechanism is unavailable",
            );
        }
        const byteLength = new TextEncoder().encode(text).byteLength;
        if (byteLength > MAX_TRANSCRIPT_UTF8_BYTES) {
            throw new TranscriptTooLargeError(byteLength);
        }
        try {
            await writeText(text); // the complete string, in one call
        } catch (error) {
            throw new DictationError(
                "CLIPBOARD_WRITE_FAILED",
                error instanceof Error ? error.message : String(error),
                {
                    cause: error,
                },
            );
        }
    }
}

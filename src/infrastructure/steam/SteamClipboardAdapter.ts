import {
    MAX_TRANSCRIPT_UTF8_BYTES,
    DictationError,
    TranscriptTooLargeError,
} from "../../domain/DictationError";
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
    async writeText(text: string): Promise<void> {
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
            await writeText(text);
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

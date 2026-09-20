/**
 * Clipboard port: always accepts the complete string, never a chunk.
 * Maximum supported transcript is 16 KiB UTF-8; larger results are rejected
 * with a controlled error by the implementing adapter.
 */

import type { ClipboardCapability } from "../../domain/Capability";
import type { KeyboardContext } from "../../domain/DictationSession";

export interface ClipboardPort {
    probe(context: KeyboardContext): Promise<ClipboardCapability>;

    writeText(context: KeyboardContext, text: string): Promise<void>;
}

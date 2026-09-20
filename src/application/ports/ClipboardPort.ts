/**
 * Clipboard port: always accepts the complete string, never a chunk.
 * Maximum supported transcript is 16 KiB UTF-8; larger results are rejected
 * with a controlled error by the implementing adapter.
 */

export interface ClipboardPort {
    writeText(text: string): Promise<void>;
}

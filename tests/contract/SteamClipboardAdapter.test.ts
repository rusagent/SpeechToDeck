/**
 * SteamClipboardAdapter contract tests: complete-string writes
 * only, 16 KiB UTF-8 limit enforced with the core constant, controlled
 * errors, and honest probing of the write mechanism.
 */

import { describe, expect, it, vi } from "vitest";
import { SteamClipboardAdapter } from "../../src/infrastructure/steam/SteamClipboardAdapter";
import { MAX_TRANSCRIPT_UTF8_BYTES } from "../../src/domain/DictationError";
import type { KeyboardContext } from "../../src/domain/DictationSession";

const CONTEXT: KeyboardContext = { id: "vk-1-abc", windowToken: "steam-ui-window", visible: true };

function stubClipboard(writeText: unknown): {
    restore: () => void;
    writeText: ReturnType<typeof vi.fn>;
} {
    const fn = writeText as ReturnType<typeof vi.fn>;
    const previous = Object.getOwnPropertyDescriptor(navigator, "clipboard");
    Object.defineProperty(navigator, "clipboard", { value: { writeText: fn }, configurable: true });
    return {
        writeText: fn,
        restore: () => {
            if (previous === undefined) {
                // @ts-expect-error test cleanup of a test-installed property
                delete navigator.clipboard;
            } else {
                Object.defineProperty(navigator, "clipboard", previous);
            }
        },
    };
}

describe("SteamClipboardAdapter", () => {
    it("writes the complete transcript in exactly one call, Unicode intact", async () => {
        const clipboard = stubClipboard(vi.fn().mockResolvedValue(undefined));
        const adapter = new SteamClipboardAdapter();
        try {
            const transcript = 'Hällo wörld — ä ö ü ß, "quotes", it\'s fine. 🎙';
            await adapter.writeText(CONTEXT, transcript);
            expect(clipboard.writeText).toHaveBeenCalledTimes(1);
            expect(clipboard.writeText).toHaveBeenCalledWith(transcript);
        } finally {
            clipboard.restore();
        }
    });

    it("rejects transcripts beyond 16 KiB UTF-8 with the controlled error", async () => {
        const clipboard = stubClipboard(vi.fn().mockResolvedValue(undefined));
        const adapter = new SteamClipboardAdapter();
        try {
            const tooLarge = "a".repeat(MAX_TRANSCRIPT_UTF8_BYTES + 1);
            await expect(adapter.writeText(CONTEXT, tooLarge)).rejects.toMatchObject({
                name: "TranscriptTooLargeError",
            });
            expect(clipboard.writeText).not.toHaveBeenCalled();
        } finally {
            clipboard.restore();
        }
    });

    it("probes the mechanism without writing and maps write failures to a stable code", async () => {
        const failing = vi.fn().mockRejectedValue(new Error("clipboard busy"));
        const clipboard = stubClipboard(failing);
        const adapter = new SteamClipboardAdapter();
        try {
            expect(await adapter.probe(CONTEXT)).toEqual({
                available: true,
                maxTextBytes: MAX_TRANSCRIPT_UTF8_BYTES,
            });
            await expect(adapter.writeText(CONTEXT, "text")).rejects.toMatchObject({
                code: "CLIPBOARD_WRITE_FAILED",
            });
        } finally {
            clipboard.restore();
        }
    });

    it("reports unavailable and fails closed when no write mechanism exists", async () => {
        const previous = Object.getOwnPropertyDescriptor(navigator, "clipboard");
        Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
        const adapter = new SteamClipboardAdapter();
        try {
            expect(await adapter.probe(CONTEXT)).toMatchObject({ available: false });
            await expect(adapter.writeText(CONTEXT, "text")).rejects.toMatchObject({
                code: "CLIPBOARD_WRITE_FAILED",
            });
        } finally {
            if (previous === undefined) {
                // @ts-expect-error test cleanup of a test-installed property
                delete navigator.clipboard;
            } else {
                Object.defineProperty(navigator, "clipboard", previous);
            }
        }
    });
});

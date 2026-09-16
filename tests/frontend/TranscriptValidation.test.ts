/**
 * Transcript validation tests — the §78 function is the oracle, verbatim:
 * trim, empty rejection, NUL rejection, 16 KiB UTF-8 exclusive limit, and
 * Unicode preservation.
 */

import { describe, expect, it } from "vitest";

import {
    EmptyTranscriptError,
    InvalidTranscriptError,
    MAX_TRANSCRIPT_UTF8_BYTES,
    TranscriptTooLargeError,
    validateTranscript,
} from "../../src/domain/DictationError";

describe("validateTranscript (spec §78)", () => {
    it("returns the trimmed transcript", () => {
        expect(validateTranscript("  hello world \n")).toBe("hello world");
    });

    it("preserves valid Unicode without escaping", () => {
        const unicode = "ä ö ü Ä Ö Ü ß — “quotes”, it's; colon: ok?";
        expect(validateTranscript(unicode)).toBe(unicode);
    });

    it("throws EmptyTranscriptError for whitespace-only input", () => {
        expect(() => validateTranscript("   ")).toThrow(EmptyTranscriptError);
        expect(() => validateTranscript("")).toThrow(EmptyTranscriptError);
    });

    it("throws InvalidTranscriptError for NUL bytes", () => {
        expect(() => validateTranscript("hello\0world")).toThrow(InvalidTranscriptError);
    });

    it("accepts exactly 16 KiB UTF-8 (limit is exclusive)", () => {
        const atLimit = "a".repeat(MAX_TRANSCRIPT_UTF8_BYTES);
        expect(validateTranscript(atLimit)).toBe(atLimit);

        const multibyteAtLimit = "é".repeat(MAX_TRANSCRIPT_UTF8_BYTES / 2);
        expect(validateTranscript(multibyteAtLimit)).toBe(multibyteAtLimit);
    });

    it("throws TranscriptTooLargeError above 16 KiB UTF-8", () => {
        const overLimit = "a".repeat(MAX_TRANSCRIPT_UTF8_BYTES + 1);
        try {
            validateTranscript(overLimit);
            expect.unreachable("expected TranscriptTooLargeError");
        } catch (error) {
            expect(error).toBeInstanceOf(TranscriptTooLargeError);
            expect((error as TranscriptTooLargeError).code).toBe("TRANSCRIPT_TOO_LARGE");
            expect((error as TranscriptTooLargeError).actualBytes).toBe(
                MAX_TRANSCRIPT_UTF8_BYTES + 1,
            );
        }

        const multibyteOver = "é".repeat(MAX_TRANSCRIPT_UTF8_BYTES / 2 + 1);
        expect(() => validateTranscript(multibyteOver)).toThrow(TranscriptTooLargeError);
    });
});

/**
 * i18n contract tests: EN and DE dictionaries are complete
 * and identical in key coverage, and every stable error code maps to
 * non-empty UI text in both locales.
 */

import { describe, expect, it } from "vitest";
import { DICTATION_ERROR_CODES } from "../../src/domain/DictationError";
import {
    DE_MESSAGES,
    EN_MESSAGES,
    ERROR_MESSAGES,
    MESSAGES,
    detectLocale,
    translateError,
    translateMicLabel,
} from "../../src/presentation/i18n/messages";

describe("i18n dictionaries", () => {
    it("EN and DE expose exactly the same message keys", () => {
        const enKeys = Object.keys(EN_MESSAGES).sort();
        const deKeys = Object.keys(DE_MESSAGES).sort();
        expect(deKeys).toEqual(enKeys);
    });

    it("contains no empty strings in either locale", () => {
        for (const [, dictionary] of Object.entries(MESSAGES)) {
            for (const [key, value] of Object.entries(dictionary)) {
                expect(value.trim().length, `${key} in ${dictionary}`).toBeGreaterThan(0);
            }
        }
    });

    it("contains no em-dash in any locale string (regular dashes only)", () => {
        // Sweep guard for the no-em-dash rule; covers both the
        // general dictionaries and the error texts.
        for (const [locale, dictionary] of Object.entries(MESSAGES)) {
            for (const [key, value] of Object.entries(dictionary)) {
                expect(value, `${key} (${locale})`).not.toContain("—");
            }
        }
        for (const [locale, texts] of Object.entries(ERROR_MESSAGES)) {
            for (const [code, text] of Object.entries(texts)) {
                expect(text, `${code} (${locale})`).not.toContain("—");
            }
        }
    });

    it("maps every stable error code to UI text in both locales", () => {
        for (const code of DICTATION_ERROR_CODES) {
            for (const locale of ["en", "de"] as const) {
                const text = translateError(locale, code);
                expect(text.length, `${code} in ${locale}`).toBeGreaterThan(0);
                expect(text).not.toBe(code); // mapped text, not the raw code
            }
        }
        // The cancellation code reads as a cancel, never as a failure.
        expect(translateError("en", "MODEL_DOWNLOAD_CANCELLED")).not.toContain("failed");
    });

    it("localizes the microphone labels", () => {
        for (const state of ["ready", "recording", "processing", "error"] as const) {
            expect(translateMicLabel("en", state).length).toBeGreaterThan(0);
            expect(translateMicLabel("de", state).length).toBeGreaterThan(0);
        }
    });

    it("labels the model language groups with locale-invariant native endonyms", () => {
        // A language group is labeled in its own language
        // in BOTH UI locales — only the key must exist everywhere (parity
        // gate above).
        const keys = [
            "model.group.lang.de",
            "model.group.lang.en",
            "model.group.lang.fr",
            "model.group.lang.ja",
        ] as const;
        for (const key of keys) {
            expect(EN_MESSAGES[key]).toBe(DE_MESSAGES[key]);
            expect(EN_MESSAGES[key].length).toBeGreaterThan(0);
        }
    });

    it("detects the locale from the environment language tag with EN fallback", () => {
        expect(detectLocale("de-DE")).toBe("de");
        expect(detectLocale("de")).toBe("de");
        expect(detectLocale("en-US")).toBe("en");
        expect(detectLocale("fr")).toBe("en");
        expect(detectLocale(undefined)).toBe("en");
    });
});

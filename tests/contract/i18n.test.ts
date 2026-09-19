/**
 * i18n contract tests (spec §108/§68): EN and DE dictionaries are complete
 * and identical in key coverage, and every stable §68 error code maps to
 * non-empty UI text in both locales.
 */

import { describe, expect, it } from "vitest";
import { DICTATION_ERROR_CODES } from "../../src/domain/DictationError";
import {
    DE_MESSAGES,
    EN_MESSAGES,
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

    it("maps every §68 error code to UI text in both locales", () => {
        for (const code of DICTATION_ERROR_CODES) {
            for (const locale of ["en", "de"] as const) {
                const text = translateError(locale, code);
                expect(text.length, `${code} in ${locale}`).toBeGreaterThan(0);
                expect(text).not.toBe(code); // mapped text, not the raw code
            }
        }
        // v0.2.5: the cancellation code reads as a cancel, never as a failure.
        expect(translateError("en", "MODEL_DOWNLOAD_CANCELLED")).not.toContain("failed");
    });

    it("localizes the microphone labels", () => {
        for (const state of ["ready", "recording", "processing", "error"] as const) {
            expect(translateMicLabel("en", state).length).toBeGreaterThan(0);
            expect(translateMicLabel("de", state).length).toBeGreaterThan(0);
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

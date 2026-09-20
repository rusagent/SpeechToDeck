/**
 * SteamBulkPasteInserter contract tests: the transaction
 * order — validate → context → clipboard once → context revalidation →
 * exactly one paste — with fail-closed behavior on blocked or changed
 * contexts, and the candidate capability model in `probe`.
 */

import { describe, expect, it } from "vitest";
import { SteamBulkPasteInserter } from "../../src/infrastructure/steam/SteamBulkPasteInserter";
import { MAX_TRANSCRIPT_UTF8_BYTES } from "../../src/domain/DictationError";
import { FakeKeyboardHost } from "../frontend/fakes/FakeKeyboardHost";
import { FakeClipboardPort, FakePasteActionPort } from "./helpers";

const UNICODE_TRANSCRIPT = 'Hällo wörld — ä ö ü ß "quotes", it\'s; fine? Yes! 🎙';

function makeInserter() {
    const keyboard = new FakeKeyboardHost();
    const clipboard = new FakeClipboardPort();
    const paste = new FakePasteActionPort();
    const inserter = new SteamBulkPasteInserter(clipboard, paste, keyboard);
    return { keyboard, clipboard, paste, inserter };
}

async function readyContext() {
    const rig = makeInserter();
    const context = rig.keyboard.open();
    return { ...rig, context };
}

describe("SteamBulkPasteInserter", () => {
    it("insert runs the transaction in order: clipboard once, then one paste", async () => {
        const { clipboard, paste, inserter, context, keyboard } = await readyContext();

        const result = await inserter.insert(context, `  ${UNICODE_TRANSCRIPT}  `);

        expect(result).toEqual({ ok: true, value: undefined });
        expect(clipboard.writeCalls).toEqual([`write:${context.id}`]); // once
        expect(clipboard.writtenTexts).toEqual([UNICODE_TRANSCRIPT.trim()]); // trimmed, complete, Unicode intact
        expect(paste.invokeCalls).toEqual([context.id]); // exactly one paste
        expect(keyboard.trace).toEqual([]); // no hook start/stop churn from insertion
    });

    it("suppresses the paste when the keyboard closes during clipboard preparation", async () => {
        const { clipboard, paste, inserter, context, keyboard } = await readyContext();
        clipboard.onWrite = () => keyboard.close(); // user closes the keyboard mid-transaction

        const result = await inserter.insert(context, UNICODE_TRANSCRIPT);

        expect(result).toMatchObject({ ok: false, error: { code: "KEYBOARD_CONTEXT_CHANGED" } });
        expect(clipboard.writeCalls).toHaveLength(1); // write happened (may remain)
        expect(paste.invokeCalls).toHaveLength(0); // no paste into a dead context
    });

    it("refuses to start when the given context is not the current one", async () => {
        const { clipboard, paste, inserter, keyboard } = await readyContext();
        keyboard.open(); // replaces the current context with a fresh id

        const stale = { id: "vk-stale", windowToken: "steam-ui-window", visible: true };
        const result = await inserter.insert(stale, UNICODE_TRANSCRIPT);

        expect(result).toMatchObject({ ok: false, error: { code: "KEYBOARD_CONTEXT_CHANGED" } });
        expect(clipboard.writeCalls).toHaveLength(0);
        expect(paste.invokeCalls).toHaveLength(0);
    });

    it("rejects control-character transcripts before any output side effect", async () => {
        const { clipboard, paste, inserter, context } = await readyContext();

        const result = await inserter.insert(context, "bad\0text");

        expect(result).toMatchObject({ ok: false, error: { code: "TRANSCRIPT_INVALID" } });
        expect(clipboard.writeCalls).toHaveLength(0);
        expect(paste.invokeCalls).toHaveLength(0);
    });

    it("enforces the 16 KiB core limit even before the clipboard adapter sees text", async () => {
        const { clipboard, paste, inserter, context } = await readyContext();

        const result = await inserter.insert(context, "a".repeat(MAX_TRANSCRIPT_UTF8_BYTES + 1));

        expect(result).toMatchObject({ ok: false, error: { code: "TRANSCRIPT_TOO_LARGE" } });
        expect(clipboard.writeCalls).toHaveLength(0);
        expect(paste.invokeCalls).toHaveLength(0);
    });

    it("maps a clipboard write failure to CLIPBOARD_WRITE_FAILED and never pastes", async () => {
        const { clipboard, paste, inserter, context } = await readyContext();
        clipboard.writeError = new Error("clipboard busy");

        const result = await inserter.insert(context, UNICODE_TRANSCRIPT);

        expect(result).toMatchObject({ ok: false, error: { code: "CLIPBOARD_WRITE_FAILED" } });
        expect(paste.invokeCalls).toHaveLength(0);
    });

    it("probe reports the candidate model: direct insert, clipboard-only, or nothing", async () => {
        const { clipboard, paste, inserter, context } = await readyContext();

        expect(await inserter.probe(context)).toEqual({
            available: true,
            directInsert: true,
            clipboardOnly: false,
            maxTextBytes: MAX_TRANSCRIPT_UTF8_BYTES,
        });

        paste.available = false; // degraded clipboard-only path
        expect(await inserter.probe(context)).toEqual({
            available: true,
            directInsert: false,
            clipboardOnly: true,
            maxTextBytes: MAX_TRANSCRIPT_UTF8_BYTES,
        });

        clipboard.available = false; // nothing usable
        expect(await inserter.probe(context)).toEqual({
            available: false,
            directInsert: false,
            clipboardOnly: false,
            maxTextBytes: 0,
        });
    });
});

/**
 * SteamBulkPasteInserter — the production bulk insertion
 * architecture: complete transcript → clipboard, then exactly one native
 * paste on the verified keyboard context.
 *
 * Transaction sequence, in this exact order:
 *   1. validate text (core validation, incl. the 16 KiB UTF-8 limit);
 *   2. validate keyboard context;
 *   3. write the entire transcript to the clipboard — once;
 *   4. revalidate keyboard context (the user may close the keyboard while
 *      clipboard preparation runs; the transcript may remain in the
 *      clipboard — no restoration);
 *   5. invoke exactly one paste action;
 *   6. return success.
 *
 * No per-character iteration, no character-to-keycode translation, no field
 * submission, Unicode preserved. Failures are `Result` values.
 */

import { validateTranscript, DictationError } from "../../domain/DictationError";
import type { BulkInsertionCapability } from "../../domain/Capability";
import type { KeyboardContext } from "../../domain/DictationSession";
import { err, ok } from "../../domain/Result";
import type { BulkInsertResult, BulkTextInserter } from "../../application/ports/BulkTextInserter";
import type { ClipboardPort } from "../../application/ports/ClipboardPort";
import type { KeyboardHostPort } from "../../application/ports/KeyboardHostPort";
import type { PasteActionPort } from "../../application/ports/PasteActionPort";
import { Logger } from "../../shared/Logger";

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class SteamBulkPasteInserter implements BulkTextInserter {
    constructor(
        private readonly clipboard: ClipboardPort,
        private readonly pasteAction: PasteActionPort,
        private readonly keyboard: KeyboardHostPort,
        private readonly logger: Logger = new Logger("output.paste"),
    ) {}

    async probe(context: KeyboardContext): Promise<BulkInsertionCapability> {
        // No optimistic assumption: a failed probe reports unavailable.
        let clipboardAvailable = false;
        let maxTextBytes = 0;
        let pasteAvailable = false;
        try {
            const clipboardCapability = await this.clipboard.probe(context);
            clipboardAvailable = clipboardCapability.available;
            maxTextBytes = clipboardCapability.maxTextBytes;
        } catch (error) {
            this.logger.warn("clipboard probe failed", { detail: describeError(error) });
        }
        try {
            pasteAvailable = (await this.pasteAction.probe(context)).available;
        } catch (error) {
            this.logger.warn("paste probe failed", { detail: describeError(error) });
        }
        const directInsert = clipboardAvailable && pasteAvailable;
        return {
            available: clipboardAvailable,
            directInsert,
            clipboardOnly: clipboardAvailable && !directInsert,
            // A limit is only meaningful for a usable path (no
            // optimistic assumption).
            maxTextBytes: clipboardAvailable ? maxTextBytes : 0,
        };
    }

    async insert(context: KeyboardContext, text: string): Promise<BulkInsertResult> {
        // 1. Validate text — core validation semantics and the 16 KiB limit.
        let normalized: string;
        try {
            normalized = validateTranscript(text);
        } catch (error) {
            const failure =
                error instanceof DictationError
                    ? error
                    : new DictationError("TRANSCRIPT_INVALID", describeError(error), {
                          cause: error,
                      });
            this.logger.warn("transcript rejected by validation", { code: failure.code });
            return err(failure);
        }

        // 2. Validate keyboard context.
        if (!this.contextMatches(context)) {
            return err(new DictationError("KEYBOARD_CONTEXT_CHANGED"));
        }

        // 3. Write the complete transcript once.
        try {
            await this.clipboard.writeText(context, normalized);
        } catch (error) {
            const failure =
                error instanceof DictationError
                    ? error
                    : new DictationError("CLIPBOARD_WRITE_FAILED", describeError(error), {
                          cause: error,
                      });
            this.logger.warn("clipboard write failed", { code: failure.code });
            return err(failure);
        }

        // 4. Revalidate keyboard context.
        if (!this.contextMatches(context)) {
            this.logger.info("context changed after clipboard write; paste suppressed");
            return err(new DictationError("KEYBOARD_CONTEXT_CHANGED"));
        }

        // 5. Exactly one paste action.
        try {
            await this.pasteAction.invokePaste(context);
        } catch (error) {
            const failure =
                error instanceof DictationError
                    ? error
                    : new DictationError("PASTE_ACTION_UNAVAILABLE", describeError(error), {
                          cause: error,
                      });
            this.logger.warn("paste invocation failed", { code: failure.code });
            return err(failure);
        }

        // 6. Success.
        return ok(undefined);
    }

    private contextMatches(context: KeyboardContext): boolean {
        const current = this.keyboard.currentContext();
        return current !== null && current.id === context.id;
    }
}

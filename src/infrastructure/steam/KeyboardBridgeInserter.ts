/**
 * KeyboardBridgeInserter (v0.1.7) — the bulk insertion front end.
 *
 * Primary path (§2.2/§22 reading, see IMPLEMENTATION_STATUS.md): the COMPLETE
 * transcript is delivered as ONE payload through the in-window
 * `__stdMicInsert` (native value setter + exactly one `input` event on the
 * captured editable). No per-character iteration, no keycode translation.
 *
 * Fallback path: the §24 clipboard-write + single-native-paste transaction,
 * used ONLY when the focused-element insertion reports failure (element gone,
 * not editable, or transport failure). The fallback revalidates the keyboard
 * context internally before writing and pasting (§24 steps 2/4).
 */

import { validateTranscript, DictationError } from "../../domain/DictationError";
import type { BulkInsertionCapability } from "../../domain/Capability";
import type { KeyboardContext } from "../../domain/DictationSession";
import { err, ok } from "../../domain/Result";
import type { BulkInsertResult, BulkTextInserter } from "../../application/ports/BulkTextInserter";
import { Logger } from "../../shared/Logger";
import type { TabBridgeInsertionSurface } from "./KeyboardTabBridge";

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class KeyboardBridgeInserter implements BulkTextInserter {
    constructor(
        private readonly bridge: TabBridgeInsertionSurface,
        private readonly fallback: BulkTextInserter,
        private readonly logger: Logger = new Logger("output.paste"),
    ) {}

    async probe(context: KeyboardContext): Promise<BulkInsertionCapability> {
        // Capability rows stay about the §24 mechanisms; the bridge path is
        // gated per-insertion by the observed context (§57: report, don't
        // assume — the panel shows the tab-bridge rows separately).
        return this.fallback.probe(context);
    }

    async insert(context: KeyboardContext, text: string): Promise<BulkInsertResult> {
        // 1. Validate text once (§24 step 1 — core §78 semantics, 16 KiB limit).
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

        // 2. Primary path: one-payload insert on the still-current context.
        const current = this.bridge.currentContext();
        if (current !== null && current.id === context.id) {
            let inserted = false;
            try {
                inserted = await this.bridge.insertText(normalized);
            } catch (error) {
                this.logger.warn("bridge insert threw; falling back", {
                    detail: describeError(error),
                });
            }
            if (inserted) {
                return ok(undefined);
            }
            this.logger.info("bridge insert declined; §24 clipboard path takes over");
        } else {
            this.logger.info("bridge context no longer current; §24 clipboard path takes over");
        }

        // 3. Fallback: §24 clipboard + single paste (revalidates context internally).
        return this.fallback.insert(context, normalized);
    }
}

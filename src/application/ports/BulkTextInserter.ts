/**
 * Semantic bulk insertion contract (spec §22).
 *
 * A compliant implementation sends the complete text as one payload, performs
 * no per-character iteration and no character-to-keycode translation, preserves
 * Unicode, never submits the field, and targets only the currently verified
 * keyboard context.
 */

import type { BulkInsertionCapability } from "../../domain/Capability";
import type { DictationError } from "../../domain/DictationError";
import type { KeyboardContext } from "../../domain/DictationSession";
import type { Result } from "../../domain/Result";

/** Outcome of an insertion attempt; failure is a value, not an exception. */
export type BulkInsertResult = Result<void, DictationError>;

export interface BulkTextInserter {
    probe(context: KeyboardContext): Promise<BulkInsertionCapability>;

    insert(context: KeyboardContext, text: string): Promise<BulkInsertResult>;
}

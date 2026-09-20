/**
 * Paste action port. `invokePaste` MUST invoke the native semantic
 * paste operation associated with the currently visible Steam keyboard and
 * MUST NOT type the contents itself.
 */

import type { KeyboardContext } from "../../domain/DictationSession";
import type { PasteCapability } from "../../domain/Capability";

export interface PasteActionPort {
    probe(context: KeyboardContext): Promise<PasteCapability>;

    invokePaste(context: KeyboardContext): Promise<void>;
}

/**
 * TabBridgePasteActionAdapter (v0.1.7) — the §26 paste action executed in the
 * Big Picture keyboard document through the official `executeInTab` API.
 *
 * §24 fallback semantics: the clipboard is written first by the plugin
 * context (shared OS clipboard), then EXACTLY ONE native paste is invoked on
 * the still-current keyboard context — here via the in-window
 * `__stdMicPaste` (execCommand("paste") on the captured editable, elevated by
 * the loader's userGesture). It never types contents.
 *
 * Probe honesty (§57/§58.5): the probe only verifies that the paste mechanism
 * is recognized in the keyboard document — it never pastes.
 */

import { DictationError } from "../../domain/DictationError";
import type { KeyboardContext } from "../../domain/DictationSession";
import type { PasteCapability } from "../../domain/Capability";
import type { PasteActionPort } from "../../application/ports/PasteActionPort";
import { Logger } from "../../shared/Logger";
import type { TabBridgePasteSurface } from "./KeyboardTabBridge";

export class TabBridgePasteActionAdapter implements PasteActionPort {
    constructor(
        private readonly bridge: TabBridgePasteSurface,
        private readonly logger: Logger = new Logger("output.paste"),
    ) {}

    async probe(context: KeyboardContext): Promise<PasteCapability> {
        void context; // mechanism is document-global in the SP view; the context is caller-verified (§24 step 2)
        return { available: await this.bridge.probePasteMechanism() };
    }

    async invokePaste(context: KeyboardContext): Promise<void> {
        const current = this.bridge.currentContext();
        if (current === null || current.id !== context.id) {
            throw new DictationError(
                "KEYBOARD_CONTEXT_CHANGED",
                "paste invoked for a non-current keyboard context",
            );
        }
        const pasted = await this.bridge.invokePaste();
        if (!pasted) {
            throw new DictationError(
                "PASTE_ACTION_UNAVAILABLE",
                "the keyboard document did not confirm the paste",
            );
        }
        this.logger.info("native paste invoked via tab bridge", { contextId: context.id });
    }
}

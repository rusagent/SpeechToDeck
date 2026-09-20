/**
 * Keyboard context creation: every keyboard appearance generates
 * a fresh context id; a transcript is never inserted into a different
 * context. Ids are unique across the plugin's lifetime.
 */

import type { KeyboardContext } from "../../domain/DictationSession";
import type { IdGeneratorPort } from "../../application/ports/IdGeneratorPort";

export class SteamKeyboardContextFactory {
    private sequence = 0;

    constructor(private readonly ids: IdGeneratorPort) {}

    create(windowToken: string, visible: boolean): KeyboardContext {
        this.sequence += 1;
        return {
            id: `vk-${String(this.sequence)}-${this.ids.nextId()}`,
            windowToken,
            visible,
        };
    }
}

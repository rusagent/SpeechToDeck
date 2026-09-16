/**
 * SteamPasteActionAdapter (spec §26/§28 Candidate A).
 *
 * Invokes the keyboard's own native paste semantic action — the same control
 * the Steam keyboard exposes to the user — discovered through the active
 * compatibility profile. It MUST NOT and does not type characters: nothing in
 * this adapter synthesizes key or input events.
 *
 * The handle is re-resolved at invocation time against the still-current
 * keyboard context; a changed or vanished context fails closed.
 */

import { DictationError } from "../../domain/DictationError";
import type { KeyboardContext } from "../../domain/DictationSession";
import type { PasteCapability } from "../../domain/Capability";
import type { PasteActionPort } from "../../application/ports/PasteActionPort";
import { Logger } from "../../shared/Logger";
import type {
    SteamKeyboardDiscovery,
    SteamKeyboardDiscoveryProvider,
} from "./SteamKeyboardHostAdapter";

function describeError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

export class SteamPasteActionAdapter implements PasteActionPort {
    constructor(
        private readonly discoveryProvider: SteamKeyboardDiscoveryProvider,
        private readonly logger: Logger = new Logger("output.paste"),
    ) {}

    async probe(context: KeyboardContext): Promise<PasteCapability> {
        const discovery = this.currentMatchingDiscovery(context);
        if (discovery === null) {
            return { available: false };
        }
        return { available: discovery.profile.locatePasteAction(discovery.keyboardDom) !== null };
    }

    async invokePaste(context: KeyboardContext): Promise<void> {
        const discovery = this.currentMatchingDiscovery(context);
        if (discovery === null) {
            throw new DictationError(
                "KEYBOARD_CONTEXT_CHANGED",
                "paste invoked for a non-current keyboard context",
            );
        }
        // Fresh handle at invocation time: the DOM may have changed since the
        // clipboard write (§24 revalidation before the single paste).
        const handle = discovery.profile.locatePasteAction(discovery.keyboardDom);
        if (handle === null) {
            throw new DictationError(
                "PASTE_ACTION_UNAVAILABLE",
                "no native paste action on the active keyboard",
            );
        }
        try {
            handle.invoke();
        } catch (error) {
            throw new DictationError("PASTE_ACTION_UNAVAILABLE", describeError(error), {
                cause: error,
            });
        }
        this.logger.info("native paste invoked", {
            contextId: context.id,
            mechanism: handle.mechanism,
        });
    }

    private currentMatchingDiscovery(context: KeyboardContext): SteamKeyboardDiscovery | null {
        const discovery = this.discoveryProvider.getCurrentDiscovery();
        if (discovery === null || discovery.contextId !== context.id) {
            return null;
        }
        return discovery;
    }
}

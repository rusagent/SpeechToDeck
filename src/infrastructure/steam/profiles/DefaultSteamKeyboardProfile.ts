/**
 * Default compatibility profile (spec §59/§60).
 *
 * Locator evidence preference order (§60): stable semantic attributes first,
 * then roles/accessible labels, then structural relationships; minified CSS
 * classes are secondary corroboration only and are never decisive. Matching
 * is conservative multi-evidence: an unknown structure reports "unsupported"
 * instead of guessing and continuing (§89, §2.4).
 */

import type {
    SteamKeyboardProfile,
    SteamDiscoveryContext,
    SteamPasteHandle,
} from "./SteamKeyboardProfile";

/** Semantic attribute of the virtual keyboard root (primary evidence). */
export const VK_ROOT_ATTRIBUTE = "data-virtualkeyboard";

/** Semantic attribute marking the keyboard's native paste action control. */
export const VK_PASTE_ACTION_ATTRIBUTE = "data-vk-action";

/** Semantic attribute marking one virtual key (structural evidence). */
export const VK_KEY_ATTRIBUTE = "data-vk-key";

/** Plugin-owned mount node marker (spec §18 example). */
export const MIC_ROOT_ATTRIBUTE = "data-speechtodeck-root";

function hasAttributeTrue(element: HTMLElement, attribute: string): boolean {
    return element.getAttribute(attribute) === "true";
}

function queryOne(root: ParentNode, selector: string): HTMLElement | null {
    return root.querySelector<HTMLElement>(selector);
}

function isActivatableControl(element: HTMLElement): boolean {
    return element.tagName === "BUTTON" || element.getAttribute("role") === "button";
}

/**
 * The stable CSS-module token (§60.5 known-signature corroboration): the
 * live-verified keyboard container and key classes carry the literal
 * `virtualkeyboard` / `VirtualKeyboard` tokens with hash prefixes.
 */
const VK_CLASS_TOKEN_PATTERN = /virtualkeyboard/i;

function hasStructuralKeyControl(keyboard: HTMLElement): boolean {
    // Evidence (§60.4): the root actually contains interactive key controls,
    // so it is a keyboard and not an unrelated node with a matching class.
    return queryOne(keyboard, `[${VK_KEY_ATTRIBUTE}], [role="button"], button`) !== null;
}

export const DefaultSteamKeyboardProfile: SteamKeyboardProfile = {
    id: "steam-vk-semantic-v1",

    matches(context: SteamDiscoveryContext): boolean {
        const keyboard = context.keyboardDom;
        if (keyboard === null) {
            return false;
        }
        if (!hasStructuralKeyControl(keyboard)) {
            return false;
        }
        // Signature A (§60.1): stable semantic attribute on the root.
        if (hasAttributeTrue(keyboard, VK_ROOT_ATTRIBUTE)) {
            return true;
        }
        // Signature B (v0.1.6, live-verified on deck hardware): the CSS-module
        // class token — accepted only together with the structural key-control
        // evidence above AND a registry manager hook on the same client, which
        // discovery guarantees before this profile runs (§60: classes are
        // corroborating evidence, never the sole locator).
        return VK_CLASS_TOKEN_PATTERN.test(keyboard.className);
    },

    locateMountPoint(keyboard: HTMLElement): HTMLElement | null {
        // The keyboard root itself: appending keeps every Steam-owned child
        // untouched (§18); cleanup removes only the plugin-owned node. The
        // root was validated by `matches` (either signature), so no attribute
        // re-check here — the verified real keyboard carries no semantic
        // attributes, only the CSS-module token.
        return keyboard;
    },

    locatePasteAction(keyboard: HTMLElement): SteamPasteHandle | null {
        const pasteControl = queryOne(keyboard, `[${VK_PASTE_ACTION_ATTRIBUTE}="paste"]`);
        if (pasteControl === null) {
            return null;
        }
        // Evidence 2 (§60.2): the paste control must be an activatable
        // button-role element; anything else is not a recognized mechanism.
        if (!isActivatableControl(pasteControl)) {
            return null;
        }
        const handle: SteamPasteHandle = {
            mechanism: "virtual-keyboard paste action control",
            invoke: () => {
                pasteControl.click();
            },
        };
        return handle;
    },
};

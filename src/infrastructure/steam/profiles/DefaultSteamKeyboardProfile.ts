/**
 * Default compatibility profile.
 *
 * Locator evidence preference order: stable semantic attributes first,
 * then roles/accessible labels, then structural relationships; a known
 * profile-specific signature is the last honest locator for a Steam
 * build whose real DOM carries no semantic attributes. Matching is
 * conservative multi-evidence: an unknown structure reports "unsupported"
 * instead of guessing and continuing.
 *
 * On-device regression fix: the live-scanned keyboard container is a
 * permanently-present node with a hash-prefixed
 * CSS-module class + the literal "VirtualKeyboardVisible" visibility token,
 * inside a `DIV.*.Panel` parent — with NO semantic attributes, NO recognized
 * paste control, and NO button-role key controls. The former key-control
 * requirement was fixture-built and reported `profileId=none` on real
 * hardware; the profile now matches the verified container signature while
 * still failing closed on unrelated DOM.
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

/** Plugin-owned mount node marker. */
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
 * The stable CSS-module token (the known-signature evidence): the
 * live-verified keyboard container class carries the literal `virtualkeyboard`
 * / `VirtualKeyboard` token with hash prefixes (the visibility token
 * "VirtualKeyboardVisible" is the locator's separate visibility evidence).
 */
const VK_CLASS_TOKEN_PATTERN = /virtualkeyboard/i;

/**
 * Structural relationship verified on deck hardware: the keyboard
 * container's parent is a `DIV` carrying Steam's `Panel` class
 * (`DIV._1DLmEVjfX3d7Ec8CW7vJnt Panel`). Together with the class
 * token this is the two-evidence known signature — the token alone never
 * decides.
 */
function hasVerifiedPanelParent(keyboard: HTMLElement): boolean {
    const parent = keyboard.parentElement;
    return parent !== null && parent.tagName === "DIV" && /\bPanel\b/.test(parent.className);
}

export const DefaultSteamKeyboardProfile: SteamKeyboardProfile = {
    id: "steam-vk-semantic-v1",

    matches(context: SteamDiscoveryContext): boolean {
        const keyboard = context.keyboardDom;
        if (keyboard === null) {
            return false;
        }
        // Signature A: stable semantic attribute on the root.
        if (hasAttributeTrue(keyboard, VK_ROOT_ATTRIBUTE)) {
            return true;
        }
        // Signature B (live-verified on deck hardware): the known
        // profile-specific container signature — the CSS-module class
        // token AND the verified Panel parent relationship. The real DOM's
        // key controls are not button-role elements and the container stays
        // mounted while hidden, so neither key presence nor visibility is a
        // match condition.
        return VK_CLASS_TOKEN_PATTERN.test(keyboard.className) && hasVerifiedPanelParent(keyboard);
    },

    locateMountPoint(keyboard: HTMLElement): HTMLElement | null {
        // The keyboard root itself: appending keeps every Steam-owned child
        // untouched; cleanup removes only the plugin-owned node. The
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
        // Second evidence: the paste control must be an activatable
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

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
export const MIC_ROOT_ATTRIBUTE = "data-decky-voice-keyboard-root";

function hasAttributeTrue(element: HTMLElement, attribute: string): boolean {
    return element.getAttribute(attribute) === "true";
}

function queryOne(root: ParentNode, selector: string): HTMLElement | null {
    return root.querySelector<HTMLElement>(selector);
}

function isActivatableControl(element: HTMLElement): boolean {
    return element.tagName === "BUTTON" || element.getAttribute("role") === "button";
}

export const DefaultSteamKeyboardProfile: SteamKeyboardProfile = {
    id: "steam-vk-semantic-v1",

    matches(context: SteamDiscoveryContext): boolean {
        const keyboard = context.keyboardDom;
        if (keyboard === null) {
            return false;
        }
        // Evidence 1 (§60.1): stable semantic attribute on the root.
        if (!hasAttributeTrue(keyboard, VK_ROOT_ATTRIBUTE)) {
            return false;
        }
        // Evidence 2 (§60.4): structural relationship — the root actually
        // contains interactive key controls, so it is a keyboard and not an
        // unrelated node carrying the same attribute.
        const keyControl = queryOne(keyboard, `[${VK_KEY_ATTRIBUTE}], [role="button"], button`);
        if (keyControl === null) {
            return false;
        }
        return true;
    },

    locateMountPoint(keyboard: HTMLElement): HTMLElement | null {
        if (!hasAttributeTrue(keyboard, VK_ROOT_ATTRIBUTE)) {
            return null;
        }
        // The keyboard root itself: appending keeps every Steam-owned child
        // untouched (§18); cleanup removes only the plugin-owned node.
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

/**
 * Known compatibility profiles (spec §59). New Steam builds are supported by
 * adding a profile here, not by touching adapter or application code.
 */

import type { SteamKeyboardProfile } from "./SteamKeyboardProfile";
import { DefaultSteamKeyboardProfile } from "./DefaultSteamKeyboardProfile";

export const STEAM_KEYBOARD_PROFILES: readonly SteamKeyboardProfile[] = [
    DefaultSteamKeyboardProfile,
];

export { DefaultSteamKeyboardProfile };
export type {
    SteamKeyboardProfile,
    SteamDiscoveryContext,
    SteamPasteHandle,
} from "./SteamKeyboardProfile";

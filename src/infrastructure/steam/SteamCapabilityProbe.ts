/**
 * SteamCapabilityProbe (spec §58).
 *
 * Per Steam session the probe checks, without ever modifying user text:
 *   1. active Steam window reachable;
 *   2. virtual keyboard manager recognizable;
 *   3. keyboard DOM signature supported (profile match);
 *   4. clipboard mechanism usable;
 *   5. native paste mechanism recognized.
 *
 * Every check is a read-only capability inspection; the clipboard check only
 * verifies that the write mechanism exists — it never writes.
 */

import { STEAM_KEYBOARD_PROFILES } from "./profiles";
import type { SteamKeyboardProfile } from "./profiles/SteamKeyboardProfile";
import { SteamKeyboardLocator, DEFAULT_LOCATOR_CONFIG } from "./SteamKeyboardLocator";
import type { SteamClock, SteamLocatorConfig, SteamSleeper } from "./SteamKeyboardLocator";
import { Logger } from "../../shared/Logger";

export interface SteamCapabilityReport {
    /** §58.1 */
    readonly windowReachable: boolean;
    /** §58.2 */
    readonly managerRecognizable: boolean;
    /** §58.3 */
    readonly keyboardSignatureSupported: boolean;
    /** §58.4 */
    readonly clipboardUsable: boolean;
    /** §58.5 */
    readonly nativePasteRecognized: boolean;
    /** Conjunction of the Steam-side checks (§58.1-§58.3). */
    readonly supported: boolean;
    readonly profileId: string | null;
}

export interface SteamCapabilityProbeOptions {
    locator?: SteamKeyboardLocator;

    profiles?: readonly SteamKeyboardProfile[];

    logger?: Logger;

    locatorConfig?: SteamLocatorConfig;

    locatorClock?: SteamClock;

    locatorSleeper?: SteamSleeper;
}

function clipboardWriteMechanismExists(): boolean {
    if (typeof navigator === "undefined") {
        return false;
    }
    const clipboard = (navigator as Navigator).clipboard;
    return clipboard !== undefined && typeof clipboard.writeText === "function";
}

export class SteamCapabilityProbe {
    private readonly locator: SteamKeyboardLocator;
    private readonly profiles: readonly SteamKeyboardProfile[];
    private readonly logger: Logger;

    constructor(options: SteamCapabilityProbeOptions = {}) {
        this.profiles = options.profiles ?? STEAM_KEYBOARD_PROFILES;
        this.logger = options.logger ?? new Logger("steam.capability");
        this.locator =
            options.locator ??
            new SteamKeyboardLocator(
                options.locatorConfig ?? DEFAULT_LOCATOR_CONFIG,
                options.locatorClock,
                options.locatorSleeper,
            );
    }

    /** Read-only, synchronous snapshot of the current Steam session. */
    probe(): SteamCapabilityReport {
        const windowHandle = this.locator.locateWindow();
        const windowReachable = windowHandle !== null;
        const manager =
            windowHandle === null ? null : this.locator.locateKeyboardManager(windowHandle);
        const managerRecognizable = manager !== null;
        const dom = windowHandle === null ? null : this.locator.locateKeyboardDom(windowHandle);

        let profile: SteamKeyboardProfile | null = null;
        if (windowHandle !== null && dom !== null) {
            const context = {
                window: windowHandle,
                manager,
                keyboardDom: dom,
                component: this.locator.locateKeyboardComponent(dom),
            };
            profile = this.profiles.find((candidate) => candidate.matches(context)) ?? null;
        }

        const clipboardUsable = clipboardWriteMechanismExists();
        const nativePasteRecognized =
            dom !== null && profile !== null && profile.locatePasteAction(dom) !== null;

        const report: SteamCapabilityReport = {
            windowReachable,
            managerRecognizable,
            keyboardSignatureSupported: profile !== null,
            clipboardUsable,
            nativePasteRecognized,
            supported: windowReachable && managerRecognizable && profile !== null,
            profileId: profile?.id ?? null,
        };
        this.logger.info("capability probe completed", {
            supported: report.supported,
            profileId: report.profileId ?? "none",
        });
        return report;
    }
}

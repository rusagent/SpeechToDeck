/**
 * Capability model (spec §57) and the per-mechanism probe results returned by
 * the output ports (spec §22/§25/§26).
 *
 * Capability detection never modifies user text (spec §58) and makes no
 * optimistic assumption (§57): availability is reported, never assumed.
 */

export interface ClipboardCapability {
    readonly available: boolean;
    /** Maximum transcript size the clipboard path accepts, UTF-8 bytes (§25: 16 KiB). */
    readonly maxTextBytes: number;
}

export interface PasteCapability {
    readonly available: boolean;
}

export interface BulkInsertionCapability {
    /** A usable insertion path exists: direct insert, or degraded clipboard-only (§28 Candidate C). */
    readonly available: boolean;
    /** The one-shot direct-insert path (clipboard write + native paste on a verified context) is usable. */
    readonly directInsert: boolean;
    /** Only the degraded clipboard-only path is usable. */
    readonly clipboardOnly: boolean;
    /** Maximum transcript size the insertion path accepts, UTF-8 bytes. */
    readonly maxTextBytes: number;
}

export interface RuntimeCapabilities {
    speechRuntimeAvailable: boolean;
    microphoneAvailable: boolean;
    cpuAvailable: boolean;
    vulkanAvailable: boolean;
    modelInstalled: boolean;

    keyboardHookAvailable: boolean;
    clipboardAvailable: boolean;
    nativePasteAvailable: boolean;

    directInsertAvailable: boolean;
}

/**
 * Keyboard-side capability report of the per-session probe (spec §58.1-§58.5).
 * The domain owns the shape; the infrastructure probe implements it, so
 * consumers never import Steam internals (§3.1).
 */
export interface KeyboardCapabilityReport {
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
    /** Conjunction of the keyboard-side checks (§58.1-§58.3). */
    readonly supported: boolean;
    readonly profileId: string | null;
}

/** The `directInsertAvailable` conjunction, verbatim spec §57. */
export function directInsertAvailable(
    input: Pick<
        RuntimeCapabilities,
        "clipboardAvailable" | "nativePasteAvailable" | "keyboardHookAvailable"
    >,
): boolean {
    return input.clipboardAvailable && input.nativePasteAvailable && input.keyboardHookAvailable;
}

const RUNTIME_CAPABILITY_KEYS = [
    "speechRuntimeAvailable",
    "microphoneAvailable",
    "cpuAvailable",
    "vulkanAvailable",
    "modelInstalled",
    "keyboardHookAvailable",
    "clipboardAvailable",
    "nativePasteAvailable",
    "directInsertAvailable",
] as const;

/** Manual type guard for the capability report crossing a boundary (spec §99). */
export function isRuntimeCapabilities(value: unknown): value is RuntimeCapabilities {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const record = value as Record<string, unknown>;
    return RUNTIME_CAPABILITY_KEYS.every((key) => typeof record[key] === "boolean");
}

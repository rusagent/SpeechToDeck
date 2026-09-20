/**
 * Capability model and the per-mechanism probe results returned by
 * the output ports.
 *
 * Capability detection never modifies user text and makes no optimistic
 * assumption: availability is reported, never assumed.
 */

export interface ClipboardCapability {
    readonly available: boolean;
    /** Maximum transcript size the clipboard path accepts, UTF-8 bytes (16 KiB). */
    readonly maxTextBytes: number;
}

export interface PasteCapability {
    readonly available: boolean;
}

export interface BulkInsertionCapability {
    /** A usable insertion path exists: direct insert, or degraded clipboard-only. */
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
 * Keyboard-side capability report of the per-session probe.
 * The domain owns the shape; the infrastructure probe implements it, so
 * consumers never import Steam internals.
 */
export interface KeyboardCapabilityReport {
    readonly windowReachable: boolean;
    readonly managerRecognizable: boolean;
    readonly keyboardSignatureSupported: boolean;
    readonly clipboardUsable: boolean;
    readonly nativePasteRecognized: boolean;
    /** Conjunction of the keyboard-side DOM checks. */
    readonly supported: boolean;
    readonly profileId: string | null;
}

/** The `directInsertAvailable` conjunction. */
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

/** Manual type guard for the capability report crossing a boundary. */
export function isRuntimeCapabilities(value: unknown): value is RuntimeCapabilities {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const record = value as Record<string, unknown>;
    return RUNTIME_CAPABILITY_KEYS.every((key) => typeof record[key] === "boolean");
}

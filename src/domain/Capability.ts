/**
 * Capability model: the startup report the state machine derives
 * readiness from.
 *
 * Capability detection never modifies user text and makes no optimistic
 * assumption: availability is reported, never assumed.
 */

export interface RuntimeCapabilities {
    speechRuntimeAvailable: boolean;
    microphoneAvailable: boolean;
    cpuAvailable: boolean;
    vulkanAvailable: boolean;
    modelInstalled: boolean;
}

const RUNTIME_CAPABILITY_KEYS = [
    "speechRuntimeAvailable",
    "microphoneAvailable",
    "cpuAvailable",
    "vulkanAvailable",
    "modelInstalled",
] as const;

/** Manual type guard for the capability report crossing a boundary. */
export function isRuntimeCapabilities(value: unknown): value is RuntimeCapabilities {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const record = value as Record<string, unknown>;
    return RUNTIME_CAPABILITY_KEYS.every((key) => typeof record[key] === "boolean");
}

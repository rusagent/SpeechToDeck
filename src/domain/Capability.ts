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

export function isRuntimeCapabilities(value: unknown): value is RuntimeCapabilities {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const record = value as Record<string, unknown>;
    return RUNTIME_CAPABILITY_KEYS.every((key) => typeof record[key] === "boolean");
}

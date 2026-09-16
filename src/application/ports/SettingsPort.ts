/**
 * Settings access port. The backend owns persistence (spec §55); the frontend
 * loads settings through a Decky callable and never writes settings files
 * directly.
 */

/** Plugin settings document (spec §54). */
export interface PluginSettings {
    schemaVersion: 1;

    enabled: boolean;

    computeBackend: "auto" | "vulkan" | "cpu";

    modelId: "tiny" | "base" | "small";

    /** `"system"`/`"auto"` sentinels or any language tag string (spec §54). */
    language: string;

    maxRecordingSeconds: number;

    vadEnabled: boolean;

    outputMode: "direct-insert" | "clipboard-only";
}

/** Manual type guard for settings crossing the backend boundary (spec §99). */
export function isPluginSettings(value: unknown): value is PluginSettings {
    if (typeof value !== "object" || value === null) {
        return false;
    }
    const record = value as Record<string, unknown>;
    return (
        record["schemaVersion"] === 1 &&
        typeof record["enabled"] === "boolean" &&
        (record["computeBackend"] === "auto" ||
            record["computeBackend"] === "vulkan" ||
            record["computeBackend"] === "cpu") &&
        (record["modelId"] === "tiny" ||
            record["modelId"] === "base" ||
            record["modelId"] === "small") &&
        typeof record["language"] === "string" &&
        typeof record["maxRecordingSeconds"] === "number" &&
        Number.isFinite(record["maxRecordingSeconds"]) &&
        record["maxRecordingSeconds"] > 0 &&
        typeof record["vadEnabled"] === "boolean" &&
        (record["outputMode"] === "direct-insert" || record["outputMode"] === "clipboard-only")
    );
}

export interface SettingsPort {
    load(): Promise<PluginSettings>;

    save(settings: PluginSettings): Promise<void>;
}

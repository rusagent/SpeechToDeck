/**
 * Settings access port. The backend owns persistence (spec §55); the frontend
 * loads settings through a Decky callable and never writes settings files
 * directly.
 */

/**
 * Model id format of the backend settings validator
 * (json_settings_repository._MODEL_ID_RE): any curated-catalog id
 * (ADR-011) matches; malformed ids are rejected before they are saved.
 */
const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

/**
 * Plugin settings document (spec §54).
 *
 * v0.2.5: `maxRecordingSeconds` and `vadEnabled` left the document (owner
 * declutter). The backend tolerates both legacy keys on load and never
 * writes them back; the daemon receives fixed constants instead.
 */
export interface PluginSettings {
    schemaVersion: 1;

    enabled: boolean;

    computeBackend: "auto" | "vulkan" | "cpu";

    /** A curated-catalog model id (ADR-011); format-checked by the guard. */
    modelId: string;

    /** `"system"`/`"auto"` sentinels or any language tag string (spec §54). */
    language: string;

    outputMode: "direct-insert" | "clipboard-only";
}

/**
 * Manual type guard for settings crossing the backend boundary (spec §99).
 * Extra fields (e.g. the legacy maxRecordingSeconds/vadEnabled from an older
 * backend payload) are tolerated and ignored — the guard validates the
 * fields this document owns, never rejects a superset.
 */
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
        typeof record["modelId"] === "string" &&
        MODEL_ID_RE.test(record["modelId"]) &&
        typeof record["language"] === "string" &&
        (record["outputMode"] === "direct-insert" || record["outputMode"] === "clipboard-only")
    );
}

export interface SettingsPort {
    load(): Promise<PluginSettings>;

    save(settings: PluginSettings): Promise<void>;
}

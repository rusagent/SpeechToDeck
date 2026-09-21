const MODEL_ID_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;

export interface PluginSettings {
    schemaVersion: 1;

    enabled: boolean;

    computeBackend: "auto" | "vulkan" | "cpu";

    modelId: string;

    language: string;
}

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
        typeof record["language"] === "string"
    );
}

export interface SettingsPort {
    load(): Promise<PluginSettings>;

    save(settings: PluginSettings): Promise<void>;
}

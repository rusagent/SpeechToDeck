import type { PluginSettings, SettingsPort } from "../../../src/application/ports/SettingsPort";

export const TEST_SETTINGS: PluginSettings = {
    schemaVersion: 1,
    enabled: true,
    computeBackend: "auto",
    modelId: "base",
    language: "system",
};

/** In-memory SettingsPort fake; load failures are injectable. */
export class FakeSettingsPort implements SettingsPort {
    value: PluginSettings = { ...TEST_SETTINGS };
    loadError: Error | null = null;

    async load(): Promise<PluginSettings> {
        if (this.loadError !== null) {
            throw this.loadError;
        }
        return this.value;
    }

    async save(): Promise<void> {
        // Persistence is backend-owned; the frontend port shape is
        // satisfied here without recording.
    }
}

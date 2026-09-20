/**
 * DeckySettingsAdapter — the frontend never writes settings files directly;
 * persistence is backend-owned. `get_settings`/`update_settings` payloads are
 * validated with the settings boundary guard before use.
 */

import type { PluginSettings, SettingsPort } from "../../application/ports/SettingsPort";
import { isPluginSettings } from "../../application/ports/SettingsPort";
import type { DeckyBackendClient } from "./DeckyBackendClient";

/** Frozen callable names (shared contract with the backend). */
export const SETTINGS_CALLABLES = {
    getSettings: "get_settings",
    updateSettings: "update_settings",
} as const;

export class DeckySettingsAdapter implements SettingsPort {
    constructor(private readonly backend: DeckyBackendClient) {}

    async load(): Promise<PluginSettings> {
        const payload = await this.backend.call(SETTINGS_CALLABLES.getSettings);
        if (!isPluginSettings(payload)) {
            throw new Error("get_settings returned an unexpected payload");
        }
        return payload;
    }

    async save(settings: PluginSettings): Promise<void> {
        if (!isPluginSettings(settings)) {
            throw new Error("refusing to save a malformed settings document");
        }
        // schemaVersion is backend-owned; the update payload whitelists
        // exactly the client-settable fields and never carries it (the backend
        // rejects a client-side schemaVersion). The removed
        // maxRecordingSeconds/vadEnabled fields are never sent.
        const update = {
            enabled: settings.enabled,
            computeBackend: settings.computeBackend,
            modelId: settings.modelId,
            language: settings.language,
            outputMode: settings.outputMode,
        };
        await this.backend.call(SETTINGS_CALLABLES.updateSettings, update);
    }
}

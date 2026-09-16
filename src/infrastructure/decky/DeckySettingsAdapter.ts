/**
 * DeckySettingsAdapter (spec §54/§55) — the frontend never writes settings
 * files directly; persistence is backend-owned. `get_settings`/`update_settings`
 * payloads are validated with the §54/§99 boundary guard before use.
 */

import type { PluginSettings, SettingsPort } from "../../application/ports/SettingsPort";
import { isPluginSettings } from "../../application/ports/SettingsPort";
import type { DeckyBackendClient } from "./DeckyBackendClient";

/** Frozen §30 callable names (shared with the backend lane). */
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
        await this.backend.call(SETTINGS_CALLABLES.updateSettings, settings);
    }
}

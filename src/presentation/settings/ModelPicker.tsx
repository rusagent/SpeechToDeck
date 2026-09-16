/**
 * ModelPicker (spec §48/§54/§80) — curated v1 model set plus the install
 * state of the selected model, reported from the speech capabilities
 * (§57: availability is reported, never assumed).
 */

import * as React from "react";
import { DropdownItem } from "@decky/ui";
import { translate } from "../i18n/messages";
import type { Locale, MessageKey } from "../i18n/messages";
import { FieldHint } from "./FieldHint";

export type ModelId = "tiny" | "base" | "small";

const MODEL_OPTIONS: readonly ModelId[] = ["tiny", "base", "small"];

/** Install state of the selected model; `null` = not known yet. */
export type ModelInstallState = "installed" | "not-installed" | "unknown";

const INSTALL_HINT_KEYS: Record<ModelInstallState, MessageKey> = {
    installed: "hint.model.installed",
    "not-installed": "hint.model.notInstalled",
    unknown: "hint.model.unknown",
};

const INSTALL_DOT_COLORS: Record<ModelInstallState, string> = {
    installed: "#5ac189",
    "not-installed": "#ff5c5c",
    unknown: "#8f98a0",
};

export interface ModelPickerProps {
    readonly value: ModelId;
    readonly locale: Locale;
    readonly onChange: (model: ModelId) => void;
    /** Install state of the selected model; `undefined` = not known yet. */
    readonly installed?: boolean | undefined;
}

export function ModelPicker({
    value,
    locale,
    onChange,
    installed,
}: ModelPickerProps): React.ReactElement {
    const installState: ModelInstallState =
        installed === undefined ? "unknown" : installed ? "installed" : "not-installed";
    return (
        <div>
            <DropdownItem
                label={translate(locale, "setting.model")}
                rgOptions={MODEL_OPTIONS.map((model) => ({
                    data: model,
                    label: translate(locale, `option.model.${model}` as "option.model.tiny"),
                }))}
                selectedOption={value}
                onChange={(option) => onChange(option.data as ModelId)}
            />
            <FieldHint>
                <span
                    aria-hidden="true"
                    style={{
                        display: "inline-block",
                        width: 8,
                        height: 8,
                        borderRadius: "50%",
                        background: INSTALL_DOT_COLORS[installState],
                        marginRight: 6,
                    }}
                />
                {translate(locale, INSTALL_HINT_KEYS[installState])}
            </FieldHint>
        </div>
    );
}

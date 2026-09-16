/**
 * ModelPicker (spec §48/§54/§80) — curated v1 model set.
 */

import * as React from "react";
import { DropdownItem } from "@decky/ui";
import { translate } from "../i18n/messages";
import type { Locale } from "../i18n/messages";

export type ModelId = "tiny" | "base" | "small";

const MODEL_OPTIONS: readonly ModelId[] = ["tiny", "base", "small"];

export interface ModelPickerProps {
    readonly value: ModelId;
    readonly locale: Locale;
    readonly onChange: (model: ModelId) => void;
}

export function ModelPicker({ value, locale, onChange }: ModelPickerProps): React.ReactElement {
    return (
        <DropdownItem
            label={translate(locale, "setting.model")}
            rgOptions={MODEL_OPTIONS.map((model) => ({
                data: model,
                label: translate(locale, `option.model.${model}` as "option.model.tiny"),
            }))}
            selectedOption={value}
            onChange={(option) => onChange(option.data as ModelId)}
        />
    );
}

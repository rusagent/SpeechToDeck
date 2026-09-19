/**
 * LanguagePicker (spec §49/§54/§80).
 *
 * `system` maps to the speech engine's auto-detection on the backend (it
 * does NOT track the Steam UI language); `auto` lets the speech engine
 * detect; explicit picks use fixed language tags. A hint below the picker
 * states what the selected mode does, in the UI language. Rendered by the
 * settings panel below the ModelSelect, and only while the selected model
 * does not pin a language itself.
 */

import * as React from "react";
import { DropdownItem } from "@decky/ui";
import { translate } from "../i18n/messages";
import type { Locale, MessageKey } from "../i18n/messages";
import { FieldHint } from "./FieldHint";

export const LANGUAGE_SENTINELS = {
    system: "system",
    auto: "auto",
} as const;

/**
 * Fully-controlled dropdown flag (constant — Steam asserts when `controlled`
 * changes after mount). Spread because @decky/ui 4.12.1 omits the runtime
 * `controlled` prop the client bundle implements.
 */
export const CONTROLLED_DROPDOWN: { controlled: boolean } = { controlled: true };

/** Curated explicit language tags for v1; `system`/`auto` are sentinels. */
const EXPLICIT_LANGUAGE_TAGS: readonly string[] = [
    "en",
    "de",
    "fr",
    "es",
    "it",
    "pt",
    "nl",
    "pl",
    "ru",
    "uk",
    "tr",
    "ja",
    "ko",
    "zh",
];

export interface LanguagePickerProps {
    /** `"system"`, `"auto"` or an explicit language tag (spec §54). */
    readonly value: string;
    readonly locale: Locale;
    readonly onChange: (language: string) => void;
}

function languageHintKey(value: string): MessageKey {
    if (value === LANGUAGE_SENTINELS.system) {
        return "hint.language.system";
    }
    if (value === LANGUAGE_SENTINELS.auto) {
        return "hint.language.auto";
    }
    return "hint.language.explicit";
}

export function LanguagePicker({
    value,
    locale,
    onChange,
}: LanguagePickerProps): React.ReactElement {
    const sentinelOptions = [
        {
            data: LANGUAGE_SENTINELS.system,
            label: translate(locale, "option.language.system"),
        },
        {
            data: LANGUAGE_SENTINELS.auto,
            label: translate(locale, "option.language.auto"),
        },
    ];
    const explicitOptions = EXPLICIT_LANGUAGE_TAGS.map((tag) => ({ data: tag, label: tag }));
    return (
        <div>
            <DropdownItem
                label={translate(locale, "setting.language")}
                rgOptions={[...sentinelOptions, ...explicitOptions]}
                selectedOption={value}
                onChange={(option) => onChange(option.data as string)}
                // Uniform fully-controlled semantics with the model dropdown:
                // the displayed value always mirrors the persisted setting
                // (Steam's DropdownItem is semi-controlled without the flag;
                // see ModelSelect for the full rationale).
                {...CONTROLLED_DROPDOWN}
            />
            <FieldHint>{translate(locale, languageHintKey(value))}</FieldHint>
        </div>
    );
}

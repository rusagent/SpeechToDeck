/**
 * LanguagePicker (spec §49/§54/§80).
 *
 * `system` maps the Steam UI language on the backend and surfaces an
 * unavailability instead of inventing a language; `auto` lets the speech
 * engine detect; explicit picks use fixed language tags.
 */

import * as React from "react";
import { DropdownItem } from "@decky/ui";
import { translate } from "../i18n/messages";
import type { Locale } from "../i18n/messages";

export const LANGUAGE_SENTINELS = {
    system: "system",
    auto: "auto",
} as const;

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
        <DropdownItem
            label={translate(locale, "setting.language")}
            rgOptions={[...sentinelOptions, ...explicitOptions]}
            selectedOption={value}
            onChange={(option) => onChange(option.data as string)}
        />
    );
}

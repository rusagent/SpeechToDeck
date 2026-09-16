/**
 * ComputeBackendPicker (spec §47/§54/§80) — the explicit backend policy:
 * `auto` is a user-selected probe-and-choose policy, `vulkan` never falls
 * back to CPU silently, `cpu` stays on CPU.
 */

import * as React from "react";
import { DropdownItem } from "@decky/ui";
import { translate } from "../i18n/messages";
import type { Locale } from "../i18n/messages";

export type ComputeBackend = "auto" | "vulkan" | "cpu";

const BACKEND_OPTIONS: readonly ComputeBackend[] = ["auto", "vulkan", "cpu"];

export interface ComputeBackendPickerProps {
    readonly value: ComputeBackend;
    readonly locale: Locale;
    readonly onChange: (backend: ComputeBackend) => void;
}

export function ComputeBackendPicker({
    value,
    locale,
    onChange,
}: ComputeBackendPickerProps): React.ReactElement {
    return (
        <DropdownItem
            label={translate(locale, "setting.computeBackend")}
            rgOptions={BACKEND_OPTIONS.map((backend) => ({
                data: backend,
                label: translate(locale, `option.backend.${backend}` as "option.backend.auto"),
            }))}
            selectedOption={value}
            onChange={(option) => onChange(option.data as ComputeBackend)}
        />
    );
}

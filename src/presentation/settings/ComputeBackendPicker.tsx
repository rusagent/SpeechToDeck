/**
 * ComputeBackendPicker (spec §47/§54/§80) — the explicit backend policy:
 * `auto` is a user-selected probe-and-choose policy, `vulkan` never falls
 * back to CPU silently, `cpu` stays on CPU. The hint below the picker states
 * the selected policy's §47 semantics in the UI language — no hidden
 * fallback wording.
 */

import * as React from "react";
import { DropdownItem } from "@decky/ui";
import { translate } from "../i18n/messages";
import type { Locale, MessageKey } from "../i18n/messages";
import { FieldHint } from "./FieldHint";

export type ComputeBackend = "auto" | "vulkan" | "cpu";

const BACKEND_OPTIONS: readonly ComputeBackend[] = ["auto", "vulkan", "cpu"];

const BACKEND_HINT_KEYS: Record<ComputeBackend, MessageKey> = {
    auto: "hint.backend.auto",
    vulkan: "hint.backend.vulkan",
    cpu: "hint.backend.cpu",
};

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
        <div>
            <DropdownItem
                label={translate(locale, "setting.computeBackend")}
                rgOptions={BACKEND_OPTIONS.map((backend) => ({
                    data: backend,
                    label: translate(locale, `option.backend.${backend}` as "option.backend.auto"),
                }))}
                selectedOption={value}
                onChange={(option) => onChange(option.data as ComputeBackend)}
            />
            <FieldHint>{translate(locale, BACKEND_HINT_KEYS[value])}</FieldHint>
        </div>
    );
}

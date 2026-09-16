/**
 * CapabilityChip — the shared read-only state display for §80 diagnostics
 * and capability rows (§57: availability is reported, never assumed).
 *
 * The dot shape plus the localized text carry the state; color is never the
 * only carrier (§107).
 */

import * as React from "react";
import { translate } from "../i18n/messages";
import type { Locale, MessageKey } from "../i18n/messages";

export type CapabilityState = "available" | "unavailable" | "unknown";

const STATE_COLORS: Record<CapabilityState, string> = {
    available: "#5ac189",
    unavailable: "#ff5c5c",
    unknown: "#8f98a0",
};

const STATE_KEYS: Record<CapabilityState, MessageKey> = {
    available: "common.available",
    unavailable: "common.unavailable",
    unknown: "common.unknown",
};

export function capabilityState(value: boolean | undefined): CapabilityState {
    if (value === undefined) {
        return "unknown";
    }
    return value ? "available" : "unavailable";
}

export function CapabilityChip({
    state,
    locale,
}: {
    state: CapabilityState;
    locale: Locale;
}): React.ReactElement {
    return (
        <span
            style={{
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "1px 8px",
                borderRadius: 9,
                background: "rgba(255, 255, 255, 0.07)",
                fontSize: 12,
                lineHeight: 1.5,
                color: "#e5e5e7",
            }}
        >
            <span
                aria-hidden="true"
                style={{
                    width: 8,
                    height: 8,
                    borderRadius: "50%",
                    background: STATE_COLORS[state],
                    flex: "none",
                }}
            />
            {translate(locale, STATE_KEYS[state])}
        </span>
    );
}

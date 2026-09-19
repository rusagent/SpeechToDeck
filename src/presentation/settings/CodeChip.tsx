/**
 * CodeChip — monospace chip showing the raw stable §68 code next to its
 * mapped text (§109: the code is a fixed enum, sanitized by construction).
 * Shared by the setup-progress panel and the dictation card so both error
 * surfaces read identically.
 *
 * v0.2.5: moved out of the removed DiagnosticsPanel into its own module.
 */

import * as React from "react";

export function CodeChip({ code }: { code: string }): React.ReactElement {
    return (
        <span
            style={{
                display: "inline-block",
                padding: "0 6px",
                borderRadius: 4,
                background: "rgba(255, 255, 255, 0.08)",
                border: "1px solid rgba(255, 92, 92, 0.4)",
                fontFamily: "monospace",
                fontSize: 11,
                lineHeight: 1.6,
                color: "rgba(255, 255, 255, 0.75)",
            }}
        >
            {code}
        </span>
    );
}

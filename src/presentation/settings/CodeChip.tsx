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

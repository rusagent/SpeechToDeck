import * as React from "react";

export function FieldHint({ children }: { children: React.ReactNode }): React.ReactElement {
    return (
        <div
            style={{
                fontSize: 12,
                lineHeight: 1.35,
                color: "rgba(255, 255, 255, 0.55)",
                paddingTop: 2,
            }}
        >
            {children}
        </div>
    );
}

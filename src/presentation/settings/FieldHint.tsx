/**
 * FieldHint — the shared muted hint line under a settings field.
 *
 * Used by every picker that needs a one-line explanation of the selected
 * value's semantics (backend policy, language selection, model install
 * state). One visual idiom for all hints keeps the panel field rhythm
 * consistent.
 */

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

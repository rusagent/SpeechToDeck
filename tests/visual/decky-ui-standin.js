/*
 * Deck visual-language stand-in for the @decky/ui field primitives.
 *
 * WHY THIS EXISTS: `@decky/ui` resolves PanelSection/Field/Dropdown etc.
 * from Steam's webpack runtime at module-eval time (components/Panel.js),
 * so the real primitives cannot render outside the Steam client. The
 * plugin bundle already treats "@decky/ui" as a runtime global (see
 * rollup.config.mjs globals → `DeckyUI`), which Steam/Decky Loader injects.
 * This harness provides that same global for a plain browser page, so the
 * REAL presentation components (SettingsPanel, MicrophoneButton, pickers)
 * render unchanged against the environment Steam would give them.
 *
 * Visual language (Steam Deck QAM plugin column, cited for visual review):
 * - Type: "Motiva Sans", "Segoe UI", Roboto, Arial, sans-serif; 14px base,
 *   sentence case labels; muted secondary text at ~55% white.
 * - Surfaces: near-black column background (#101216); panel sections as
 *   subtle lighter cards (rgba(255,255,255,0.05), 4px radius); rows divided
 *   by 1px hairlines (rgba(255,255,255,0.06)).
 * - Accent: Steam blue #1a9fff (slider fill, toggle on, focus); positive
 *   #5ac189, error #ff5c5c, unknown #8f98a0 for state chips only.
 * - Fields: label left, value right, vertically centered; dropdown shows
 *   selected label + chevron; toggles are 34x18 switches; sliders are a
 *   4px track with 14px round thumb and value bubble on the right.
 * - No shadows/gradients beyond subtle hairlines; no rounded "app card"
 *   styling — decky panels are flat and dense.
 */
(function () {
    "use strict";
    const h = window.React.createElement;

    const CSS = `
    html, body { margin: 0; padding: 0; }
    body {
        background: #0d0e11;
        color: #e5e7ea;
        font-family: "Motiva Sans", "Segoe UI", Roboto, Arial, sans-serif;
        font-size: 14px;
        line-height: 1.4;
        -webkit-font-smoothing: antialiased;
    }
    #visual-root {
        width: 410px;
        max-width: 100%;
        margin: 0 auto;
        padding: 10px 8px 16px;
        box-sizing: border-box;
        background: #14161a;
        min-height: 100vh;
    }
    .decky-panel-section {
        background: rgba(255, 255, 255, 0.05);
        border-radius: 4px;
        overflow: hidden;
        margin: 0 0 10px;
    }
    .decky-panel-section-header {
        display: flex;
        align-items: center;
        gap: 8px;
        padding: 9px 14px 7px;
        font-weight: 600;
        font-size: 14px;
        color: #eef0f2;
        letter-spacing: 0.1px;
    }
    .decky-panel-section-spinner {
        width: 12px;
        height: 12px;
        border: 2px solid rgba(255, 255, 255, 0.2);
        border-top-color: #1a9fff;
        border-radius: 50%;
        animation: decky-harness-spin 0.9s linear infinite;
    }
    .decky-panel-row {
        padding: 7px 14px;
        border-top: 1px solid rgba(255, 255, 255, 0.06);
        min-width: 0;
    }
    .decky-field {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        min-width: 0;
    }
    .decky-field-label { color: rgba(255, 255, 255, 0.72); font-size: 13.5px; flex: none; }
    .decky-field-children { min-width: 0; overflow-wrap: anywhere; text-align: right; }
    .decky-toggle {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        cursor: pointer;
        min-width: 0;
    }
    .decky-toggle-label { flex: 1 1 auto; min-width: 0; overflow-wrap: anywhere; }
    .decky-switch {
        flex: none;
        width: 34px;
        height: 18px;
        border-radius: 9px;
        background: rgba(255, 255, 255, 0.16);
        position: relative;
        transition: background 120ms ease;
    }
    .decky-switch::after {
        content: "";
        position: absolute;
        top: 2px;
        left: 2px;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: #cfd3d8;
        transition: transform 120ms ease, background 120ms ease;
    }
    .decky-switch.on { background: #1a9fff; }
    .decky-switch.on::after { transform: translateX(16px); background: #ffffff; }
    .decky-slider { display: flex; align-items: center; gap: 10px; min-width: 0; }
    .decky-slider-track {
        flex: 1 1 auto;
        height: 4px;
        border-radius: 2px;
        background: rgba(255, 255, 255, 0.16);
        position: relative;
        min-width: 0;
    }
    .decky-slider-fill {
        position: absolute;
        inset: 0 auto 0 0;
        border-radius: 2px;
        background: #1a9fff;
    }
    .decky-slider-thumb {
        position: absolute;
        top: 50%;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        background: #e8eaed;
        transform: translate(-50%, -50%);
        box-shadow: 0 0 0 1px rgba(0, 0, 0, 0.4);
    }
    .decky-slider-value { flex: none; min-width: 26px; text-align: right; font-variant-numeric: tabular-nums; color: #dfe3e6; }
    .decky-dropdown {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        min-width: 0;
    }
    .decky-dropdown-label { color: rgba(255, 255, 255, 0.72); font-size: 13.5px; flex: none; }
    .decky-dropdown-value {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        min-width: 0;
        color: #eef0f2;
        overflow-wrap: anywhere;
        text-align: right;
    }
    .decky-dropdown-chevron { flex: none; color: rgba(255, 255, 255, 0.5); font-size: 10px; }
    .decky-button {
        display: block;
        width: 100%;
        box-sizing: border-box;
        padding: 7px 12px;
        border: 1px solid rgba(255, 255, 255, 0.18);
        border-radius: 3px;
        background: rgba(255, 255, 255, 0.08);
        color: #eef0f2;
        font: inherit;
        font-size: 13.5px;
        cursor: pointer;
    }
    .decky-button[disabled] { opacity: 0.5; cursor: default; }
    /* Steam's destructive ConfirmModal OK (bDestructiveWarning): the repo's
       cited warning state color (#ff5c5c). */
    .decky-button[data-destructive-warning] { background: #eb5545; border-color: #eb5545; }
    .decky-buttonitem { margin-bottom: 6px; }
    .decky-buttonitem-label {
        display: block;
        color: rgba(255, 255, 255, 0.85);
        font-size: 13px;
        margin-bottom: 4px;
        overflow-wrap: anywhere;
    }
    .decky-progress {
        height: 4px;
        border-radius: 2px;
        background: rgba(255, 255, 255, 0.16);
        position: relative;
        overflow: hidden;
        margin: 2px 0 8px;
    }
    .decky-progress-fill {
        position: absolute;
        inset: 0 auto 0 0;
        border-radius: 2px;
        background: #1a9fff;
        transition: width 120ms ease;
    }
    .decky-progress-fill.indeterminate {
        width: 30%;
        animation: decky-harness-slide 1.1s ease-in-out infinite;
    }
    @keyframes decky-harness-slide {
        0% { left: -30%; }
        100% { left: 100%; }
    }
    /* Steam modal host emulated for the harness (showModal + ModalRoot),
       mirroring the REAL structure verified on device (CDP DOM capture,
       v0.2.5) and in the Steam client bundle: showModal mounts its node RAW
       into a fullscreen ModalOverlayContent; ModalRoot (Steam's
       GenericDialogModal) draws the centered dialog box with the DialogHeader
       title, DialogBody content and DialogFooter buttons. Esc, the X close
       icon and a background mousedown all funnel into the same closeModal
       callback. The visible title is rendered by the modal content
       (DialogHeader) — showModal's strTitle only becomes the overlay's
       aria-label, exactly like real Steam. */
    .decky-modal-overlay {
        position: fixed;
        inset: 0;
        background: rgba(0, 0, 0, 0.6);
        display: flex;
        align-items: center;
        justify-content: center;
        z-index: 1000;
    }
    .decky-modal-position {
        position: relative;
        display: flex;
    }
    .decky-modal-dialog {
        width: 480px;
        max-width: calc(100vw - 48px);
        background: #1b1d22;
        border: 1px solid rgba(255, 255, 255, 0.12);
        border-radius: 4px;
        padding: 14px 16px 16px;
        box-sizing: border-box;
    }
    .decky-modal-dismiss {
        position: absolute;
        top: -26px;
        right: -2px;
        padding: 2px 10px;
        background: none;
        border: none;
        color: rgba(255, 255, 255, 0.6);
        font: inherit;
        font-size: 15px;
        line-height: 1.2;
        cursor: pointer;
    }
    .decky-modal-dismiss:hover { color: #eef0f2; }
    .decky-modal-header {
        font-weight: 600;
        font-size: 15px;
        color: #eef0f2;
        margin: 0 0 10px;
    }
    .decky-modal-body { min-width: 0; }
    .decky-modal-bodytext {
        margin: 0 0 8px;
        color: #dfe3e6;
        overflow-wrap: anywhere;
    }
    .decky-modal-footer {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 12px;
    }
    .decky-modal-footer .decky-button {
        width: auto;
        min-width: 96px;
    }
    .mic-row {
        display: flex;
        align-items: flex-start;
        justify-content: center;
        /* Gap keeps the error flash bubble (shrink-to-fit ≈104px wide,
           centered under its 44px button) clear of the neighboring
           figcaption: measured DE overlap of 12px at 18px → 6px clearance
           at 36px, row still fits the 410px column. */
        gap: 36px;
        padding: 26px 10px 40px;
    }
    .mic-row figure { margin: 0; display: flex; flex-direction: column; align-items: center; gap: 10px; }
    .mic-row figcaption { font-size: 11px; color: rgba(255, 255, 255, 0.45); letter-spacing: 0.3px; }
    @keyframes decky-harness-spin { to { transform: rotate(360deg); } }
    `;

    function PanelSection(props) {
        return h(
            "section",
            { className: "decky-panel-section", "data-panel-title": props.title },
            props.title
                ? h(
                      "div",
                      { className: "decky-panel-section-header" },
                      props.spinner
                          ? h("span", { className: "decky-panel-section-spinner" })
                          : null,
                      props.title,
                  )
                : null,
            props.children,
        );
    }

    function PanelSectionRow(props) {
        return h("div", { className: "decky-panel-row" }, props.children);
    }

    function Field(props) {
        return h(
            "div",
            { className: "decky-field" },
            h("span", { className: "decky-field-label" }, props.label),
            h("span", { className: "decky-field-children" }, props.children),
        );
    }

    function ToggleField(props) {
        return h(
            "div",
            {
                className: "decky-toggle",
                role: "checkbox",
                "aria-checked": String(props.checked),
                onClick: () => props.onChange && props.onChange(!props.checked),
            },
            h("span", { className: "decky-toggle-label" }, props.label),
            h("span", {
                className: "decky-switch" + (props.checked ? " on" : ""),
                "aria-hidden": "true",
            }),
        );
    }

    function SliderField(props) {
        const min = props.min ?? 0;
        const max = props.max ?? 100;
        const ratio = Math.max(0, Math.min(1, (props.value - min) / (max - min || 1)));
        return h(
            "div",
            null,
            h(
                "div",
                { style: { marginBottom: 6, color: "rgba(255,255,255,0.72)", fontSize: "13.5px" } },
                props.label,
            ),
            h(
                "div",
                { className: "decky-slider" },
                h(
                    "div",
                    { className: "decky-slider-track" },
                    h("div", {
                        className: "decky-slider-fill",
                        style: { width: `${ratio * 100}%` },
                    }),
                    h("div", {
                        className: "decky-slider-thumb",
                        style: { left: `${ratio * 100}%` },
                    }),
                ),
                props.showValue
                    ? h("span", { className: "decky-slider-value" }, String(props.value))
                    : null,
            ),
        );
    }

    function DropdownItem(props) {
        // Real DropdownItem accepts flat options AND optgroups
        // ({label, options}); flatten groups to find the selected label.
        const flat = (props.rgOptions || []).flatMap((entry) =>
            entry.data !== undefined ? [entry] : (entry.options ?? []),
        );
        // Semi-controlled semantics (real Steam DropDownControl): WITHOUT the
        // `controlled` flag the component keeps its own state value (only a
        // prop CHANGE resyncs it); WITH `controlled: true` the displayed
        // value always derives from selectedOption. The pickers pass
        // controlled: true so a cancelled download snaps the label back.
        const internalState = window.React.useState(props.selectedOption);
        const value = props.controlled === true ? props.selectedOption : internalState[0];
        const selected = flat.find((option) => option.data === value);
        return h(
            "div",
            { className: "decky-dropdown" },
            h("span", { className: "decky-dropdown-label" }, props.label),
            h(
                "span",
                { className: "decky-dropdown-value" },
                h("span", null, selected ? selected.label : String(value)),
                h("span", { className: "decky-dropdown-chevron", "aria-hidden": "true" }, "▼"),
            ),
        );
    }

    function ProgressBar(props) {
        const indeterminate = props.indeterminate === true;
        return h(
            "div",
            { className: "decky-progress", role: "progressbar" },
            h("div", {
                className: "decky-progress-fill" + (indeterminate ? " indeterminate" : ""),
                style: indeterminate
                    ? undefined
                    : { width: `${Math.max(0, Math.min(100, props.nProgress ?? 0))}%` },
            }),
        );
    }

    function ButtonItem(props) {
        // Real ButtonItem renders the row label next to the action button.
        // Callers that pass the SAME string as label and children (setup
        // retry, diagnostics restart) render the single button exactly as
        // before; the catalog picker (ADR-011) passes a rich label node plus
        // a short action child and gets the label block above the button.
        const label = props.label;
        const showLabelBlock = label !== undefined && label !== props.children;
        return h(
            "div",
            { className: "decky-buttonitem" },
            showLabelBlock ? h("div", { className: "decky-buttonitem-label" }, label) : null,
            h(
                "button",
                {
                    className: "decky-button",
                    disabled: props.disabled === true,
                    onClick: props.onClick,
                },
                props.children ?? props.label,
            ),
        );
    }

    if (typeof document !== "undefined") {
        const style = document.createElement("style");
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    /**
     * Steam modal structure stand-ins (v0.2.5 on-device fix). The REAL
     * components resolve from Steam's webpack runtime at loader time
     * (@decky/ui dist/components/Modal.js + Dialog.js); on the device the
     * loader-injected DFL global exposes exactly these names (runtime-probed
     * via CDP). The emulations below mirror the verified real DOM:
     *
     * - ModalRoot (= Steam's GenericDialogModal) draws the centered dialog
     *   box and funnels EVERY dismissal (X close icon, background mousedown,
     *   Esc in the real client) into the ONE closeModal callback; Steam does
     *   not close the modal itself, the callback must do it.
     * - DialogHeader/DialogBody/DialogBodyText/DialogFooter are the Steam
     *   dialog divs the modal content composes (same skeleton Steam's own
     *   ConfirmModal renders).
     * - DialogButton is the secondary dialog button (Steam's "Cancel" style).
     *
     * data-* props are forwarded so contract markers and harness geometry
     * survive into the emulated DOM.
     */
    function ModalRoot(props) {
        const { children, className, closeModal, ...rest } = props;
        const dismiss = typeof closeModal === "function" ? closeModal : undefined;
        return h(
            "div",
            {
                ...rest,
                className: className ? `${className} decky-modal-position` : "decky-modal-position",
                "data-modal-root": "true",
                onMouseDown: (ev) => {
                    // Real ModalPosition: mousedown outside the dialog dismisses
                    // unless bDisableBackgroundDismiss (same funnel as Esc/X).
                    if (
                        ev.currentTarget !== ev.target ||
                        props.bDisableBackgroundDismiss === true
                    ) {
                        return;
                    }
                    if (dismiss) {
                        dismiss();
                    }
                },
            },
            h(
                "button",
                { className: "decky-modal-dismiss", "aria-label": "Close", onClick: dismiss },
                "✕",
            ),
            h("div", { className: "decky-modal-dialog", role: "dialog" }, children),
        );
    }

    function dialogDiv(className) {
        return function DialogPart(props) {
            const { children, className: extra, ...rest } = props;
            return h(
                "div",
                { ...rest, className: extra ? `${className} ${extra}` : className },
                children,
            );
        };
    }

    const DialogHeader = dialogDiv("decky-modal-header");
    const DialogBody = dialogDiv("decky-modal-body");
    const DialogBodyText = dialogDiv("decky-modal-bodytext");
    const DialogFooter = dialogDiv("decky-modal-footer");

    function DialogButton(props) {
        const { children, className: extra, ...rest } = props;
        return h(
            "button",
            {
                type: "button",
                ...rest,
                className: extra ? `decky-button ${extra}` : "decky-button",
            },
            children,
        );
    }

    /**
     * Steam's ConfirmModal (decky/ui ConfirmModalProps): title, description
     * and the OK/Cancel button pair; bDestructiveWarning marks the OK
     * button with the warning color. The real dialog closes itself after
     * either press (the modal host owns the close); this static re-creation
     * only guarantees the import resolves and the visual tokens render —
     * confirm interactions are covered by the component tests.
     */
    function ConfirmModal(props) {
        const {
            strTitle,
            strDescription,
            strOKButtonText,
            strCancelButtonText,
            onOK,
            onCancel,
            bDestructiveWarning,
        } = props;
        return h(
            ModalRoot,
            { closeModal: onCancel },
            strTitle !== undefined ? h(DialogHeader, null, strTitle) : null,
            h(
                DialogBody,
                null,
                strDescription !== undefined ? h(DialogBodyText, null, strDescription) : null,
                h(
                    "div",
                    { className: "decky-modal-footer" },
                    h(
                        DialogButton,
                        {
                            onClick: onOK,
                            ...(bDestructiveWarning === true
                                ? { "data-destructive-warning": "true" }
                                : {}),
                        },
                        strOKButtonText ?? "OK",
                    ),
                    h(DialogButton, { onClick: onCancel }, strCancelButtonText ?? "Cancel"),
                ),
            ),
        );
    }

    /**
     * Emulated Steam modal host for the harness: renders the given React node
     * RAW into a fullscreen overlay outside #visual-root — exactly the
     * boundary the real showModal provides (it adds no chrome of its own; the
     * dialog box is drawn by the ModalRoot inside the node). strTitle becomes
     * the overlay's aria-label; fnOnClose fires on every close (ours or the
     * harness window), like the Steam contract the panel relies on for
     * dismissal-cancels-download.
     */
    function showModal(node, _parent, props) {
        const overlay = document.createElement("div");
        overlay.className = "decky-modal-overlay";
        overlay.setAttribute("data-modal-overlay", "true");
        const title = props && props.strTitle;
        if (typeof title === "string" && title.length > 0) {
            overlay.setAttribute("aria-label", title);
        }
        const host = document.createElement("div");
        overlay.appendChild(host);
        document.body.appendChild(overlay);
        const container = window.ReactDOM.createRoot(host);
        container.render(node);
        let closed = false;
        return {
            Close: () => {
                if (closed) {
                    return;
                }
                closed = true;
                container.unmount();
                overlay.remove();
                if (props && typeof props.fnOnClose === "function") {
                    props.fnOnClose();
                }
            },
            Update: (next) => {
                container.render(next);
            },
        };
    }

    window.DeckyUI = {
        PanelSection,
        PanelSectionRow,
        Field,
        ToggleField,
        SliderField,
        DropdownItem,
        ProgressBar,
        ButtonItem,
        ModalRoot,
        DialogHeader,
        DialogBody,
        DialogBodyText,
        DialogFooter,
        DialogButton,
        ConfirmModal,
        showModal,
    };
})();

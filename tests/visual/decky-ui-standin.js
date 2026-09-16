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
        const selected = (props.rgOptions || []).find(
            (option) => option.data === props.selectedOption,
        );
        return h(
            "div",
            { className: "decky-dropdown" },
            h("span", { className: "decky-dropdown-label" }, props.label),
            h(
                "span",
                { className: "decky-dropdown-value" },
                h("span", null, selected ? selected.label : String(props.selectedOption)),
                h("span", { className: "decky-dropdown-chevron", "aria-hidden": "true" }, "▼"),
            ),
        );
    }

    function ButtonItem(props) {
        return h(
            "button",
            {
                className: "decky-button",
                disabled: props.disabled === true,
                onClick: props.onClick,
            },
            props.children ?? props.label,
        );
    }

    if (typeof document !== "undefined") {
        const style = document.createElement("style");
        style.textContent = CSS;
        document.head.appendChild(style);
    }

    window.DeckyUI = {
        PanelSection,
        PanelSectionRow,
        Field,
        ToggleField,
        SliderField,
        DropdownItem,
        ButtonItem,
    };
})();

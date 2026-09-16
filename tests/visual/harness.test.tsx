/**
 * Visual-harness render smoke: every captured state must mount without
 * throwing and render the expected real surface (§19/§20/§80 acceptance).
 * The @decky/ui primitives are stubbed exactly like the other contract
 * tests — outside Steam they cannot resolve — while the components under
 * test are the real presentation components.
 */

import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountVisualHarness, CAPTURED_CASES } from "./harness-entry";

vi.mock("@decky/ui", async () => {
    const React = await import("react");
    const h = React.createElement;
    type Children = import("react").ReactNode;
    return {
        PanelSection: (props: { title?: string; children?: Children }) =>
            h("section", { "data-panel-title": props.title }, props.children),
        PanelSectionRow: (props: { children?: Children }) => h("div", null, props.children),
        ToggleField: (props: { label: string; checked: boolean }) =>
            h("label", { "data-toggle": props.label }, `${props.label}: ${String(props.checked)}`),
        SliderField: (props: { label: string; value: number }) =>
            h("label", { "data-slider": props.label }, `${props.label}: ${String(props.value)}`),
        DropdownItem: (props: { label: string; selectedOption: unknown }) =>
            h(
                "label",
                { "data-dropdown": props.label },
                `${props.label}: ${String(props.selectedOption)}`,
            ),
        ButtonItem: (props: { label?: string; children?: Children }) =>
            h("button", null, props.children ?? props.label),
        Field: (props: { label: string; children?: Children }) =>
            h(
                "div",
                { "data-field": props.label },
                h("span", { "data-field-label": props.label }, props.label),
                h("span", { "data-field-value": props.label }, props.children),
            ),
    };
});

afterEach(cleanup);

describe("visual harness smoke", () => {
    for (const params of CAPTURED_CASES) {
        const name = `${params.caseId} / ${params.locale} / ${params.stateKind}`;
        it(`mounts the captured state without throwing: ${name}`, async () => {
            const host = document.createElement("div");
            document.body.appendChild(host);
            let dispose: (() => void) | null = null;
            await act(async () => {
                dispose = mountVisualHarness(host, params);
            });
            try {
                expect(host.childElementCount).toBeGreaterThan(0);
                if (params.caseId === "panel") {
                    // Panel title and §80 sections render as titled sections.
                    const panelTitle = params.locale === "de" ? "Spracheingabe" : "Voice Keyboard";
                    expect(host.querySelector(`[data-panel-title="${panelTitle}"]`)).not.toBeNull();
                    const speechTitle = params.locale === "de" ? "Spracherkennung" : "Speech";
                    expect(
                        host.querySelector(`[data-panel-title="${speechTitle}"]`),
                    ).not.toBeNull();
                } else {
                    // All four §20 button states in one clip.
                    for (const state of ["ready", "recording", "processing", "error"]) {
                        expect(host.querySelector(`button[data-state="${state}"]`)).not.toBeNull();
                    }
                    // Recording timer + localized §68 error flash.
                    expect(
                        host.querySelector('button[data-state="recording"]')?.textContent,
                    ).toMatch(/^\d{2}:\d{2}$/);
                    const flash = document.querySelector('[role="status"]');
                    expect(flash?.textContent?.length ?? 0).toBeGreaterThan(0);
                    if (params.locale === "de") {
                        expect(flash?.textContent).toContain("Transkription");
                    }
                }
            } finally {
                await act(async () => {
                    dispose?.();
                });
                host.remove();
            }
        });
    }
});

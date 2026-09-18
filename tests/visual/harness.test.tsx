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
        ButtonItem: (props: { label?: Children; disabled?: boolean; children?: Children }) =>
            h(
                "div",
                { "data-buttonitem": true },
                // Same convention as the decky-ui stand-in: a rich label node
                // (catalog picker rows) renders as a label block; callers
                // passing the same string as label and children render the
                // single button exactly as before.
                props.label !== undefined && props.label !== props.children
                    ? h("div", { "data-buttonitem-label": true }, props.label)
                    : null,
                h("button", { disabled: props.disabled === true }, props.children ?? props.label),
            ),
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
        const name = `${params.caseId} / ${params.locale} / ${
            params.caseId === "setup"
                ? params.setup
                : params.caseId === "dictation"
                  ? params.dictation
                  : params.catalog !== undefined && params.catalog !== "none"
                    ? `catalog-${params.catalog}`
                    : params.stateKind
        }`;
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
                    // The plugin name is the brand string in every locale.
                    const panelTitle = "SpeechToDeck";
                    expect(host.querySelector(`[data-panel-title="${panelTitle}"]`)).not.toBeNull();
                    const speechTitle = params.locale === "de" ? "Spracherkennung" : "Speech";
                    expect(
                        host.querySelector(`[data-panel-title="${speechTitle}"]`),
                    ).not.toBeNull();
                    // Catalog-driven ModelPicker cases (ADR-011): the REAL
                    // picker renders the canned defaults/models.json catalog
                    // with the Recommended / More / For-<language> groups.
                    if (params.catalog !== undefined && params.catalog !== "none") {
                        expect(host.querySelector("[data-model-catalog]")).not.toBeNull();
                        expect(
                            host.querySelector('[data-model-group="recommended"]'),
                        ).not.toBeNull();
                        expect(host.querySelector('[data-model-group="more"]')).not.toBeNull();
                        expect(
                            host.querySelector('[data-model-group="for-language"]'),
                        ).not.toBeNull();
                        expect(host.textContent).toContain("For de");
                        expect(host.textContent).toContain("Large v3 Turbo German Q5_0");
                        if (params.catalog === "ready") {
                            // Install-state variety: installed rows offer Use,
                            // the selected model reports In use, the rest
                            // offer the download first.
                            expect(host.textContent).toContain("Use");
                            expect(host.textContent).toContain("In use");
                            expect(host.textContent).toContain("Download");
                        } else {
                            // Downloading variant: the in-flight row offers
                            // Cancel; the single-flight lock keeps the other
                            // Download buttons disabled (§52).
                            const buttons = Array.from(host.querySelectorAll("button"));
                            expect(buttons.some((button) => button.textContent === "Cancel")).toBe(
                                true,
                            );
                            const downloads = buttons.filter(
                                (button) => button.textContent === "Download",
                            );
                            expect(downloads.length).toBeGreaterThan(0);
                            expect(downloads.every((button) => button.disabled)).toBe(true);
                        }
                    }
                } else if (params.caseId === "setup") {
                    // The real setup-progress surface: present while running
                    // or failed, hidden on the terminal ready snapshot. The
                    // hydrated-failed case renders the failed state from the
                    // §30 status report alone (no live event).
                    const setupBlock = host.querySelector("[data-setup-progress]");
                    if (params.setup === "ready") {
                        expect(setupBlock).toBeNull();
                    } else {
                        expect(setupBlock).not.toBeNull();
                        expect(setupBlock?.getAttribute("data-setup-progress")).toBe(
                            params.setup === "download"
                                ? "model.ensure"
                                : params.setup === "indeterminate"
                                  ? "daemon.start"
                                  : "failed",
                        );
                        expect(host.querySelectorAll("li")).toHaveLength(4);
                        expect(setupBlock?.querySelector('[role="progressbar"]')).not.toBeNull();
                        const failed =
                            params.setup === "failed" || params.setup === "hydrated-failed";
                        expect(setupBlock?.querySelector("button") !== null).toBe(failed);
                        if (params.setup === "hydrated-failed") {
                            // The hydrated failure carries the stored §68 code.
                            expect(setupBlock?.textContent).toContain("MODEL_DOWNLOAD_FAILED");
                        }
                        if (failed && params.locale === "de") {
                            expect(setupBlock?.textContent).toContain("Fehlgeschlagen");
                        }
                    }
                } else if (params.caseId === "dictation") {
                    // The v0.2 dictation card: big button from the §8 state
                    // union; the recording variant carries a 24-bar strip fed
                    // by real frames; the transcript variant the settled
                    // transcript + clipboard block.
                    const button = host.querySelector("button[data-state]");
                    expect(button).not.toBeNull();
                    expect(
                        button?.getAttribute("data-state") === "recording" ||
                            button?.getAttribute("data-state") === "ready",
                    ).toBe(true);
                    const strip = host.querySelector("[data-level-strip]");
                    if (params.dictation === "recording") {
                        expect(strip).not.toBeNull();
                        expect(host.querySelectorAll("[data-level-bar]")).toHaveLength(24);
                        // Real received frames: the newest bar is not idle.
                        expect(
                            strip
                                ?.querySelector('[data-level-bar="23"]')
                                ?.getAttribute("data-level-value"),
                        ).not.toBe("0.00");
                    } else {
                        expect(strip).toBeNull();
                    }
                    if (params.dictation === "transcript") {
                        const block = host.querySelector("[data-transcript-block]");
                        expect(block).not.toBeNull();
                        expect(
                            (block?.querySelector("[data-transcript-preview]")?.textContent
                                ?.length ?? 0) > 0,
                        ).toBe(true);
                        expect(
                            block?.querySelector('[data-clipboard-status="copied"]'),
                        ).not.toBeNull();
                        expect(host.querySelector("[data-copy-again]")).not.toBeNull();
                    } else {
                        expect(host.querySelector("[data-transcript-block]")).toBeNull();
                    }
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

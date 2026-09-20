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

// showModal capture shared with the assertions below (written by the mock).
const modalCapture = vi.hoisted(() => ({
    current: null as { node: unknown; closed: boolean } | null,
}));

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
        // Semi-controlled Steam semantics: with `controlled: true` the
        // displayed value derives from selectedOption (the pickers' revert
        // oracle); without it, from internal state.
        DropdownItem: (props: {
            label: string;
            rgOptions?: {
                data?: unknown;
                label?: Children;
                options?: { data: unknown; label: Children }[];
            }[];
            selectedOption: unknown;
            controlled?: boolean;
        }) => {
            const state = React.useState(props.selectedOption);
            const value = props.controlled === true ? props.selectedOption : state[0];
            type FlatOption = { data: unknown; label?: Children };
            const flat = (props.rgOptions ?? []).flatMap<FlatOption>((entry) =>
                entry.data !== undefined
                    ? [{ data: entry.data, label: entry.label }]
                    : (entry.options ?? []),
            );
            const selected = flat.find((option) => option.data === value);
            return h(
                "label",
                { "data-dropdown": props.label },
                `${props.label}: ${selected ? String(selected.label) : String(value)}`,
            );
        },
        ProgressBar: (props: { indeterminate?: boolean; nProgress?: number }) =>
            h("div", {
                "data-progressbar": true,
                "data-indeterminate": String(props.indeterminate === true),
                ...(props.nProgress !== undefined
                    ? { "data-nprogress": String(props.nProgress) }
                    : {}),
            }),
        // Steam modal structure (v0.2.5 on-device fix): the download modal
        // renders ModalRoot + the dialog primitives. The smoke test only
        // captures the modal node (showModal below), so plain divs suffice.
        ModalRoot: (props: { children?: Children }) => h("div", null, props.children),
        DialogHeader: (props: { children?: Children }) => h("div", null, props.children),
        DialogBody: (props: { children?: Children }) => h("div", null, props.children),
        DialogBodyText: (props: Record<string, unknown> & { children?: Children }) => {
            const { children, ...rest } = props;
            return h("div", rest, children);
        },
        DialogFooter: (props: { children?: Children }) => h("div", null, props.children),
        DialogButton: (props: { onClick?: () => void; children?: Children }) =>
            h("button", { onClick: props.onClick }, props.children),
        // Steam's confirm dialog (in-app model cleanup): the smoke only
        // mounts the surfaces — the confirm opens on a user press, so a
        // plain rendering stub suffices here (behavior covered by
        // ManageModels.test.tsx).
        ConfirmModal: (props: Record<string, unknown> & { children?: Children }) => {
            const { children, ...rest } = props;
            return h("div", rest, children);
        },
        showModal: (node: Children) => {
            modalCapture.current = { node, closed: false };
            return {
                Close: () => {
                    modalCapture.current =
                        modalCapture.current === null
                            ? null
                            : { ...modalCapture.current, closed: true };
                },
                Update: () => undefined,
            };
        },
        ButtonItem: (props: { label?: Children; disabled?: boolean; children?: Children }) =>
            h(
                "div",
                { "data-buttonitem": true },
                // Same convention as the decky-ui stand-in: a rich label node
                // renders as a label block; callers passing the same string
                // as label and children render the single button exactly as
                // before.
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

afterEach(() => {
    cleanup();
    modalCapture.current = null;
});

describe("visual harness smoke", () => {
    for (const params of CAPTURED_CASES) {
        const name = `${params.caseId} / ${params.locale} / ${
            params.caseId === "setup"
                ? params.setup
                : params.caseId === "dictation"
                  ? params.dictation
                  : params.settingsLoad === "failed"
                    ? "load-failed"
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
                    // Honest boot-load failed state (v0.2.9): the panel
                    // early-returns with alert + hint + Retry — the §80
                    // sections and the eternal spinner never render.
                    if (params.settingsLoad === "failed") {
                        expect(host.querySelector('[role="alert"]')?.textContent).toContain(
                            "Backend is not responding.",
                        );
                        expect(host.textContent).toContain("Close and reopen this panel");
                        const retry = Array.from(host.querySelectorAll("button")).find(
                            (button) => button.textContent === "Retry",
                        );
                        expect(retry).not.toBeUndefined();
                        expect(host.querySelector('[data-panel-title="Speech"]')).toBeNull();
                        expect(host.textContent).not.toContain("Loading settings…");
                        return; // handled inside try/finally below
                    }
                    const speechTitle = params.locale === "de" ? "Spracherkennung" : "Speech";
                    expect(
                        host.querySelector(`[data-panel-title="${speechTitle}"]`),
                    ).not.toBeNull();
                    // Model-select cases (ADR-011, v0.2.5): the REAL select
                    // renders the canned defaults/models.json catalog; the
                    // modal variant additionally opens the REAL download
                    // modal through the production path.
                    if (params.catalog !== undefined && params.catalog !== "none") {
                        expect(host.querySelector("[data-model-select]")).not.toBeNull();
                        expect(host.textContent).toContain("Model");
                        if (params.catalog === "ready") {
                            expect(modalCapture.current).toBeNull();
                        } else {
                            // The download modal (catalog=modal) and the manage
                            // modal (catalog=manage) both opened through their
                            // production showModal paths and are still open.
                            expect(modalCapture.current).not.toBeNull();
                            expect(modalCapture.current?.closed).toBe(false);
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

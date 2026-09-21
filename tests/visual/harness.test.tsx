import { act, cleanup } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountVisualHarness, CAPTURED_CASES } from "./harness-entry";

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
                    const panelTitle = "SpeechToDeck";
                    expect(host.querySelector(`[data-panel-title="${panelTitle}"]`)).not.toBeNull();
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
                        return;
                    }
                    const speechTitle = params.locale === "de" ? "Spracherkennung" : "Speech";
                    expect(
                        host.querySelector(`[data-panel-title="${speechTitle}"]`),
                    ).not.toBeNull();
                    if (params.catalog !== undefined && params.catalog !== "none") {
                        expect(host.querySelector("[data-model-select]")).not.toBeNull();
                        expect(host.textContent).toContain("Model");
                        if (params.catalog === "ready") {
                            expect(modalCapture.current).toBeNull();
                        } else {
                            expect(modalCapture.current).not.toBeNull();
                            expect(modalCapture.current?.closed).toBe(false);
                        }
                    }
                } else if (params.caseId === "setup") {
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
                            expect(setupBlock?.textContent).toContain("MODEL_DOWNLOAD_FAILED");
                        }
                        if (failed && params.locale === "de") {
                            expect(setupBlock?.textContent).toContain("Fehlgeschlagen");
                        }
                    }
                } else if (params.caseId === "dictation") {
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
                    for (const state of ["ready", "recording", "processing", "error"]) {
                        expect(host.querySelector(`button[data-state="${state}"]`)).not.toBeNull();
                    }
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

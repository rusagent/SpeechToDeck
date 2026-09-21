import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { ModelSelect } from "../../src/presentation/settings/ModelSelect";
import { ModelCatalogStore, type CatalogModel } from "../../src/application/ports/ModelCatalogPort";
import type { Locale } from "../../src/presentation/i18n/messages";

vi.mock("@decky/ui", async () => {
    const React = await import("react");
    const h = React.createElement;
    type Children = import("react").ReactNode;
    interface GroupEntry {
        data?: unknown;
        label?: Children;
        options?: GroupEntry[];
    }
    const captured: {
        node: Children;
        props: { strTitle?: string; fnOnClose?: () => void };
        close: ReturnType<typeof vi.fn>;
        update: ReturnType<typeof vi.fn>;
    }[] = [];
    return {
        DropdownItem: (props: {
            label: string;
            rgOptions: GroupEntry[];
            selectedOption: unknown;
            controlled?: boolean;
            onChange?: (option: GroupEntry) => void;
        }) => {
            const state = React.useState(props.selectedOption);
            const value = props.controlled === true ? props.selectedOption : state[0];
            const flat = props.rgOptions.flatMap((group: GroupEntry) =>
                group.data !== undefined ? [group] : (group.options ?? []),
            );
            const selected = flat.find((option: GroupEntry) => option.data === value);
            return h(
                "div",
                { "data-dropdown": props.label },
                h("span", { "data-selected": true }, selected ? selected.label : String(value)),
                props.rgOptions.map((group: GroupEntry, groupIndex: number) =>
                    group.data !== undefined
                        ? null
                        : h(
                              "div",
                              { key: `group-${groupIndex}`, "data-group": group.label },
                              h("span", { "data-group-label": true }, group.label),
                              (group.options ?? []).map((option: GroupEntry) =>
                                  h(
                                      "button",
                                      {
                                          key: String(option.data),
                                          "data-model-option": String(option.data),
                                          onClick: () => {
                                              if (props.controlled !== true) {
                                                  state[1](option.data);
                                              }
                                              props.onChange?.(option);
                                          },
                                      },
                                      option.label,
                                  ),
                              ),
                          ),
                ),
            );
        },
        ModalRoot: (props: { closeModal?: () => void; children?: Children }) =>
            h(
                "div",
                { "data-modal-root": true },
                h("button", {
                    "data-modal-dismiss": true,
                    onClick: () => props.closeModal?.(),
                }),
                props.children,
            ),
        DialogHeader: (props: { children?: Children }) =>
            h("div", { "data-modal-header": true }, props.children),
        DialogBody: (props: { children?: Children }) => h("div", null, props.children),
        DialogBodyText: (props: Record<string, unknown> & { children?: Children }) => {
            const { children, ...rest } = props;
            return h("div", rest, children);
        },
        DialogFooter: (props: { children?: Children }) => h("div", null, props.children),
        DialogButton: (props: { onClick?: () => void; children?: Children }) =>
            h("button", { onClick: props.onClick }, props.children),
        ProgressBar: (props: { indeterminate?: boolean; nProgress?: number }) =>
            h("div", {
                role: "progressbar",
                "data-progressbar": true,
                "data-indeterminate": String(props.indeterminate === true),
                ...(props.nProgress !== undefined
                    ? { "data-nprogress": String(props.nProgress) }
                    : {}),
            }),
        showModal: (
            node: Children,
            _parent: unknown,
            props: { strTitle?: string; fnOnClose?: () => void },
        ) => {
            const handle = {
                node,
                props,
                close: vi.fn(),
                update: vi.fn(),
            };
            captured.push(handle);
            return { Close: () => handle.close(), Update: () => handle.update() };
        },
        __capturedModals: captured,
    };
});

const deckyUi = await import("@decky/ui");
const capturedModals = (deckyUi as unknown as { __capturedModals: CapturedModal[] })
    .__capturedModals;

interface CapturedModal {
    node: ReactNode;
    props: { strTitle?: string; fnOnClose?: () => void };
    close: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
}

afterEach(cleanup);

function model(overrides: Partial<CatalogModel>): CatalogModel {
    return {
        id: "base",
        engine: "whisper",
        multilingual: true,
        filename: "ggml-base.bin",
        installed: false,
        ...overrides,
    };
}

function seedStore(store: ModelCatalogStore): void {
    store.setModels([
        model({
            id: "whisper-large-v3-turbo-q5_0",
            filename: "ggml-large-v3-turbo-q5_0.bin",
            sizeBytes: 574_041_195,
            description: "Recommended primary model: near large-v3 accuracy at turbo speed.",
        }),
        model({ id: "tiny", filename: "ggml-tiny.bin", sizeBytes: 77_691_713, installed: true }),
        model({ id: "base", filename: "ggml-base.bin", sizeBytes: 147_951_465, installed: true }),
        model({
            id: "whisper-large-v3-turbo-german-q5_0",
            filename: "ggml-primeline-de-turbo-q5_0.bin",
            sizeBytes: 574_041_195,
            languages: ["de"],
        }),
        model({
            id: "distil-small-en",
            engine: "whisper",
            multilingual: false,
            filename: "ggml-distil-small.en.bin",
            sizeBytes: 336_191_657,
            languages: ["en"],
        }),
        model({
            id: "whisper-large-v3-french-q5_0",
            filename: "ggml-bofeng-fr-q5_0.bin",
            sizeBytes: 1_081_140_203,
            languages: ["fr"],
        }),
        model({
            id: "kotoba-whisper-v2.0-q5_0",
            filename: "ggml-kotoba-v2-q5_0.bin",
            sizeBytes: 537_819_875,
            languages: ["ja"],
        }),
    ]);
}

interface Handlers {
    onChange?: (modelId: string) => void;
    onDownload?: (modelId: string) => void;
    onCancel?: () => void;
}

function renderSelect(store: ModelCatalogStore, locale: Locale = "en", handlers: Handlers = {}) {
    return render(
        <ModelSelect
            value="base"
            locale={locale}
            store={store}
            onChange={handlers.onChange ?? (() => undefined)}
            onDownload={handlers.onDownload ?? (() => undefined)}
            onCancel={handlers.onCancel ?? (() => undefined)}
        />,
    );
}

function lastModal(): CapturedModal {
    const modal = capturedModals.at(-1);
    expect(modal).toBeDefined();
    return modal!;
}

function expectSelectedLabel(label: string): void {
    const node = document.querySelector("[data-selected]");
    expect(node).not.toBeNull();
    expect(node!.textContent).toBe(label);
}

describe("ModelSelect", () => {
    it("renders grouped options with localized names, sizes and the recommended suffix", () => {
        const store = new ModelCatalogStore();
        seedStore(store);
        renderSelect(store);

        expect(screen.getByText("Tiny (fastest) · 78 MB")).not.toBeNull();
        expect(screen.getByText("Large v3 Turbo Q5_0 · 574 MB · Recommended")).not.toBeNull();
        expect(screen.getByText("Large v3 Turbo German Q5_0 · 574 MB")).not.toBeNull();
        expect(screen.getByText("Distil Small (English) · 336 MB")).not.toBeNull();
        expect(screen.getByText("Large v3 French Q5_0 · 1.1 GB")).not.toBeNull();
        expect(screen.getByText("Kotoba v2.0 Japanese Q5_0 · 538 MB")).not.toBeNull();
        expectSelectedLabel("Base (default) · 148 MB");
    });

    it("groups General first, then one native-labeled group per language (catalog order)", () => {
        const store = new ModelCatalogStore();
        seedStore(store);
        renderSelect(store);

        const groupLabels = Array.from(document.querySelectorAll("[data-group-label]")).map(
            (node) => node.textContent,
        );
        expect(groupLabels).toEqual(["General", "Deutsch", "English", "Français", "日本語"]);

        const generalGroup = document.querySelector('[data-group="General"]');
        expect(generalGroup?.querySelector('[data-model-option="base"]')).not.toBeNull();
        expect(
            generalGroup?.querySelector('[data-model-option="whisper-large-v3-turbo-german-q5_0"]'),
        ).toBeNull();
        expect(
            document.querySelector(
                '[data-group="Deutsch"] [data-model-option="whisper-large-v3-turbo-german-q5_0"]',
            ),
        ).not.toBeNull();
    });

    it("lists every language group regardless of the language setting", () => {
        const store = new ModelCatalogStore();
        seedStore(store);
        renderSelect(store);

        expect(screen.getByText("Large v3 Turbo German Q5_0 · 574 MB")).not.toBeNull();
        expect(screen.getByText("Kotoba v2.0 Japanese Q5_0 · 538 MB")).not.toBeNull();
    });

    it("persists update({modelId}) immediately for an installed model", () => {
        const store = new ModelCatalogStore();
        seedStore(store);
        const onChange = vi.fn();
        const onDownload = vi.fn();
        renderSelect(store, "en", { onChange, onDownload });

        fireEvent.click(screen.getByRole("button", { name: "Tiny (fastest) · 78 MB" }));

        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenCalledWith("tiny");
        expect(onDownload).not.toHaveBeenCalled();
        expect(capturedModals).toHaveLength(0);
    });

    it("opens the download modal for a not-installed model without persisting (dropdown reverts)", () => {
        const store = new ModelCatalogStore();
        seedStore(store);
        const onChange = vi.fn();
        const onDownload = vi.fn();
        renderSelect(store, "en", { onChange, onDownload });

        fireEvent.click(
            screen.getByRole("button", { name: "Large v3 Turbo Q5_0 · 574 MB · Recommended" }),
        );

        expect(onDownload).toHaveBeenCalledTimes(1);
        expect(onDownload).toHaveBeenCalledWith("whisper-large-v3-turbo-q5_0");
        expect(onChange).not.toHaveBeenCalled();
        expect(capturedModals).toHaveLength(1);
        expect(lastModal().props.strTitle).toBe("Large v3 Turbo Q5_0");
        expectSelectedLabel("Base (default) · 148 MB");
    });

    it("shows live progress, holds the full 100% bar on completion, then closes before persisting", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
            const store = new ModelCatalogStore();
            seedStore(store);
            const onChange = vi.fn();
            const onDownload = vi.fn();
            renderSelect(store, "en", { onChange, onDownload });
            fireEvent.click(
                screen.getByRole("button", { name: "Large v3 Turbo Q5_0 · 574 MB · Recommended" }),
            );
            const modal = lastModal();
            render(modal.node);

            expect(
                screen.getByText("Large v3 Turbo Q5_0", { selector: "[data-modal-header]" }),
            ).not.toBeNull();
            expect(document.querySelector("[data-modal-root]")).not.toBeNull();

            await act(async () => {
                store.publishProgress({
                    protocolVersion: 1,
                    modelId: "whisper-large-v3-turbo-q5_0",
                    bytesReceived: 229_616_478,
                    totalBytes: 574_041_195,
                });
            });
            expect(screen.getByText("40%", { selector: "[data-model-percent]" })).not.toBeNull();
            expect(document.querySelector('[data-nprogress="40"]')).not.toBeNull();

            await act(async () => {
                store.publishComplete({
                    protocolVersion: 1,
                    modelId: "whisper-large-v3-turbo-q5_0",
                    sizeBytes: 574_041_195,
                });
            });
            expect(modal.close).not.toHaveBeenCalled();
            expect(onChange).not.toHaveBeenCalled();
            expect(screen.getByText("100%", { selector: "[data-model-percent]" })).not.toBeNull();
            expect(document.querySelector('[data-nprogress="100"]')).not.toBeNull();
            expect(screen.queryByRole("button", { name: "Cancel" })).toBeNull();

            await act(async () => {
                await vi.advanceTimersByTimeAsync(500);
            });
            expect(modal.close).toHaveBeenCalledTimes(1);
            expect(onChange).toHaveBeenCalledTimes(1);
            expect(onChange).toHaveBeenCalledWith("whisper-large-v3-turbo-q5_0");
            expect(modal.close.mock.invocationCallOrder[0]).toBeLessThan(
                onChange.mock.invocationCallOrder[0]!,
            );
        } finally {
            vi.useRealTimers();
        }
    });

    it("dismissal during the completion hold completes instead of cancelling", async () => {
        vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
        try {
            const store = new ModelCatalogStore();
            seedStore(store);
            const onChange = vi.fn();
            const onCancel = vi.fn();
            renderSelect(store, "en", { onChange, onCancel });
            fireEvent.click(
                screen.getByRole("button", { name: "Large v3 Turbo Q5_0 · 574 MB · Recommended" }),
            );
            const modal = lastModal();
            render(modal.node);

            await act(async () => {
                store.publishComplete({
                    protocolVersion: 1,
                    modelId: "whisper-large-v3-turbo-q5_0",
                    sizeBytes: 574_041_195,
                });
            });

            const dismiss = document.querySelector("[data-modal-dismiss]");
            expect(dismiss).not.toBeNull();
            fireEvent.click(dismiss!);

            expect(onCancel).not.toHaveBeenCalled();
            expect(modal.close).toHaveBeenCalledTimes(1);
            expect(onChange).toHaveBeenCalledTimes(1);
            expect(onChange).toHaveBeenCalledWith("whisper-large-v3-turbo-q5_0");

            await act(async () => {
                await vi.advanceTimersByTimeAsync(500);
            });
            expect(modal.close).toHaveBeenCalledTimes(1);
            expect(onChange).toHaveBeenCalledTimes(1);
        } finally {
            vi.useRealTimers();
        }
    });

    it("shows the indeterminate preparing state before the first progress frame", async () => {
        const store = new ModelCatalogStore();
        seedStore(store);
        renderSelect(store, "en", {
            onDownload: () => undefined,
        });
        fireEvent.click(
            screen.getByRole("button", { name: "Large v3 Turbo Q5_0 · 574 MB · Recommended" }),
        );
        render(lastModal().node);

        expect(screen.getByText("Starting download…")).not.toBeNull();
        expect(document.querySelector('[data-indeterminate="true"]')).not.toBeNull();
    });

    it("cancel closes the modal, cancels the download, persists nothing and reverts the label", async () => {
        const store = new ModelCatalogStore();
        seedStore(store);
        const onChange = vi.fn();
        const onCancel = vi.fn();
        renderSelect(store, "en", { onChange, onCancel });
        fireEvent.click(
            screen.getByRole("button", { name: "Large v3 Turbo Q5_0 · 574 MB · Recommended" }),
        );
        const modal = lastModal();
        render(modal.node);

        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

        expect(onCancel).toHaveBeenCalledTimes(1);
        expect(onChange).not.toHaveBeenCalled();
        expect(modal.close).toHaveBeenCalledTimes(1);
        expectSelectedLabel("Base (default) · 148 MB");
    });

    it("dismissal (Esc/close icon) cancels the download and persists nothing", () => {
        const store = new ModelCatalogStore();
        seedStore(store);
        const onChange = vi.fn();
        const onCancel = vi.fn();
        renderSelect(store, "en", { onChange, onCancel });
        fireEvent.click(
            screen.getByRole("button", { name: "Large v3 Turbo Q5_0 · 574 MB · Recommended" }),
        );
        const modal = lastModal();
        render(modal.node);

        const dismiss = document.querySelector("[data-modal-dismiss]");
        expect(dismiss).not.toBeNull();
        fireEvent.click(dismiss!);

        expect(onCancel).toHaveBeenCalledTimes(1);
        expect(onChange).not.toHaveBeenCalled();
        expect(modal.close).toHaveBeenCalledTimes(1);
        expectSelectedLabel("Base (default) · 148 MB");

        act(() => {
            modal.props.fnOnClose?.();
        });
        expect(onCancel).toHaveBeenCalledTimes(1);
    });

    it("a failed download switches the modal to the error state with the backend detail and reverts the label", async () => {
        const store = new ModelCatalogStore();
        seedStore(store);
        const onChange = vi.fn();
        const onCancel = vi.fn();
        renderSelect(store, "en", { onChange, onCancel });
        fireEvent.click(
            screen.getByRole("button", { name: "Large v3 Turbo Q5_0 · 574 MB · Recommended" }),
        );
        const modal = lastModal();
        render(modal.node);

        await act(async () => {
            store.publishFailure("whisper-large-v3-turbo-q5_0", "HTTP 403 host=huggingface.co");
        });
        expect(screen.getByText("Download failed")).not.toBeNull();
        expect(screen.getByText("HTTP 403 host=huggingface.co")).not.toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Close" }));
        expect(modal.close).toHaveBeenCalledTimes(1);
        expect(onCancel).not.toHaveBeenCalled();
        expect(onChange).not.toHaveBeenCalled();
        expectSelectedLabel("Base (default) · 148 MB");
    });

    it("renders the unavailable hint for an empty catalog (reported, never assumed)", () => {
        const store = new ModelCatalogStore();
        renderSelect(store);
        expect(screen.getByText("The model catalog could not be loaded.")).not.toBeNull();
        expect(screen.queryByRole("button")).toBeNull();
    });
});

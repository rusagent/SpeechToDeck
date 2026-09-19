/**
 * ModelSelect tests (§48/§54/§80, ADR-011; v0.2.5 redesign).
 *
 * Named production defect (on-device v0.2.4 session): the old row-based
 * picker reused ONE button as Download when idle and Cancel while
 * downloading, so the owner's tap rhythm cancelled every second download and
 * the backend mapped each cancel to MODEL_DOWNLOAD_FAILED — a pure UX
 * problem that read like repeated network failures. Oracle: the new
 * two-dropdown flow persists only installed selections, opens the download
 * modal for not-installed ones (dropdown stays bound to the persisted
 * model), drives live progress through the guarded store, closes the modal
 * before persisting a completed download, and distinguishes cancel (no
 * persist) from failure (backend detail in the error state).
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { ModelSelect } from "../../src/presentation/settings/ModelSelect";
import { ModelCatalogStore, type CatalogModel } from "../../src/application/ports/ModelCatalogPort";
import type { Locale } from "../../src/presentation/i18n/messages";

// §80 renders through @decky/ui components that expect the Steam UI
// environment. The stubs keep the selection logic (persist vs download
// modal, grouped options, controlled revert) the subject: every dropdown
// option renders as a button, showModal captures its modal node + close
// handle, and ProgressBar exposes its determinate/indeterminate state.
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
            onChange?: (option: GroupEntry) => void;
        }) =>
            h(
                "div",
                { "data-dropdown": props.label },
                h("span", { "data-selected": true }, String(props.selectedOption)),
                props.rgOptions
                    .flatMap((group: GroupEntry) =>
                        group.data !== undefined ? [group] : (group.options ?? []),
                    )
                    .map((option: GroupEntry) =>
                        h(
                            "button",
                            {
                                key: String(option.data),
                                "data-model-option": String(option.data),
                                onClick: () => props.onChange?.(option),
                            },
                            option.label,
                        ),
                    ),
            ),
        ButtonItem: (props: { disabled?: boolean; onClick?: () => void; children?: Children }) =>
            h(
                "button",
                { disabled: props.disabled === true, onClick: props.onClick },
                props.children,
            ),
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

// The test-only export from the mock (typed through the module shape).
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
    ]);
}

interface Handlers {
    onChange?: (modelId: string) => void;
    onDownload?: (modelId: string) => void;
    onCancel?: () => void;
}

function renderSelect(
    store: ModelCatalogStore,
    language = "de",
    locale: Locale = "en",
    handlers: Handlers = {},
) {
    return render(
        <ModelSelect
            value="base"
            locale={locale}
            language={language}
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

describe("ModelSelect", () => {
    it("renders grouped options with localized names, sizes and the recommended suffix", () => {
        const store = new ModelCatalogStore();
        seedStore(store);
        renderSelect(store);

        // General group carries the localized name + decimal size; the two
        // turbo picks carry the localized "Recommended" suffix.
        expect(screen.getByText("Tiny (fastest) · 78 MB")).not.toBeNull();
        expect(screen.getByText("Large v3 Turbo Q5_0 · 574 MB · Recommended")).not.toBeNull();
        // The concrete language selection ("de") appends the specialized group.
        expect(screen.getByText("Large v3 Turbo German Q5_0 · 574 MB")).not.toBeNull();
        // The controlled value stays the persisted model id.
        expect(screen.getByText("base", { selector: "[data-selected]" })).not.toBeNull();
    });

    it("omits the language group for the system/auto sentinels", () => {
        const store = new ModelCatalogStore();
        seedStore(store);
        renderSelect(store, "system");

        expect(screen.queryByText("Large v3 Turbo German Q5_0 · 574 MB")).toBeNull();
    });

    it("persists update({modelId}) immediately for an installed model", () => {
        const store = new ModelCatalogStore();
        seedStore(store);
        const onChange = vi.fn();
        const onDownload = vi.fn();
        renderSelect(store, "de", "en", { onChange, onDownload });

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
        renderSelect(store, "de", "en", { onChange, onDownload });

        fireEvent.click(
            screen.getByRole("button", { name: "Large v3 Turbo Q5_0 · 574 MB · Recommended" }),
        );

        // The download starts, nothing persists, and the controlled dropdown
        // stays bound to the previously selected model while the download
        // runs (§52 single-flight UI contract).
        expect(onDownload).toHaveBeenCalledTimes(1);
        expect(onDownload).toHaveBeenCalledWith("whisper-large-v3-turbo-q5_0");
        expect(onChange).not.toHaveBeenCalled();
        expect(capturedModals).toHaveLength(1);
        expect(lastModal().props.strTitle).toBe("Large v3 Turbo Q5_0");
        expect(screen.getByText("base", { selector: "[data-selected]" })).not.toBeNull();
    });

    it("shows live progress in the modal and closes it before persisting on completion", async () => {
        const store = new ModelCatalogStore();
        seedStore(store);
        const onChange = vi.fn();
        const onDownload = vi.fn();
        renderSelect(store, "de", "en", { onChange, onDownload });
        fireEvent.click(
            screen.getByRole("button", { name: "Large v3 Turbo Q5_0 · 574 MB · Recommended" }),
        );
        const modal = lastModal();
        render(modal.node);

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

        // model_download_complete: the modal closes automatically AND THEN
        // the selection persists (restart fires once).
        await act(async () => {
            store.publishComplete({
                protocolVersion: 1,
                modelId: "whisper-large-v3-turbo-q5_0",
                sizeBytes: 574_041_195,
            });
        });
        expect(modal.close).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenCalledWith("whisper-large-v3-turbo-q5_0");
        expect(modal.close.mock.invocationCallOrder[0]).toBeLessThan(
            onChange.mock.invocationCallOrder[0]!,
        );
    });

    it("shows the indeterminate preparing state before the first progress frame", async () => {
        const store = new ModelCatalogStore();
        seedStore(store);
        renderSelect(store, "de", "en", {
            onDownload: () => undefined,
        });
        fireEvent.click(
            screen.getByRole("button", { name: "Large v3 Turbo Q5_0 · 574 MB · Recommended" }),
        );
        render(lastModal().node);

        expect(screen.getByText("Starting download…")).not.toBeNull();
        expect(document.querySelector('[data-indeterminate="true"]')).not.toBeNull();
    });

    it("cancel closes the modal, cancels the download and persists nothing", async () => {
        const store = new ModelCatalogStore();
        seedStore(store);
        const onChange = vi.fn();
        const onCancel = vi.fn();
        renderSelect(store, "de", "en", { onChange, onCancel });
        fireEvent.click(
            screen.getByRole("button", { name: "Large v3 Turbo Q5_0 · 574 MB · Recommended" }),
        );
        const modal = lastModal();
        render(modal.node);

        fireEvent.click(screen.getByRole("button", { name: "Cancel" }));

        expect(onCancel).toHaveBeenCalledTimes(1);
        expect(onChange).not.toHaveBeenCalled();
        expect(modal.close).toHaveBeenCalledTimes(1);
    });

    it("dismissal (Esc/close icon) cancels the download and persists nothing", () => {
        const store = new ModelCatalogStore();
        seedStore(store);
        const onChange = vi.fn();
        const onCancel = vi.fn();
        renderSelect(store, "de", "en", { onChange, onCancel });
        fireEvent.click(
            screen.getByRole("button", { name: "Large v3 Turbo Q5_0 · 574 MB · Recommended" }),
        );
        const modal = lastModal();

        act(() => {
            modal.props.fnOnClose?.();
        });

        expect(onCancel).toHaveBeenCalledTimes(1);
        expect(onChange).not.toHaveBeenCalled();
    });

    it("a failed download switches the modal to the error state with the backend detail", async () => {
        const store = new ModelCatalogStore();
        seedStore(store);
        const onChange = vi.fn();
        const onCancel = vi.fn();
        renderSelect(store, "de", "en", { onChange, onCancel });
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

        // Close on the error state: the download already settled, so nothing
        // is cancelled and nothing persists.
        fireEvent.click(screen.getByRole("button", { name: "Close" }));
        expect(modal.close).toHaveBeenCalledTimes(1);
        expect(onCancel).not.toHaveBeenCalled();
        expect(onChange).not.toHaveBeenCalled();
    });

    it("renders the unavailable hint for an empty catalog (§57: reported, never assumed)", () => {
        const store = new ModelCatalogStore();
        renderSelect(store);
        expect(screen.getByText("The model catalog could not be loaded.")).not.toBeNull();
        expect(screen.queryByRole("button")).toBeNull();
    });
});

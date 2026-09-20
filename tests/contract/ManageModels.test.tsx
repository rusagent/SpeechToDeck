/**
 * ManageModels tests (in-app model management).
 *
 * Named decision points: (1) the destructive confirmation must name the
 * model, its freed size and the re-download path BEFORE anything is deleted
 * (irreversible-feeling action on a 100+ MB artifact — DeckyEQ-pattern
 * ConfirmModal with bDestructiveWarning); (2) the selected model can never
 * be deleted — its control is visibly disabled AND no confirm can open (the
 * backend rejects it anyway; the UI must not offer a lying control);
 * (3) during an in-flight delete the modal controls lock, dismissal is
 * ignored and an inline "Deleting…" status shows — state-refresh feedback
 * via the existing list_models path, no toasts; (4) "Delete all inactive"
 * confirms ONCE and loops the same per-model callable (no bulk route).
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { openManageModelsModal } from "../../src/presentation/settings/ManageModels";
import { ModelCatalogStore, type CatalogModel } from "../../src/application/ports/ModelCatalogPort";
import type { Locale } from "../../src/presentation/i18n/messages";

// The modal renders through @decky/ui components that expect the Steam UI
// environment. The stubs keep the modal's own logic (installed list, guard,
// confirm, lock, refresh) the subject: ConfirmModal captures its props and
// exposes OK/Cancel probes; showModal captures the opened modal node and its
// close handle; ModalRoot exposes Steam's dismissal funnel.
vi.mock("@decky/ui", async () => {
    const React = await import("react");
    const h = React.createElement;
    type Children = import("react").ReactNode;
    const captured: { node: Children; close: ReturnType<typeof vi.fn> }[] = [];
    const confirms: Record<string, unknown>[] = [];
    const showModalNodes: Children[] = [];
    return {
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
        DialogButton: (
            props: { onClick?: () => void; disabled?: boolean; children?: Children } & Record<
                string,
                unknown
            >,
        ) => {
            const { onClick, disabled, children, ...rest } = props;
            return h("button", { ...rest, onClick, disabled: disabled === true }, children);
        },
        ConfirmModal: (
            props: {
                onOK?: () => void;
                onCancel?: () => void;
            } & Record<string, unknown>,
        ) => {
            confirms.push(props);
            return h(
                "div",
                { "data-confirm": "true" },
                h("button", { "data-confirm-ok": true, onClick: () => props.onOK?.() }, "OK"),
                h(
                    "button",
                    { "data-confirm-cancel": true, onClick: () => props.onCancel?.() },
                    "Cancel",
                ),
            );
        },
        showModal: (node: Children) => {
            const handle = { node, close: vi.fn() };
            captured.push(handle);
            showModalNodes.push(node);
            return { Close: () => handle.close(), Update: () => undefined };
        },
        __captured: captured,
        __confirms: confirms,
        __showModalNodes: showModalNodes,
    };
});

const deckyUi = await import("@decky/ui");
const capturedModals = (deckyUi as unknown as { __captured: CapturedModal[] }).__captured;
const capturedConfirms = (deckyUi as unknown as { __confirms: Record<string, unknown>[] })
    .__confirms;
const showModalNodes = (deckyUi as unknown as { __showModalNodes: ReactNode[] }).__showModalNodes;

/** Renders the confirm dialog captured by the last showModal call. */
function renderLastModal(): void {
    const node = showModalNodes.at(-1);
    expect(node).toBeDefined();
    render(node!);
}

interface CapturedModal {
    node: ReactNode;
    close: ReturnType<typeof vi.fn>;
}

afterEach(() => {
    cleanup();
    capturedModals.length = 0;
    capturedConfirms.length = 0;
    showModalNodes.length = 0;
});

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
            installed: false,
        }),
        model({ id: "tiny", filename: "ggml-tiny.bin", sizeBytes: 77_691_713, installed: true }),
        model({ id: "base", filename: "ggml-base.bin", sizeBytes: 147_951_465, installed: true }),
        model({
            id: "distil-small-en",
            engine: "whisper",
            multilingual: false,
            filename: "ggml-distil-small.en.bin",
            sizeBytes: 336_191_657,
            installed: true,
            languages: ["en"],
        }),
    ]);
}

interface Handlers {
    onDelete?: (modelId: string) => Promise<void>;
    onRefresh?: () => Promise<void>;
    selectedModelId?: string;
}

function openModal(locale: Locale = "en", handlers: Handlers = {}): CapturedModal {
    const store = new ModelCatalogStore();
    seedStore(store);
    openManageModelsModal({
        store,
        locale,
        selectedModelId: handlers.selectedModelId ?? "base",
        onDelete: handlers.onDelete ?? (async () => undefined),
        onRefresh: handlers.onRefresh ?? (async () => undefined),
    });
    const modal = capturedModals.at(-1);
    expect(modal).toBeDefined();
    return modal!;
}

function okButton(): HTMLButtonElement {
    const button = document.querySelector<HTMLButtonElement>("[data-confirm-ok]");
    expect(button).not.toBeNull();
    return button!;
}

function deleteButton(modelId: string): HTMLButtonElement {
    const button = document.querySelector<HTMLButtonElement>(`[data-manage-delete="${modelId}"]`);
    expect(button).not.toBeNull();
    return button!;
}

describe("ManageModels", () => {
    it("opens with the localized title and lists installed models with names and sizes", () => {
        openModal();
        render(capturedModals.at(-1)!.node);

        expect(
            screen.getByText("Manage models", { selector: "[data-modal-header]" }),
        ).not.toBeNull();
        // Installed rows carry display name + decimal size; the not-installed
        // catalog entry (turbo) never renders a row.
        expect(document.querySelector('[data-manage-row="tiny"]')?.textContent).toContain(
            "Tiny (fastest) · 78 MB",
        );
        expect(document.querySelector('[data-manage-row="base"]')?.textContent).toContain(
            "Base (default) · 148 MB",
        );
        expect(
            document.querySelector('[data-manage-row="distil-small-en"]')?.textContent,
        ).toContain("Distil Small (English) · 336 MB");
        expect(
            document.querySelector('[data-manage-row="whisper-large-v3-turbo-q5_0"]'),
        ).toBeNull();
        // The selected model is marked and its delete is visibly disabled.
        expect(document.querySelector('[data-manage-row="base"]')?.textContent).toContain(
            "selected",
        );
        expect(deleteButton("base").disabled).toBe(true);
        // Two installed non-selected models → the bulk action renders.
        expect(document.querySelector("[data-manage-delete-all]")).not.toBeNull();
    });

    it("asks once via a destructive ConfirmModal naming the model, size and re-download path, then deletes and refreshes", async () => {
        const onDelete = vi.fn().mockResolvedValue(undefined);
        const onRefresh = vi.fn().mockResolvedValue(undefined);
        const store = new ModelCatalogStore();
        seedStore(store);
        openManageModelsModal({
            store,
            locale: "en",
            selectedModelId: "base",
            onDelete,
            onRefresh,
        });
        render(capturedModals.at(-1)!.node);

        fireEvent.click(deleteButton("tiny"));
        renderLastModal();
        expect(capturedConfirms).toHaveLength(1);
        const confirm = capturedConfirms[0]!;
        expect(confirm["bDestructiveWarning"]).toBe(true);
        expect(confirm["strTitle"]).toBe("Delete model");
        expect(confirm["strOKButtonText"]).toBe("Delete");
        expect(String(confirm["strDescription"])).toContain("Tiny (fastest)");
        expect(String(confirm["strDescription"])).toContain("78 MB");
        expect(String(confirm["strDescription"])).toContain("download it again at any time");

        await act(async () => {
            fireEvent.click(okButton());
        });

        expect(onDelete).toHaveBeenCalledTimes(1);
        expect(onDelete).toHaveBeenCalledWith("tiny");
        // State-refresh feedback through the existing list_models path (the
        // store flip itself lives in the adapter, covered by
        // DeckyAdapters.test.ts) — no toasts.
        expect(onRefresh).toHaveBeenCalledTimes(1);
        expect(document.querySelector("[data-manage-status]")).toBeNull();
        expect(capturedConfirms).toHaveLength(1); // still exactly ONE confirm
    });

    it("locks the modal during a delete: controls disabled, dismissal ignored, inline status shown", async () => {
        let releaseDelete: (() => void) | null = null;
        const onDelete = vi.fn().mockImplementation(
            () =>
                new Promise<void>((resolve) => {
                    releaseDelete = resolve;
                }),
        );
        const onRefresh = vi.fn().mockResolvedValue(undefined);
        const modal = openModal("en", { onDelete, onRefresh });
        render(modal.node);

        await act(async () => {
            fireEvent.click(deleteButton("tiny"));
        });
        renderLastModal();
        expect(capturedConfirms).toHaveLength(1);
        await act(async () => {
            fireEvent.click(okButton());
            await Promise.resolve();
        });

        // In-flight: every delete control and Close lock; the inline status
        // shows; Steam's dismissal funnel (Esc / X / background click) is a
        // no-op so the modal cannot vanish under the status line.
        expect(document.querySelector('[data-manage-status="deleting"]')?.textContent).toBe(
            "Deleting…",
        );
        expect(deleteButton("tiny").disabled).toBe(true);
        expect(deleteButton("distil-small-en").disabled).toBe(true);
        expect(
            document.querySelector<HTMLButtonElement>("[data-manage-delete-all]")?.disabled,
        ).toBe(true);
        fireEvent.click(document.querySelector("[data-modal-dismiss]")!);
        expect(modal.close).not.toHaveBeenCalled();

        await act(async () => {
            releaseDelete!();
            await Promise.resolve();
            await Promise.resolve();
            await Promise.resolve();
        });
        // Settled: controls unlock and dismissal closes again.
        expect(document.querySelector("[data-manage-status]")).toBeNull();
        expect(deleteButton("distil-small-en").disabled).toBe(false);
        fireEvent.click(document.querySelector("[data-modal-dismiss]")!);
        expect(modal.close).toHaveBeenCalledTimes(1);
    });

    it("a backend rejection surfaces the inline error with the detail and still refreshes", async () => {
        const onDelete = vi.fn().mockRejectedValue(new Error("MODEL_DOWNLOAD_FAILED (id=tiny)"));
        const onRefresh = vi.fn().mockResolvedValue(undefined);
        openModal("en", { onDelete, onRefresh });
        render(capturedModals.at(-1)!.node);

        await act(async () => {
            fireEvent.click(deleteButton("tiny"));
        });
        renderLastModal();
        await act(async () => {
            fireEvent.click(okButton());
            await Promise.resolve();
        });

        const error = document.querySelector("[data-manage-error]");
        expect(error).not.toBeNull();
        expect(error?.textContent).toContain("Deleting the model failed.");
        expect(error?.textContent).toContain("MODEL_DOWNLOAD_FAILED (id=tiny)");
        // The refresh reports the honest state even after a rejection, and
        // the controls unlock again.
        expect(onRefresh).toHaveBeenCalledTimes(1);
        expect(deleteButton("distil-small-en").disabled).toBe(false);
    });

    it("the selected model can never reach a confirm (disabled control, no modal)", () => {
        openModal("en", { selectedModelId: "base" });
        render(capturedModals.at(-1)!.node);

        expect(deleteButton("base").disabled).toBe(true);
        fireEvent.click(deleteButton("base"));
        expect(capturedConfirms).toHaveLength(0);
    });

    it("Delete all inactive confirms ONCE and loops the per-model callable, never the selected one", async () => {
        const onDelete = vi.fn().mockResolvedValue(undefined);
        const onRefresh = vi.fn().mockResolvedValue(undefined);
        const store = new ModelCatalogStore();
        seedStore(store);
        openManageModelsModal({
            store,
            locale: "en",
            selectedModelId: "base",
            onDelete,
            onRefresh,
        });
        render(capturedModals.at(-1)!.node);

        fireEvent.click(document.querySelector("[data-manage-delete-all]")!);
        renderLastModal();
        expect(capturedConfirms).toHaveLength(1);
        const confirm = capturedConfirms[0]!;
        expect(confirm["bDestructiveWarning"]).toBe(true);
        expect(confirm["strTitle"]).toBe("Delete inactive models");
        expect(String(confirm["strDescription"])).toContain("The selected model is kept.");

        await act(async () => {
            fireEvent.click(okButton());
            await Promise.resolve();
        });

        // One confirm, two per-model calls (id-only input), one refresh.
        expect(onDelete).toHaveBeenCalledTimes(2);
        expect(onDelete).toHaveBeenNthCalledWith(1, "tiny");
        expect(onDelete).toHaveBeenNthCalledWith(2, "distil-small-en");
        expect(onDelete).not.toHaveBeenCalledWith("base");
        expect(onRefresh).toHaveBeenCalledTimes(1);
    });

    it("the single confirm closes without deleting on cancel", async () => {
        const onDelete = vi.fn().mockResolvedValue(undefined);
        const onRefresh = vi.fn().mockResolvedValue(undefined);
        openModal("en", { onDelete, onRefresh });
        render(capturedModals.at(-1)!.node);

        fireEvent.click(deleteButton("tiny"));
        renderLastModal();
        expect(capturedConfirms).toHaveLength(1);
        fireEvent.click(document.querySelector("[data-confirm-cancel]")!);

        expect(onDelete).not.toHaveBeenCalled();
        expect(onRefresh).not.toHaveBeenCalled();
    });
});

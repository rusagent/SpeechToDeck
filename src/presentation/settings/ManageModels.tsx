/**
 * ManageModels (in-app model cleanup, owner request): lists the INSTALLED
 * catalog models (display name + size — the payload already carries
 * sizeBytes) under a Delete action each. The selected model's delete is
 * visibly disabled — the backend rejects it anyway (active-model protection,
 * the settings document keeps referencing it), so the control never lies.
 * Deletion is confirmed per Steam's ConfirmModal (bDestructiveWarning, OK
 * "Delete") with a description naming the model, its freed size and the
 * re-download path. During a delete the modal controls lock and an inline
 * "Deleting…" status shows — no toasts; the feedback is the refreshed
 * catalog itself, reloaded through the existing `list_models` path once the
 * deletes settle (the store also flips the install state immediately via
 * markDeleted). The optional "Delete all inactive" action confirms ONCE and
 * loops the same per-model callable — there is no bulk route; it stops at
 * the first backend rejection and the refresh reports the honest state.
 *
 * Like the download modal this body renders in Steam's modal root, OUTSIDE
 * the panel tree: it observes the catalog store directly.
 * The backend resolves the file path from the model id alone (no frontend
 * path ever crosses the boundary).
 */

import * as React from "react";
import {
    ConfirmModal,
    DialogBody,
    DialogBodyText,
    DialogButton,
    DialogFooter,
    DialogHeader,
    ModalRoot,
    showModal,
} from "@decky/ui";
import type { StateStore } from "../../application/DictationController";
import type { CatalogModel, ModelCatalogSnapshot } from "../../application/ports/ModelCatalogPort";
import { modelDisplayName, translate } from "../i18n/messages";
import type { Locale } from "../i18n/messages";
import { formatSize } from "./ModelSelect";

/** Row label: display name, decimal size, and the selected-model marker. */
function rowLabel(locale: Locale, model: CatalogModel, active: boolean): string {
    const parts = [
        modelDisplayName(locale, model.id),
        model.sizeBytes === undefined ? null : formatSize(model.sizeBytes),
        active ? translate(locale, "model.manage.selected") : null,
    ].filter((part): part is string => part !== null);
    return parts.join(" · ");
}

function confirmDescription(locale: Locale, models: readonly CatalogModel[]): string {
    if (models.length !== 1) {
        return translate(locale, "model.manage.confirmAll");
    }
    const model = models[0]!;
    const subject = [
        modelDisplayName(locale, model.id),
        model.sizeBytes === undefined ? null : formatSize(model.sizeBytes),
    ]
        .filter((part): part is string => part !== null)
        .join(" · ");
    return `${subject}. ${translate(locale, "model.manage.confirmSingle")}`;
}

export interface ManageModelsModalProps {
    readonly store: StateStore<ModelCatalogSnapshot>;
    readonly locale: Locale;
    /** The selected model id: its delete is disabled (active-model guard). */
    readonly selectedModelId: string;
    /** Deletes one model through the backend `delete_model` callable. */
    readonly onDelete: (modelId: string) => Promise<void>;
    /** Refreshes the catalog through the existing `list_models` path. */
    readonly onRefresh: () => Promise<void>;
    /** Closes the modal; ignored while a delete is in flight. */
    readonly onClose: () => void;
}

export function ManageModelsModalBody({
    store,
    locale,
    selectedModelId,
    onDelete,
    onRefresh,
    onClose,
}: ManageModelsModalProps): React.ReactElement {
    const subscribe = React.useMemo(() => (cb: () => void) => store.subscribe(cb), [store]);
    const getSnapshot = React.useMemo(() => () => store.getSnapshot(), [store]);
    const snapshot = React.useSyncExternalStore(subscribe, getSnapshot);

    // A delete loop is in flight: every control locks and the inline status
    // shows. Modal dismissal is routed to the same lock (see ModalRoot).
    const [busy, setBusy] = React.useState(false);
    const [errorDetail, setErrorDetail] = React.useState<string | null>(null);

    const installed = snapshot.models.filter((model) => model.installed);
    const deletable = installed.filter((model) => model.id !== selectedModelId);

    const runDelete = async (models: readonly CatalogModel[]): Promise<void> => {
        setBusy(true);
        setErrorDetail(null);
        try {
            for (const model of models) {
                try {
                    await onDelete(model.id);
                } catch (error) {
                    // Honest stop: the first rejection (selected model,
                    // download in flight, ...) ends the loop; the refresh
                    // below reports exactly what survived.
                    setErrorDetail(
                        error instanceof Error && error.message.length > 0 ? error.message : null,
                    );
                    break;
                }
            }
        } finally {
            // State-refresh feedback through the existing list_models path.
            await onRefresh();
            setBusy(false);
        }
    };

    const confirmDelete = (models: readonly CatalogModel[]): void => {
        const single = models.length === 1;
        showModal(
            <ConfirmModal
                strTitle={translate(
                    locale,
                    single ? "model.manage.confirmTitle" : "model.manage.confirmAllTitle",
                )}
                strDescription={confirmDescription(locale, models)}
                strOKButtonText={translate(locale, "model.manage.delete")}
                strCancelButtonText={translate(locale, "model.modal.cancel")}
                bDestructiveWarning={true}
                onOK={() => {
                    void runDelete(models);
                }}
            />,
        );
    };

    return (
        <ModalRoot
            // Locked while a delete runs: Steam funnels every dismissal (Esc,
            // close icon, background click) through closeModal — during the
            // in-flight delete it is a no-op, so the modal cannot vanish
            // under the status line.
            closeModal={busy ? () => undefined : onClose}
        >
            <DialogHeader>{translate(locale, "model.manage.title")}</DialogHeader>
            <DialogBody data-manage-modal="true">
                <DialogBodyText>{translate(locale, "model.manage.hint")}</DialogBodyText>
                {installed.map((model) => {
                    const active = model.id === selectedModelId;
                    return (
                        <div key={model.id} data-manage-row={model.id}>
                            <DialogBodyText>{rowLabel(locale, model, active)}</DialogBodyText>
                            <DialogButton
                                data-manage-delete={model.id}
                                disabled={busy || active}
                                onClick={() => confirmDelete([model])}
                            >
                                {translate(locale, "model.manage.delete")}
                            </DialogButton>
                        </div>
                    );
                })}
                {deletable.length > 1 ? (
                    <DialogButton
                        data-manage-delete-all="true"
                        disabled={busy}
                        onClick={() => confirmDelete(deletable)}
                    >
                        {translate(locale, "model.manage.deleteAll")}
                    </DialogButton>
                ) : null}
                {busy ? (
                    <DialogBodyText data-manage-status="deleting">
                        {translate(locale, "model.manage.deleting")}
                    </DialogBodyText>
                ) : null}
                {!busy && errorDetail !== null ? (
                    <DialogBodyText data-manage-error="true">
                        {errorDetail.length > 0
                            ? `${translate(locale, "model.manage.deleteFailed")} (${errorDetail})`
                            : translate(locale, "model.manage.deleteFailed")}
                    </DialogBodyText>
                ) : null}
                <DialogFooter>
                    <DialogButton disabled={busy} onClick={onClose}>
                        {translate(locale, "model.modal.close")}
                    </DialogButton>
                </DialogFooter>
            </DialogBody>
        </ModalRoot>
    );
}

/**
 * Opens the manage modal. strTitle feeds the overlay's aria-label (Steam
 * never renders a header from it — the visible header is the DialogHeader
 * the body renders, same as the download modal).
 */
export function openManageModelsModal(params: {
    readonly store: StateStore<ModelCatalogSnapshot>;
    readonly locale: Locale;
    readonly selectedModelId: string;
    readonly onDelete: (modelId: string) => Promise<void>;
    readonly onRefresh: () => Promise<void>;
}): void {
    const handle = showModal(
        <ManageModelsModalBody
            store={params.store}
            locale={params.locale}
            selectedModelId={params.selectedModelId}
            onDelete={params.onDelete}
            onRefresh={params.onRefresh}
            onClose={() => handle.Close()}
        />,
        undefined,
        { strTitle: translate(params.locale, "model.manage.title") },
    );
}

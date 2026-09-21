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
    readonly selectedModelId: string;
    readonly onDelete: (modelId: string) => Promise<void>;
    readonly onRefresh: () => Promise<void>;
    readonly onClose: () => void;
}

function ManageModelsModalBody({
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
                    setErrorDetail(
                        error instanceof Error && error.message.length > 0 ? error.message : null,
                    );
                    break;
                }
            }
        } finally {
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
        <ModalRoot closeModal={busy ? () => undefined : onClose}>
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

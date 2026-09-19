/**
 * ModelSelect (spec §48/§54/§80, ADR-011; v0.2.5 redesign) — the curated
 * model catalog as a plain two-control flow: the LanguagePicker dropdown
 * above (rendered by SettingsPanel), the model dropdown below. Options are
 * always the general/multilingual catalog models plus — when the language
 * selection is a concrete language — the models specialized for it, labeled
 * with the localized name and human-readable size (the two recommended turbo
 * picks carry the localized "Recommended" suffix).
 *
 * Selecting an INSTALLED model persists `update({modelId})` immediately (the
 * existing restart lifecycle does the rest). Selecting a NOT-INSTALLED model
 * persists nothing: it opens the download modal for that model and the
 * dropdown stays bound to the previously selected model (`selectedOption`
 * mirrors the persisted settings value) while the download runs. The modal
 * shows size, description and the live download percent from the
 * ModelCatalogStore, closes itself on `model_download_complete` (persistence
 * happens after the close, so the restart fires once), and its Cancel — or
 * any dismissal — cancels the download and persists nothing. Failures flip
 * the modal to an error state carrying the backend detail string. The
 * backend runs one download at a time (§52); the open modal blocks any
 * second start by construction.
 */

import * as React from "react";
import { ButtonItem, DropdownItem, ProgressBar, showModal } from "@decky/ui";
import type { DropdownOption } from "@decky/ui";
import type { StateStore } from "../../application/DictationController";
import type { CatalogModel, ModelCatalogSnapshot } from "../../application/ports/ModelCatalogPort";
import { modelDisplayName, translate } from "../i18n/messages";
import type { Locale } from "../i18n/messages";
import { LANGUAGE_SENTINELS } from "./LanguagePicker";
import { FieldHint } from "./FieldHint";

/** General-purpose models the catalog highlights as recommended (ADR-011). */
const RECOMMENDED_MODEL_IDS: readonly string[] = [
    "whisper-large-v3-turbo-q5_0",
    "whisper-large-v3-turbo",
];

/** Decimal units, matching how the HF repos advertise artifact sizes. */
function formatSize(bytes: number): string {
    if (bytes >= 1_000_000_000) {
        return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
    }
    if (bytes >= 1_000_000) {
        return `${Math.round(bytes / 1_000_000)} MB`;
    }
    return `${Math.round(bytes / 1_000)} kB`;
}

function optionLabel(locale: Locale, model: CatalogModel): string {
    const name = modelDisplayName(locale, model.id);
    const size = model.sizeBytes === undefined ? null : formatSize(model.sizeBytes);
    const recommended = RECOMMENDED_MODEL_IDS.includes(model.id)
        ? ` · ${translate(locale, "model.recommended")}`
        : "";
    return `${name}${size !== null ? ` · ${size}` : ""}${recommended}`;
}

export interface ModelSelectProps {
    /** Selected model id (a curated catalog id, persisted via settings). */
    readonly value: string;
    readonly locale: Locale;
    /** Current language selection; a concrete tag enables the language group. */
    readonly language: string;
    /** Live catalog + download state (the adapter's guarded side-channel). */
    readonly store: StateStore<ModelCatalogSnapshot>;
    /** Select an installed model (persists modelId through update_settings). */
    readonly onChange: (modelId: string) => void;
    /** Start the download for a not-installed model. */
    readonly onDownload: (modelId: string) => void;
    /** Cancel the in-flight download. */
    readonly onCancel: () => void;
}

interface ModalBodyProps {
    readonly model: CatalogModel;
    readonly locale: Locale;
    readonly store: StateStore<ModelCatalogSnapshot>;
    /** Download completed: the modal closes first, persistence follows. */
    readonly onComplete: () => void;
    /** User pressed Cancel: cancel the download, persist nothing, close. */
    readonly onCancelRequest: () => void;
    /** Error-state Close (or any dismissal after a settled failure). */
    readonly onDismissRequest: () => void;
}

function ModelDownloadModal({
    model,
    locale,
    store,
    onComplete,
    onCancelRequest,
    onDismissRequest,
}: ModalBodyProps): React.ReactElement {
    // The modal renders in Steam's modal root, OUTSIDE the panel tree: it
    // observes the store directly (§102 pattern) so live progress and settle
    // paths reach it without prop drilling through the imperative showModal
    // boundary.
    const subscribe = React.useMemo(() => (cb: () => void) => store.subscribe(cb), [store]);
    const getSnapshot = React.useMemo(() => () => store.getSnapshot(), [store]);
    const snapshot = React.useSyncExternalStore(subscribe, getSnapshot);

    // Local error capture: undefined = still downloading; otherwise the
    // backend detail (possibly null) of the failed attempt. Copied into
    // state so later store changes cannot flicker the error away.
    const [failureDetail, setFailureDetail] = React.useState<string | null | undefined>(undefined);
    React.useEffect(() => {
        const failure = snapshot.failure;
        if (failure !== null && failure.modelId === model.id) {
            setFailureDetail(failure.detail ?? null);
        }
    }, [snapshot, model.id]);

    // Completion: the download settled successfully (install state flipped).
    // Runs once; the close-then-persist order lives in openModelDownloadModal.
    const completedRef = React.useRef(false);
    React.useEffect(() => {
        if (completedRef.current) {
            return;
        }
        const current = snapshot.models.find((candidate) => candidate.id === model.id);
        if (current?.installed === true) {
            completedRef.current = true;
            onComplete();
        }
    }, [snapshot, model.id, onComplete]);

    if (failureDetail !== undefined) {
        return (
            <div data-model-modal="error">
                <p style={{ margin: "0 0 8px" }}>{translate(locale, "model.modal.failed")}</p>
                {failureDetail !== null && failureDetail.length > 0 ? (
                    <p
                        data-model-error-detail="true"
                        style={{ margin: "0 0 8px", opacity: 0.75, fontSize: 12 }}
                    >
                        {failureDetail}
                    </p>
                ) : null}
                <ButtonItem onClick={onDismissRequest}>
                    {translate(locale, "model.modal.close")}
                </ButtonItem>
            </div>
        );
    }

    const download =
        snapshot.download !== null && snapshot.download.modelId === model.id
            ? snapshot.download
            : null;
    const percent = download?.percent ?? null;
    const size = model.sizeBytes === undefined ? null : formatSize(model.sizeBytes);
    return (
        <div data-model-modal="download">
            <p style={{ margin: "0 0 8px" }}>
                {size !== null ? `${size} · ` : ""}
                {model.description ?? ""}
            </p>
            {percent !== null ? (
                <p data-model-percent="true" style={{ margin: "0 0 8px" }}>
                    {percent}%
                </p>
            ) : (
                <p style={{ margin: "0 0 8px", opacity: 0.75, fontSize: 12 }}>
                    {translate(locale, "model.modal.preparing")}
                </p>
            )}
            <ProgressBar
                indeterminate={percent === null}
                {...(percent !== null ? { nProgress: percent } : {})}
            />
            <ButtonItem onClick={onCancelRequest}>
                {translate(locale, "model.modal.cancel")}
            </ButtonItem>
        </div>
    );
}

/**
 * Opens the download modal for one not-installed model and starts nothing by
 * itself — the caller starts the download. Every settle path is funneled
 * through a single settled flag so Steam's own dismissal (Esc, close icon)
 * and our programmatic close cannot double-fire the cancel:
 *
 * - complete → close the modal, THEN persist (restart fires once);
 * - Cancel button → cancel the download, persist nothing, close;
 * - failure → error state (backend detail), Close just closes;
 * - any other dismissal while the download runs → cancel, persist nothing.
 */
export function openModelDownloadModal(params: {
    readonly model: CatalogModel;
    readonly locale: Locale;
    readonly store: StateStore<ModelCatalogSnapshot>;
    /** Called AFTER the modal closed on a completed download. */
    readonly onCompleted: (modelId: string) => void;
    /** Cancels the in-flight download (wiring callable). */
    readonly onCancel: () => void;
}): void {
    let settled = false;
    const handle = showModal(
        <ModelDownloadModal
            model={params.model}
            locale={params.locale}
            store={params.store}
            onComplete={() => {
                if (settled) {
                    return;
                }
                settled = true;
                handle.Close();
                params.onCompleted(params.model.id);
            }}
            onCancelRequest={() => {
                if (settled) {
                    return;
                }
                settled = true;
                params.onCancel();
                handle.Close();
            }}
            onDismissRequest={() => {
                settled = true;
                handle.Close();
            }}
        />,
        undefined,
        {
            strTitle: modelDisplayName(params.locale, params.model.id),
            fnOnClose: () => {
                // Esc / Steam's close icon while the download runs: cancel,
                // persist nothing. Our own closes arrive here already settled.
                if (!settled) {
                    settled = true;
                    params.onCancel();
                }
            },
        },
    );
}

export function ModelSelect({
    value,
    locale,
    language,
    store,
    onChange,
    onDownload,
    onCancel,
}: ModelSelectProps): React.ReactElement {
    const subscribe = React.useMemo(() => (cb: () => void) => store.subscribe(cb), [store]);
    const getSnapshot = React.useMemo(() => () => store.getSnapshot(), [store]);
    const snapshot = React.useSyncExternalStore(subscribe, getSnapshot);

    if (snapshot.models.length === 0) {
        return (
            <div data-model-select="true">
                <FieldHint>{translate(locale, "model.catalog.unavailable")}</FieldHint>
            </div>
        );
    }

    // Grouped dropdown (DropdownItem optgroups): the general/multilingual
    // catalog first, then — for a concrete language selection — the models
    // specialized for it.
    const general = snapshot.models.filter((model) => model.languages === undefined);
    const options: DropdownOption[] = [];
    if (general.length > 0) {
        options.push({
            label: translate(locale, "model.group.general"),
            options: general.map((model) => ({
                data: model.id,
                label: optionLabel(locale, model),
            })),
        });
    }
    if (language !== LANGUAGE_SENTINELS.system && language !== LANGUAGE_SENTINELS.auto) {
        const specialized = snapshot.models.filter(
            (model) => model.languages?.includes(language) ?? false,
        );
        if (specialized.length > 0) {
            options.push({
                label: language,
                options: specialized.map((model) => ({
                    data: model.id,
                    label: optionLabel(locale, model),
                })),
            });
        }
    }

    const handleSelect = (modelId: string): void => {
        if (modelId === value) {
            return;
        }
        const model = snapshot.models.find((candidate) => candidate.id === modelId);
        if (model === undefined) {
            return; // unknown id: never persist, never download (§109 analog)
        }
        if (model.installed) {
            onChange(model.id);
            return;
        }
        // Not installed: nothing persists here — the dropdown stays bound to
        // the previously selected model while the modal runs the download.
        onDownload(model.id);
        openModelDownloadModal({
            model,
            locale,
            store,
            onCompleted: onChange,
            onCancel,
        });
    };

    return (
        <div data-model-select="true">
            <DropdownItem
                label={translate(locale, "setting.model")}
                rgOptions={options}
                selectedOption={value}
                onChange={(option) => handleSelect(option.data as string)}
            />
        </div>
    );
}

/**
 * ModelSelect (spec §48/§54/§80, ADR-011; v0.2.6 rework) — the curated model
 * catalog as one dropdown over ALL catalog models in fixed groups: the
 * "General" group (models WITHOUT `languages`) plus one group per language
 * with native labels (Deutsch, English, Français, 日本語 — locale-invariant
 * endonyms; the keys exist in both dictionaries for the parity gate).
 * Grouping keys off the `languages` field's presence, NEVER the
 * `multilingual` flag (the de/fr/ja specialists are multilingual:true).
 * Options carry the localized name and human-readable size; the two
 * recommended turbo picks carry the localized "Recommended" suffix. The
 * LanguagePicker is a separate control rendered below by SettingsPanel and
 * only while the selected model does not pin a language itself.
 *
 * Selecting an INSTALLED model persists `update({modelId})` immediately (the
 * existing restart lifecycle does the rest). Selecting a NOT-INSTALLED model
 * persists nothing: it opens the download modal for that model and the
 * dropdown stays bound to the previously selected model (`selectedOption`
 * mirrors the persisted settings value) while the download runs. The modal
 * shows size, description and the live download percent from the
 * ModelCatalogStore. Completion is honest: the store keeps a final
 * percent-100 snapshot when the install state flips, the modal holds the
 * full bar for a short fixed delay (so the 100% frame is actually seen —
 * the throttled progress stream previously meant faster downloads closed
 * the modal from a lower frame), and only then closes; persistence happens
 * after the close, so the restart fires once. While downloading, the
 * Cancel — or any dismissal — cancels the download and persists nothing.
 * Failures flip the modal to an error state carrying the backend detail
 * string. The backend runs one download at a time (§52); the open modal
 * blocks any second start by construction.
 */

import * as React from "react";
import {
    DialogBody,
    DialogBodyText,
    DialogButton,
    DialogFooter,
    DialogHeader,
    DropdownItem,
    ModalRoot,
    ProgressBar,
    showModal,
} from "@decky/ui";
import type { DropdownOption } from "@decky/ui";
import type { StateStore } from "../../application/DictationController";
import type { CatalogModel, ModelCatalogSnapshot } from "../../application/ports/ModelCatalogPort";
import { modelDisplayName, translate } from "../i18n/messages";
import type { Locale, MessageKey } from "../i18n/messages";
import { FieldHint } from "./FieldHint";

/** General-purpose models the catalog highlights as recommended (ADR-011). */
const RECOMMENDED_MODEL_IDS: readonly string[] = [
    "whisper-large-v3-turbo-q5_0",
    "whisper-large-v3-turbo",
];

/**
 * Native endonyms for the curated language groups (ADR-011): the SAME
 * string in every UI locale — a language group is labeled in its own
 * language, not the UI's. A catalog language without a curated key renders
 * as the raw code instead of an empty label.
 */
const LANGUAGE_GROUP_KEYS: Record<string, MessageKey> = {
    de: "model.group.lang.de",
    en: "model.group.lang.en",
    fr: "model.group.lang.fr",
    ja: "model.group.lang.ja",
};

function languageGroupLabel(locale: Locale, code: string): string {
    const key = LANGUAGE_GROUP_KEYS[code];
    return key === undefined ? code : translate(locale, key);
}

/**
 * How long the completed modal holds the full 100% bar before it closes
 * (and the selection persists). Long enough to be seen, short enough not
 * to feel like a second wait.
 */
const COMPLETION_HOLD_MS = 500;

/**
 * Fully-controlled dropdown flag (see the DropdownItem usage below). Spread
 * because the repo's @decky/ui type definitions omit the runtime `controlled`
 * prop the real Steam client bundle implements.
 */
const CONTROLLED_DROPDOWN: { controlled: boolean } = { controlled: true };

/** Decimal units, matching how the HF repos advertise artifact sizes. */
export function formatSize(bytes: number): string {
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

    // Completion: the download settled successfully (install state flipped,
    // store kept the final percent-100 frame). Runs once: the modal holds
    // the full bar for the fixed delay so the completion is actually seen,
    // then hands to the close-then-persist order in openModelDownloadModal.
    // Dismissal during the hold routes to the same completion path (there is
    // nothing left to cancel), and the Cancel button is gone — the download
    // settled.
    const [completed, setCompleted] = React.useState(false);
    const completedRef = React.useRef(false);
    const closeTimerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);
    React.useEffect(() => {
        if (completedRef.current) {
            return;
        }
        const current = snapshot.models.find((candidate) => candidate.id === model.id);
        if (current?.installed === true) {
            completedRef.current = true;
            setCompleted(true);
            closeTimerRef.current = setTimeout(() => {
                closeTimerRef.current = null;
                onComplete();
            }, COMPLETION_HOLD_MS);
        }
    }, [snapshot, model.id, onComplete]);
    React.useEffect(
        () => () => {
            if (closeTimerRef.current !== null) {
                clearTimeout(closeTimerRef.current);
            }
        },
        [],
    );

    // v0.2.5 on-device fix: the modal body MUST be Steam's modal structure.
    // showModal mounts its ReactNode RAW into the fullscreen
    // ModalOverlayContent (verified on device via CDP and in the Steam client
    // bundle, steamui chunk~2dcc5aaf7.js module 35376/46701): a bare div
    // renders as an unstyled strip at the screen's top-left corner. ModalRoot
    // (Steam's GenericDialogModal, resolved by the loader's DFL global —
    // runtime-verified on device) draws the centered dialog box; the visible
    // title header comes from DialogHeader, the same component Steam's own
    // ConfirmModal title path renders (the showModal strTitle only feeds the
    // overlay's aria-label and pop-out windows — no header element is ever
    // created from it).
    //
    // Cancel wiring: GenericDialogModal asserts `closeModal || onCancel` and
    // funnels EVERY dismissal (Esc key, X close icon, background mousedown)
    // through `onCancel() || closeModal()`. Only `closeModal` is passed, so
    // the dismiss handler runs exactly once; Steam does not close the modal
    // for us, the handler does (via the settled-flagged paths below). While
    // the download runs any dismissal cancels it and persists nothing; in the
    // error state dismissal just closes.
    if (failureDetail !== undefined) {
        return (
            <ModalRoot closeModal={onDismissRequest}>
                <DialogHeader>{modelDisplayName(locale, model.id)}</DialogHeader>
                <DialogBody data-model-modal="error">
                    <DialogBodyText>{translate(locale, "model.modal.failed")}</DialogBodyText>
                    {failureDetail !== null && failureDetail.length > 0 ? (
                        <DialogBodyText data-model-error-detail="true">
                            {failureDetail}
                        </DialogBodyText>
                    ) : null}
                    <DialogFooter>
                        <DialogButton onClick={onDismissRequest}>
                            {translate(locale, "model.modal.close")}
                        </DialogButton>
                    </DialogFooter>
                </DialogBody>
            </ModalRoot>
        );
    }

    const download =
        snapshot.download !== null && snapshot.download.modelId === model.id
            ? snapshot.download
            : null;
    const percent = download?.percent ?? null;
    const size = model.sizeBytes === undefined ? null : formatSize(model.sizeBytes);
    return (
        <ModalRoot
            // Completion hold: dismissal funnels into the SAME completion
            // path as the hold timer (settled once in the shell) — the
            // download is done, there is nothing to cancel.
            closeModal={completed ? onComplete : onCancelRequest}
        >
            <DialogHeader>{modelDisplayName(locale, model.id)}</DialogHeader>
            <DialogBody data-model-modal="download">
                <DialogBodyText>
                    {size !== null ? `${size} · ` : ""}
                    {model.description ?? ""}
                </DialogBodyText>
                {percent !== null ? (
                    <DialogBodyText data-model-percent="true">{percent}%</DialogBodyText>
                ) : (
                    <DialogBodyText>{translate(locale, "model.modal.preparing")}</DialogBodyText>
                )}
                <ProgressBar
                    indeterminate={percent === null}
                    {...(percent !== null ? { nProgress: percent } : {})}
                />
                {completed ? null : (
                    <DialogFooter>
                        <DialogButton onClick={onCancelRequest}>
                            {translate(locale, "model.modal.cancel")}
                        </DialogButton>
                    </DialogFooter>
                )}
            </DialogBody>
        </ModalRoot>
    );
}

/**
 * Opens the download modal for one not-installed model and starts nothing by
 * itself — the caller starts the download. Every settle path is funneled
 * through a single settled flag so Steam's own dismissal (Esc, close icon,
 * background click — all routed by ModalRoot's closeModal funnel) and our
 * programmatic close cannot double-fire the cancel:
 *
 * - complete → close the modal, THEN persist (restart fires once);
 * - Cancel button → cancel the download, persist nothing, close;
 * - failure → error state (backend detail), Close just closes;
 * - any other dismissal while the download runs → cancel, persist nothing.
 *
 * strTitle is still passed to showModal even though Steam never renders a
 * header from it: it feeds the modal overlay's aria-label (and a pop-out
 * window title, should the dialog ever pop out). The visible header is the
 * DialogHeader the modal body renders.
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

    // Grouped dropdown (DropdownItem optgroups): the general catalog first,
    // then one group per language with native labels. Grouping keys off the
    // `languages` field's presence — NEVER the `multilingual` flag (the
    // de/fr/ja specialists are multilingual:true). Each specialized model is
    // grouped under its first language code (the curated catalog is
    // single-language per specialist), groups appear in catalog order.
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
    const groupCodes: string[] = [];
    const modelsByCode = new Map<string, CatalogModel[]>();
    for (const model of snapshot.models) {
        const code = model.languages?.[0];
        if (code === undefined) {
            continue;
        }
        const group = modelsByCode.get(code);
        if (group === undefined) {
            groupCodes.push(code);
            modelsByCode.set(code, [model]);
        } else {
            group.push(model);
        }
    }
    for (const code of groupCodes) {
        const group = modelsByCode.get(code) ?? [];
        options.push({
            label: languageGroupLabel(locale, code),
            options: group.map((model) => ({
                data: model.id,
                label: optionLabel(locale, model),
            })),
        });
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
                // Steam's DropdownItem is semi-controlled: without this flag
                // the internal DropDownControl keeps its own state value, so
                // a cancelled/failed download (which persists nothing) would
                // leave the label stuck on the picked model instead of
                // snapping back to the persisted one. Constant true — Steam
                // asserts when `controlled` changes after mount — and the
                // @decky/ui 4.12.1 type definitions simply omit the flag the
                // client bundle honors.
                {...CONTROLLED_DROPDOWN}
            />
        </div>
    );
}

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

const RECOMMENDED_MODEL_IDS: readonly string[] = [
    "whisper-large-v3-turbo-q5_0",
    "whisper-large-v3-turbo",
];

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

const COMPLETION_HOLD_MS = 500;

const CONTROLLED_DROPDOWN: { controlled: boolean } = { controlled: true };

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
    readonly value: string;
    readonly locale: Locale;
    readonly store: StateStore<ModelCatalogSnapshot>;
    readonly onChange: (modelId: string) => void;
    readonly onDownload: (modelId: string) => void;
    readonly onCancel: () => void;
}

interface ModalBodyProps {
    readonly model: CatalogModel;
    readonly locale: Locale;
    readonly store: StateStore<ModelCatalogSnapshot>;
    readonly onComplete: () => void;
    readonly onCancelRequest: () => void;
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
    const subscribe = React.useMemo(() => (cb: () => void) => store.subscribe(cb), [store]);
    const getSnapshot = React.useMemo(() => () => store.getSnapshot(), [store]);
    const snapshot = React.useSyncExternalStore(subscribe, getSnapshot);

    const [failureDetail, setFailureDetail] = React.useState<string | null | undefined>(undefined);
    React.useEffect(() => {
        const failure = snapshot.failure;
        if (failure !== null && failure.modelId === model.id) {
            setFailureDetail(failure.detail ?? null);
        }
    }, [snapshot, model.id]);

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
        <ModalRoot closeModal={completed ? onComplete : onCancelRequest}>
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

export function openModelDownloadModal(params: {
    readonly model: CatalogModel;
    readonly locale: Locale;
    readonly store: StateStore<ModelCatalogSnapshot>;
    readonly onCompleted: (modelId: string) => void;
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
            return;
        }
        if (model.installed) {
            onChange(model.id);
            return;
        }
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
                {...CONTROLLED_DROPDOWN}
            />
        </div>
    );
}

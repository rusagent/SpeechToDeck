/**
 * ModelPicker (spec §48/§54/§80, ADR-011) — the curated model catalog as
 * reported by the backend `list_models` callable, grouped for the Quick
 * Access Menu: the recommended general-purpose picks, the legacy curated v1
 * models under "More", and — when the LanguagePicker selection is a concrete
 * language — the models specialized for that language.
 *
 * Per row: install state (existing dot pattern, per-model `installed` flag),
 * human-readable size, and one action button. Selection (update_settings)
 * is only offered for installed models; not-installed rows offer the
 * download first; the downloading row offers cancel with a live percentage.
 * The backend runs one download at a time (§52), so every other download
 * button is disabled while one is in flight.
 */

import * as React from "react";
import { ButtonItem } from "@decky/ui";
import { modelDisplayName, translate } from "../i18n/messages";
import type { Locale, MessageKey } from "../i18n/messages";
import type { CatalogModel, ModelCatalogSnapshot } from "../../application/ports/ModelCatalogPort";
import { LANGUAGE_SENTINELS } from "./LanguagePicker";
import { FieldHint } from "./FieldHint";

/** General-purpose models the catalog highlights as recommended (ADR-011). */
const RECOMMENDED_MODEL_IDS: readonly string[] = [
    "whisper-large-v3-turbo-q5_0",
    "whisper-large-v3-turbo",
];

/** Install state of one catalog model. */
export type ModelInstallState = "installed" | "not-installed" | "unknown";

const INSTALL_HINT_KEYS: Record<ModelInstallState, MessageKey> = {
    installed: "hint.model.installed",
    "not-installed": "hint.model.notInstalled",
    unknown: "hint.model.unknown",
};

const INSTALL_DOT_COLORS: Record<ModelInstallState, string> = {
    installed: "#5ac189",
    "not-installed": "#ff5c5c",
    unknown: "#8f98a0",
};

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

export interface ModelPickerProps {
    /** Selected model id (a curated catalog id, persisted via settings). */
    readonly value: string;
    readonly locale: Locale;
    /** Current language selection; a concrete tag enables the language group. */
    readonly language: string;
    readonly catalog: ModelCatalogSnapshot;
    /** Select an installed model (persists modelId through update_settings). */
    readonly onChange: (modelId: string) => void;
    /** Start the download for a not-installed model. */
    readonly onDownload: (modelId: string) => void;
    /** Cancel the in-flight download. */
    readonly onCancel: () => void;
}

interface ModelRowProps {
    readonly model: CatalogModel;
    readonly locale: Locale;
    readonly selected: boolean;
    readonly download: ModelCatalogSnapshot["download"];
    readonly downloadInFlight: boolean;
    readonly onSelect: (modelId: string) => void;
    readonly onDownload: (modelId: string) => void;
    readonly onCancel: () => void;
}

function ModelRow({
    model,
    locale,
    selected,
    download,
    downloadInFlight,
    onSelect,
    onDownload,
    onCancel,
}: ModelRowProps): React.ReactElement {
    const downloading = download !== null && download.modelId === model.id;
    const installState: ModelInstallState = model.installed ? "installed" : "not-installed";
    const sizeText = model.sizeBytes === undefined ? null : formatSize(model.sizeBytes);

    let actionLabel: string;
    let actionDisabled = false;
    let onAction: () => void = () => undefined;
    if (downloading) {
        actionLabel = translate(locale, "model.action.cancel");
        onAction = onCancel;
    } else if (model.installed) {
        if (selected) {
            actionLabel = translate(locale, "model.action.inUse");
            actionDisabled = true;
        } else {
            actionLabel = translate(locale, "model.action.use");
            onAction = () => onSelect(model.id);
        }
    } else {
        actionLabel = translate(locale, "model.action.download");
        actionDisabled = downloadInFlight;
        onAction = () => onDownload(model.id);
    }
    const percentText = downloading && download.percent !== null ? ` · ${download.percent}%` : "";

    return (
        <ButtonItem
            label={
                <span>
                    <span
                        aria-hidden="true"
                        style={{
                            display: "inline-block",
                            width: 8,
                            height: 8,
                            borderRadius: "50%",
                            background: INSTALL_DOT_COLORS[installState],
                            marginRight: 6,
                        }}
                    />
                    {modelDisplayName(locale, model.id)}
                    {sizeText !== null ? ` · ${sizeText}` : ""}
                    {percentText}
                    {model.description !== undefined ? (
                        <span
                            style={{
                                display: "block",
                                opacity: 0.75,
                                fontSize: 11,
                                whiteSpace: "normal",
                            }}
                        >
                            {model.description}
                        </span>
                    ) : null}
                </span>
            }
            disabled={actionDisabled}
            onClick={onAction}
        >
            {actionLabel}
        </ButtonItem>
    );
}

interface ModelGroup {
    readonly key: string;
    readonly title: string;
    readonly models: readonly CatalogModel[];
}

export function ModelPicker({
    value,
    locale,
    language,
    catalog,
    onChange,
    onDownload,
    onCancel,
}: ModelPickerProps): React.ReactElement {
    const general = catalog.models.filter((model) => model.languages === undefined);
    const recommended = general.filter((model) => RECOMMENDED_MODEL_IDS.includes(model.id));
    const more = general.filter((model) => !RECOMMENDED_MODEL_IDS.includes(model.id));
    const forLanguage =
        language !== LANGUAGE_SENTINELS.system && language !== LANGUAGE_SENTINELS.auto
            ? catalog.models.filter((model) => model.languages?.includes(language) ?? false)
            : [];

    const groups: ModelGroup[] = [];
    if (recommended.length > 0) {
        groups.push({
            key: "recommended",
            title: translate(locale, "model.group.recommended"),
            models: recommended,
        });
    }
    if (more.length > 0) {
        groups.push({ key: "more", title: translate(locale, "model.group.more"), models: more });
    }
    if (forLanguage.length > 0) {
        groups.push({
            key: "for-language",
            title: `${translate(locale, "model.group.for")} ${language}`,
            models: forLanguage,
        });
    }

    const selectedModel = catalog.models.find((model) => model.id === value);
    const installState: ModelInstallState =
        selectedModel === undefined
            ? "unknown"
            : selectedModel.installed
              ? "installed"
              : "not-installed";

    return (
        <div data-model-catalog="true">
            {groups.length === 0 ? (
                <FieldHint>{translate(locale, "model.catalog.unavailable")}</FieldHint>
            ) : (
                groups.map((group) => (
                    <div key={group.key} data-model-group={group.key} style={{ marginBottom: 8 }}>
                        <div style={{ opacity: 0.7, fontSize: 12, marginBottom: 4 }}>
                            {group.title}
                        </div>
                        {group.models.map((model) => (
                            <ModelRow
                                key={model.id}
                                model={model}
                                locale={locale}
                                selected={model.id === value}
                                download={catalog.download}
                                downloadInFlight={catalog.download !== null}
                                onSelect={onChange}
                                onDownload={onDownload}
                                onCancel={onCancel}
                            />
                        ))}
                    </div>
                ))
            )}
            <FieldHint>{translate(locale, INSTALL_HINT_KEYS[installState])}</FieldHint>
        </div>
    );
}

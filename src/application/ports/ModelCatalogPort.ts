export interface CatalogModel {
    readonly id: string;
    readonly engine: string;
    readonly multilingual: boolean;
    readonly filename: string;
    readonly installed: boolean;
    readonly sizeBytes?: number;
    readonly languages?: readonly string[];
    readonly description?: string;
}

export interface ModelDownloadProgressPayload {
    readonly protocolVersion: 1;
    readonly modelId: string;
    readonly bytesReceived: number;
    readonly totalBytes: number | null;
}

export interface ModelDownloadCompletePayload {
    readonly protocolVersion: 1;
    readonly modelId: string;
    readonly sizeBytes?: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

export function isCatalogModel(value: unknown): value is CatalogModel {
    if (!isRecord(value)) {
        return false;
    }
    const sizeBytes = value["sizeBytes"];
    if (sizeBytes !== undefined && (typeof sizeBytes !== "number" || !Number.isFinite(sizeBytes))) {
        return false;
    }
    const languages = value["languages"];
    if (
        languages !== undefined &&
        (!Array.isArray(languages) || !languages.every((code) => typeof code === "string"))
    ) {
        return false;
    }
    const description = value["description"];
    if (description !== undefined && typeof description !== "string") {
        return false;
    }
    return (
        typeof value["id"] === "string" &&
        value["id"].length > 0 &&
        typeof value["engine"] === "string" &&
        typeof value["multilingual"] === "boolean" &&
        typeof value["filename"] === "string" &&
        typeof value["installed"] === "boolean"
    );
}

export function isModelCatalogPayload(
    value: unknown,
): value is { readonly protocolVersion: 1; readonly models: CatalogModel[] } {
    if (!isRecord(value) || value["protocolVersion"] !== 1 || !Array.isArray(value["models"])) {
        return false;
    }
    return (value["models"] as unknown[]).every(isCatalogModel);
}

export function isModelDownloadProgressPayload(
    value: unknown,
): value is ModelDownloadProgressPayload {
    if (!isRecord(value)) {
        return false;
    }
    return (
        value["protocolVersion"] === 1 &&
        typeof value["modelId"] === "string" &&
        value["modelId"].length > 0 &&
        typeof value["bytesReceived"] === "number" &&
        Number.isFinite(value["bytesReceived"]) &&
        (value["totalBytes"] === null ||
            (typeof value["totalBytes"] === "number" && Number.isFinite(value["totalBytes"])))
    );
}

export function isModelDownloadCompletePayload(
    value: unknown,
): value is ModelDownloadCompletePayload {
    if (!isRecord(value)) {
        return false;
    }
    const sizeBytes = value["sizeBytes"];
    const sizeBytesValid =
        sizeBytes === undefined ||
        sizeBytes === null ||
        (typeof sizeBytes === "number" && Number.isFinite(sizeBytes));
    return (
        value["protocolVersion"] === 1 &&
        typeof value["modelId"] === "string" &&
        value["modelId"].length > 0 &&
        sizeBytesValid
    );
}

export interface ModelDownloadState {
    readonly modelId: string;
    readonly percent: number | null;
}

export interface ModelDownloadFailure {
    readonly modelId: string;
    readonly detail: string | null;
}

export interface ModelCatalogSnapshot {
    readonly models: readonly CatalogModel[];
    readonly download: ModelDownloadState | null;
    readonly failure: ModelDownloadFailure | null;
}

export const EMPTY_MODEL_CATALOG: ModelCatalogSnapshot = {
    models: [],
    download: null,
    failure: null,
};

export class ModelCatalogStore {
    private readonly listeners = new Set<() => void>();
    private snapshot: ModelCatalogSnapshot = EMPTY_MODEL_CATALOG;

    getSnapshot(): ModelCatalogSnapshot {
        return this.snapshot;
    }

    subscribe(listener: () => void): () => void {
        this.listeners.add(listener);
        return () => {
            this.listeners.delete(listener);
        };
    }

    setModels(models: readonly CatalogModel[]): void {
        this.snapshot = { ...this.snapshot, models };
        this.notify();
    }

    publishProgress(payload: ModelDownloadProgressPayload): void {
        const percent =
            payload.totalBytes !== null && payload.totalBytes > 0
                ? Math.min(100, Math.floor((payload.bytesReceived * 100) / payload.totalBytes))
                : null;
        this.snapshot = { ...this.snapshot, download: { modelId: payload.modelId, percent } };
        this.notify();
    }

    publishComplete(payload: ModelDownloadCompletePayload): void {
        this.snapshot = {
            models: this.snapshot.models.map((model) =>
                model.id === payload.modelId ? { ...model, installed: true } : model,
            ),
            download: { modelId: payload.modelId, percent: 100 },
            failure: null,
        };
        this.notify();
    }

    publishFailure(modelId: string, detail: string | null): void {
        this.snapshot = { ...this.snapshot, download: null, failure: { modelId, detail } };
        this.notify();
    }

    clearFailure(): void {
        if (this.snapshot.failure === null) {
            return;
        }
        this.snapshot = { ...this.snapshot, failure: null };
        this.notify();
    }

    clearDownload(): void {
        if (this.snapshot.download === null) {
            return;
        }
        this.snapshot = { ...this.snapshot, download: null };
        this.notify();
    }

    markDeleted(modelId: string): void {
        this.snapshot = {
            ...this.snapshot,
            models: this.snapshot.models.map((model) =>
                model.id === modelId ? { ...model, installed: false } : model,
            ),
        };
        this.notify();
    }

    private notify(): void {
        for (const listener of [...this.listeners]) {
            listener();
        }
    }
}

export interface ModelCatalogPort {
    list(): Promise<readonly CatalogModel[]>;

    download(modelId: string): Promise<void>;

    cancelDownload(): Promise<void>;

    deleteModel(modelId: string): Promise<void>;
}

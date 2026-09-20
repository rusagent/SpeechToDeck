/**
 * Curated model catalog port (ADR-011): the backend's `list_models` callable
 * plus the `model_download_progress` / `model_download_complete` events with
 * their manual boundary type guards (§99) and the small dedicated store the
 * plugin panel's ModelSelect (dropdown + download modal) consumes.
 *
 * Like setup progress and the level meter this is transport-level UI state:
 * it never enters the dictation state machine (§8) and is observed only by
 * the settings panel through `useSyncExternalStore` (§102). Invalid payloads
 * are dropped by the adapter (count-logged), never rendered.
 */

/** One curated model with its install state, as reported by `list_models`. */
export interface CatalogModel {
    readonly id: string;
    readonly engine: string;
    readonly multilingual: boolean;
    readonly filename: string;
    readonly installed: boolean;
    readonly sizeBytes?: number;
    /** Language codes a specialized model was built for; absent = general. */
    readonly languages?: readonly string[];
    /** One short English sentence from the manifest (ADR-011). */
    readonly description?: string;
}

/** Versioned `model_download_progress` payload (§67). */
export interface ModelDownloadProgressPayload {
    readonly protocolVersion: 1;
    readonly modelId: string;
    readonly bytesReceived: number;
    readonly totalBytes: number | null;
}

/** Versioned `model_download_complete` payload (§67). */
export interface ModelDownloadCompletePayload {
    readonly protocolVersion: 1;
    readonly modelId: string;
    readonly sizeBytes?: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null;
}

/** Manual type guard for one `list_models` entry (§99). */
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

/** Manual type guard for the versioned `list_models` response (§99). */
export function isModelCatalogPayload(
    value: unknown,
): value is { readonly protocolVersion: 1; readonly models: CatalogModel[] } {
    if (!isRecord(value) || value["protocolVersion"] !== 1 || !Array.isArray(value["models"])) {
        return false;
    }
    return (value["models"] as unknown[]).every(isCatalogModel);
}

/** Manual type guard for `model_download_progress` payloads (§99). */
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

/** Manual type guard for `model_download_complete` payloads (§99). */
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

/**
 * The single in-flight download (§52: one download at a time). After a
 * successful completion the state deliberately HOLDS the final 100% frame
 * of the settled download (honest completion: the modal shows the full bar
 * during its short completion hold) until the next download's first
 * progress frame overwrites it — a failure or cancellation clears it.
 */
export interface ModelDownloadState {
    readonly modelId: string;
    /** 0–100, or null while the total size is not (yet) known. */
    readonly percent: number | null;
}

/**
 * The last FAILED download attempt (v0.2.5): the backend detail string plus
 * the model it belonged to, surfaced by the download modal's error state.
 * Cancellations never land here — they are user-initiated completion, not
 * failure. Cleared when the next download starts or completes.
 */
export interface ModelDownloadFailure {
    readonly modelId: string;
    /** Backend-provided diagnosable detail (§73-safe), null when absent. */
    readonly detail: string | null;
}

/** Immutable render snapshot of the catalog panel (§102: stable identity). */
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

/**
 * Minimal external store for the catalog + download state (§102 shape:
 * `getSnapshot`/`subscribe` pair consumed by `useSyncExternalStore`).
 * Structurally compatible with `StateStore<T>`; the adapter owns payload
 * validation and calls the publish methods with guarded payloads only.
 */
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

    /** Replaces the catalog after a guarded `list_models` response. */
    setModels(models: readonly CatalogModel[]): void {
        this.snapshot = { ...this.snapshot, models };
        this.notify();
    }

    /** Ingests an already guarded progress payload; unknown total → null %. */
    publishProgress(payload: ModelDownloadProgressPayload): void {
        const percent =
            payload.totalBytes !== null && payload.totalBytes > 0
                ? Math.min(100, Math.floor((payload.bytesReceived * 100) / payload.totalBytes))
                : null;
        this.snapshot = { ...this.snapshot, download: { modelId: payload.modelId, percent } };
        this.notify();
    }

    /**
     * Ingests an already guarded complete payload: marks the model installed
     * AND keeps the download state as a final percent-100 snapshot. The
     * throttle-to-2s progress stream previously meant faster downloads could
     * stall at their last rendered frame; nulling the download atomically
     * with the install flip let the modal close before any 100% frame ever
     * painted. The modal reads this snapshot to show the full bar during its
     * short completion hold before it closes (and the selection persists).
     */
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

    /**
     * Records a failed download attempt for the modal's error state. The
     * in-flight download state clears with it (the attempt is settled);
     * the failure record stays until the next download starts or completes.
     */
    publishFailure(modelId: string, detail: string | null): void {
        this.snapshot = { ...this.snapshot, download: null, failure: { modelId, detail } };
        this.notify();
    }

    /** Clears a stale failure record (called when a new download starts). */
    clearFailure(): void {
        if (this.snapshot.failure === null) {
            return;
        }
        this.snapshot = { ...this.snapshot, failure: null };
        this.notify();
    }

    /**
     * Clears the download state (cancellation settle path; publishComplete
     * and publishFailure manage the state themselves on their settle paths).
     */
    clearDownload(): void {
        if (this.snapshot.download === null) {
            return;
        }
        this.snapshot = { ...this.snapshot, download: null };
        this.notify();
    }

    /**
     * Marks one model's install state cleared after a successful
     * `delete_model` callable (in-app model cleanup): immediate honest
     * feedback while the authoritative catalog refresh (the existing
     * `list_models` path) is still in flight. Download state is untouched —
     * the backend rejects deleting a model whose download is in flight.
     */
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

/** Catalog access port (implemented by the Decky speech adapter). */
export interface ModelCatalogPort {
    /** Loads the curated catalog into the store and returns it. */
    list(): Promise<readonly CatalogModel[]>;

    /** Starts the single-flight download for one model (§52). */
    download(modelId: string): Promise<void>;

    /** Cancels the active download, if any. */
    cancelDownload(): Promise<void>;

    /**
     * Deletes one installed model's artifact backend-side (in-app model
     * cleanup): the id is the ONLY input — the backend resolves the file
     * path from its strict manifest. The selected model and a model with a
     * download in flight are coded rejections; an already-absent artifact is
     * an idempotent success.
     */
    deleteModel(modelId: string): Promise<void>;
}

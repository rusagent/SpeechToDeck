/**
 * ModelCatalogStore tests: the guarded catalog + download
 * state side-channel consumed by the ModelSelect dropdown + download modal
 * through `useSyncExternalStore`. The adapter owns payload validation; these
 * tests drive the publish methods with valid payloads only (guards are
 * covered in ProtocolGuards.test.ts).
 */

import { describe, expect, it, vi } from "vitest";

import {
    EMPTY_MODEL_CATALOG,
    ModelCatalogStore,
} from "../../src/application/ports/ModelCatalogPort";

const MODELS = [
    {
        id: "base",
        engine: "whisper",
        multilingual: true,
        filename: "ggml-base.bin",
        installed: true,
        sizeBytes: 147951465,
    },
    {
        id: "distil-small-en",
        engine: "whisper",
        multilingual: false,
        filename: "ggml-distil-small.en.bin",
        installed: false,
        sizeBytes: 336191657,
        languages: ["en"],
        description: "English-only distilled model with the lowest latency.",
    },
] as const;

function progress(modelId: string, bytesReceived: number, totalBytes: number | null) {
    return { protocolVersion: 1 as const, modelId, bytesReceived, totalBytes };
}

describe("ModelCatalogStore", () => {
    it("starts empty and notifies subscribers on setModels", () => {
        const store = new ModelCatalogStore();
        expect(store.getSnapshot()).toBe(EMPTY_MODEL_CATALOG);

        const listener = vi.fn();
        const unsubscribe = store.subscribe(listener);
        store.setModels([...MODELS]);

        expect(store.getSnapshot().models).toHaveLength(2);
        expect(store.getSnapshot().download).toBeNull();
        expect(listener).toHaveBeenCalledTimes(1);
        unsubscribe();
    });

    it("computes the download percent and reports null without a total", () => {
        const store = new ModelCatalogStore();
        store.setModels([...MODELS]);

        store.publishProgress(progress("distil-small-en", 50, 200));
        expect(store.getSnapshot().download).toEqual({ modelId: "distil-small-en", percent: 25 });

        // > 100% received is clamped; the renderer never shows 101%.
        store.publishProgress(progress("distil-small-en", 999, 200));
        expect(store.getSnapshot().download).toEqual({ modelId: "distil-small-en", percent: 100 });

        store.publishProgress(progress("distil-small-en", 10, null));
        expect(store.getSnapshot().download).toEqual({ modelId: "distil-small-en", percent: null });
    });

    // Honest completion (on-device finding): the throttled progress
    // stream plus the old complete-clears-download semantics meant faster
    // downloads closed the modal from a stale lower frame. Completion now
    // keeps a final percent-100 snapshot alongside the install flip so the
    // modal can show the full bar during its completion hold.
    it("marks the completed model installed and keeps the final 100% download state", () => {
        const store = new ModelCatalogStore();
        store.setModels([...MODELS]);
        store.publishProgress(progress("distil-small-en", 10, 200));

        store.publishComplete({ protocolVersion: 1, modelId: "distil-small-en", sizeBytes: 12 });

        expect(store.getSnapshot().download).toEqual({
            modelId: "distil-small-en",
            percent: 100,
        });
        const distil = store.getSnapshot().models.find((model) => model.id === "distil-small-en");
        const base = store.getSnapshot().models.find((model) => model.id === "base");
        expect(distil?.installed).toBe(true);
        expect(base?.installed).toBe(true); // unchanged entry keeps its state

        // The final frame exists even without a preceding progress payload.
        store.publishComplete({ protocolVersion: 1, modelId: "base", sizeBytes: 12 });
        expect(store.getSnapshot().download).toEqual({ modelId: "base", percent: 100 });
    });

    it("clears the download state on failure paths and is a no-op without one", () => {
        const store = new ModelCatalogStore();
        store.setModels([...MODELS]);

        const listener = vi.fn();
        store.subscribe(listener);
        store.clearDownload(); // nothing in flight: no notification
        expect(listener).not.toHaveBeenCalled();

        store.publishProgress(progress("base", 5, 100));
        store.clearDownload();
        expect(store.getSnapshot().download).toBeNull();
        expect(listener).toHaveBeenCalledTimes(2);
    });

    // Decision point (on-device finding): a failed download must carry
    // its backend detail for the modal's error state, and the record must not
    // leak into the next attempt.
    it("publishes the failure detail for a model and clears it when the next download starts", () => {
        const store = new ModelCatalogStore();
        store.setModels([...MODELS]);
        store.publishProgress(progress("distil-small-en", 10, 200));

        const listener = vi.fn();
        store.subscribe(listener);
        store.publishFailure("distil-small-en", "HTTP 403 host=huggingface.co");
        expect(store.getSnapshot().failure).toEqual({
            modelId: "distil-small-en",
            detail: "HTTP 403 host=huggingface.co",
        });
        // The attempt is settled: no progress row can stick.
        expect(store.getSnapshot().download).toBeNull();
        expect(listener).toHaveBeenCalledTimes(1);

        // A failing detail is optional: the error state still renders.
        store.publishFailure("distil-small-en", null);
        expect(store.getSnapshot().failure?.detail).toBeNull();

        // Starting the next download clears the stale failure record.
        store.clearFailure();
        expect(store.getSnapshot().failure).toBeNull();

        // Clearing without a failure is a no-op.
        const before = store.getSnapshot();
        store.clearFailure();
        expect(store.getSnapshot()).toBe(before);
    });

    it("completing a download also clears any failure record", () => {
        const store = new ModelCatalogStore();
        store.setModels([...MODELS]);
        store.publishFailure("distil-small-en", "HTTP 500 host=huggingface.co");

        store.publishComplete({ protocolVersion: 1, modelId: "distil-small-en", sizeBytes: 12 });

        expect(store.getSnapshot().failure).toBeNull();
    });

    // In-app model cleanup (owner request): a successful delete_model marks
    // the model not installed for immediate honest feedback while the
    // authoritative list_models refresh is still in flight.
    it("marks the deleted model not installed and leaves the rest untouched", () => {
        const store = new ModelCatalogStore();
        store.setModels([...MODELS]);
        store.publishProgress(progress("distil-small-en", 10, 200));

        const listener = vi.fn();
        store.subscribe(listener);
        store.markDeleted("base");

        expect(store.getSnapshot().models.find((model) => model.id === "base")?.installed).toBe(
            false,
        );
        expect(store.getSnapshot().models.find((model) => model.id === "base")?.sizeBytes).toBe(
            147951465,
        );
        expect(store.getSnapshot().models.find((model) => model.id === "distil-small-en")).toEqual(
            MODELS[1],
        ); // untouched entry keeps its identity and state
        // The backend rejects deleting a model with a download in flight, so
        // a delete never touches that state either.
        expect(store.getSnapshot().download).toEqual({ modelId: "distil-small-en", percent: 5 });
        expect(listener).toHaveBeenCalledTimes(1);

        // Marking an unknown id is a harmless no-op over the same rows.
        store.markDeleted("nonexistent");
        expect(store.getSnapshot().models).toHaveLength(2);
    });

    it("keeps snapshot identity stable when nothing changed", () => {
        const store = new ModelCatalogStore();
        const first = store.getSnapshot();
        expect(store.getSnapshot()).toBe(first);
    });
});

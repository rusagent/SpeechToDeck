/**
 * ModelCatalogStore tests (§102, ADR-011): the guarded catalog + download
 * state side-channel consumed by the ModelPicker through
 * `useSyncExternalStore`. The adapter owns payload validation; these tests
 * drive the publish methods with valid payloads only (guards are covered in
 * ProtocolGuards.test.ts).
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

    it("marks the completed model installed and clears the download state", () => {
        const store = new ModelCatalogStore();
        store.setModels([...MODELS]);
        store.publishProgress(progress("distil-small-en", 10, 200));

        store.publishComplete({ protocolVersion: 1, modelId: "distil-small-en", sizeBytes: 12 });

        expect(store.getSnapshot().download).toBeNull();
        const distil = store.getSnapshot().models.find((model) => model.id === "distil-small-en");
        const base = store.getSnapshot().models.find((model) => model.id === "base");
        expect(distil?.installed).toBe(true);
        expect(base?.installed).toBe(true); // unchanged entry keeps its state
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

    it("keeps snapshot identity stable when nothing changed (§102)", () => {
        const store = new ModelCatalogStore();
        const first = store.getSnapshot();
        expect(store.getSnapshot()).toBe(first);
    });
});

/**
 * ModelPicker render tests (§48/§54/§80, ADR-011).
 *
 * Named production defect (lane A red receipt): the v0.2 picker hardcoded the
 * ["tiny","base","small"] option list and the backend `list_models` callable
 * had no frontend consumer at all. Oracle: the picker renders the backend
 * catalog snapshot (groups, sizes, install states), gates selection on the
 * per-model installed flag, drives the download/cancel callables, and shows
 * the live download percentage.
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ModelPicker } from "../../src/presentation/settings/ModelPicker";
import type {
    CatalogModel,
    ModelCatalogSnapshot,
} from "../../src/application/ports/ModelCatalogPort";
import type { Locale } from "../../src/presentation/i18n/messages";

// §80 renders through @decky/ui components that expect the Steam UI
// environment; the ButtonItem stub renders the row label and the action
// button as separate queryable nodes under a plain-DOM shim.
vi.mock("@decky/ui", async () => {
    const React = await import("react");
    const h = React.createElement;
    type Children = import("react").ReactNode;
    return {
        ButtonItem: (props: {
            label?: Children;
            disabled?: boolean;
            onClick?: () => void;
            children?: Children;
        }) =>
            h(
                "div",
                { "data-model-row": true },
                h("div", { "data-row-label": true }, props.label),
                h(
                    "button",
                    { disabled: props.disabled === true, onClick: props.onClick },
                    props.children ?? props.label,
                ),
            ),
    };
});

afterEach(cleanup);

function model(overrides: Partial<CatalogModel>): CatalogModel {
    return {
        id: "base",
        engine: "whisper",
        multilingual: true,
        filename: "ggml-base.bin",
        installed: false,
        ...overrides,
    };
}

function catalogFixture(download: ModelCatalogSnapshot["download"] = null): ModelCatalogSnapshot {
    return {
        models: [
            model({
                id: "whisper-large-v3-turbo-q5_0",
                filename: "ggml-large-v3-turbo-q5_0.bin",
                sizeBytes: 574041195,
                description: "Recommended primary model.",
            }),
            model({
                id: "whisper-large-v3-turbo",
                filename: "ggml-large-v3-turbo.bin",
                sizeBytes: 1624555275,
            }),
            model({ id: "tiny", filename: "ggml-tiny.bin", sizeBytes: 77691713, installed: true }),
            model({ id: "base", filename: "ggml-base.bin", sizeBytes: 147951465, installed: true }),
            model({ id: "small", filename: "ggml-small.bin", sizeBytes: 487601967 }),
            model({
                id: "distil-small-en",
                engine: "whisper",
                multilingual: false,
                filename: "ggml-distil-small.en.bin",
                sizeBytes: 336191657,
                languages: ["en"],
            }),
            model({
                id: "whisper-large-v3-turbo-german-q5_0",
                filename: "ggml-primeline-de-turbo-q5_0.bin",
                sizeBytes: 574041195,
                languages: ["de"],
            }),
        ],
        download,
    };
}

function renderPicker(
    catalog: ModelCatalogSnapshot,
    language = "system",
    locale: Locale = "en",
    handlers: {
        onChange?: (id: string) => void;
        onDownload?: (id: string) => void;
        onCancel?: () => void;
    } = {},
) {
    return render(
        <ModelPicker
            value="base"
            locale={locale}
            language={language}
            catalog={catalog}
            onChange={handlers.onChange ?? (() => undefined)}
            onDownload={handlers.onDownload ?? (() => undefined)}
            onCancel={handlers.onCancel ?? (() => undefined)}
        />,
    );
}

describe("ModelPicker", () => {
    it("renders the backend catalog groups, sizes and descriptions (catalog replaces the hardcoded dropdown)", () => {
        renderPicker(catalogFixture());

        expect(screen.getByText("Recommended")).not.toBeNull();
        expect(screen.getByText(/Large v3 Turbo Q5_0/)).not.toBeNull();
        expect(screen.getByText(/Large v3 Turbo · 1\.6 GB/)).not.toBeNull();
        expect(screen.getByText(/Recommended primary model\./)).not.toBeNull();
        expect(screen.getByText("More models")).not.toBeNull();
        expect(screen.getByText(/Tiny \(fastest\) · 78 MB/)).not.toBeNull();
        // The 574 MB size is the human-readable sizeBytes from the catalog.
        expect(screen.getByText(/574 MB/)).not.toBeNull();
    });

    it("localizes the group titles and actions in German", () => {
        renderPicker(catalogFixture(), "system", "de");

        expect(screen.getByText("Empfohlen")).not.toBeNull();
        expect(screen.getByText("Weitere Modelle")).not.toBeNull();
        expect(screen.getByText("Verwenden")).not.toBeNull();
    });

    it("shows the per-language group for a concrete language and omits it otherwise", () => {
        const { rerender } = renderPicker(catalogFixture(), "de");
        expect(screen.getByText("For de")).not.toBeNull();
        expect(screen.getByText(/Large v3 Turbo German Q5_0/)).not.toBeNull();

        rerender(
            <ModelPicker
                value="base"
                locale="en"
                language="en"
                catalog={catalogFixture()}
                onChange={() => undefined}
                onDownload={() => undefined}
                onCancel={() => undefined}
            />,
        );
        expect(screen.getByText("For en")).not.toBeNull();
        expect(screen.getByText(/Distil Small \(English\)/)).not.toBeNull();

        rerender(
            <ModelPicker
                value="base"
                locale="en"
                language="system"
                catalog={catalogFixture()}
                onChange={() => undefined}
                onDownload={() => undefined}
                onCancel={() => undefined}
            />,
        );
        expect(screen.queryByText(/^For /)).toBeNull();
    });

    it("offers Use only for installed models and selects through onChange", () => {
        const onChange = vi.fn();
        renderPicker(catalogFixture(), "system", "en", { onChange });

        // base is installed but already selected: disabled "In use".
        const inUse = screen.getByRole("button", { name: "In use" }) as HTMLButtonElement;
        expect(inUse.disabled).toBe(true);

        // The only other installed row (tiny) offers Use; every not-installed
        // row offers the download first — exactly one Use button exists.
        fireEvent.click(screen.getByRole("button", { name: "Use" }));
        expect(onChange).toHaveBeenCalledTimes(1);
        expect(onChange).toHaveBeenCalledWith("tiny");
    });

    it("downloads a not-installed model and enables every download while none runs", () => {
        const onDownload = vi.fn();
        renderPicker(catalogFixture(), "system", "en", { onDownload });

        const downloads = screen
            .getAllByRole("button", { name: "Download" })
            .map((button) => button as HTMLButtonElement);
        expect(downloads.length).toBeGreaterThan(1);
        expect(downloads.every((button) => !button.disabled)).toBe(true);
        fireEvent.click(downloads[0]!);
        expect(onDownload).toHaveBeenCalledWith("whisper-large-v3-turbo-q5_0");
    });

    it("shows the live percentage and offers cancel for the in-flight download", () => {
        const onCancel = vi.fn();
        renderPicker(
            catalogFixture({ modelId: "whisper-large-v3-turbo-q5_0", percent: 42 }),
            "system",
            "en",
            { onCancel },
        );

        expect(screen.getByText(/· 42%/)).not.toBeNull();
        const cancel = screen.getByRole("button", { name: "Cancel" });
        fireEvent.click(cancel);
        expect(onCancel).toHaveBeenCalledTimes(1);
        // The other rows went back to plain (disabled) download offers.
        const downloads = screen
            .getAllByRole("button", { name: "Download" })
            .map((button) => button as HTMLButtonElement);
        expect(downloads.length).toBeGreaterThan(0);
        expect(downloads.every((button) => button.disabled)).toBe(true);
    });

    it("renders the unavailable hint for an empty catalog (§57: reported, never assumed)", () => {
        renderPicker({ models: [], download: null });
        expect(screen.getByText("The model catalog could not be loaded.")).not.toBeNull();
        expect(screen.queryByText("Recommended")).toBeNull();
    });
});

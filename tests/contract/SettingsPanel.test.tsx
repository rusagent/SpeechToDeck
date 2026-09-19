/**
 * SettingsPanel render tests (spec §54/§80/§102).
 *
 * Named production defects: (review finding F1) the panel passed the
 * controller's unbound `subscribe`/`getSnapshot` methods to
 * useSyncExternalStore and threw on first mount; (v0.2.5 declutter) the
 * owner's panel carried dead weight — microphone chip, duration slider, VAD
 * toggle, runtime-health row, whole Diagnostics section — which this suite
 * proves removed, with Speech reading Language → Model.
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "../../src/presentation/settings/SettingsPanel";
import type { DiagnosticsSource } from "../../src/presentation/settings/DiagnosticsSource";
import { DeckyBackendClient } from "../../src/infrastructure/decky/DeckyBackendClient";
import { DeckySpeechAdapter } from "../../src/infrastructure/decky/DeckySpeechAdapter";
import type { SetupProgressSnapshot } from "../../src/application/ports/SetupProgressPort";
import {
    FAILED_GET_STATUS_REPORT,
    SETUP_SNAPSHOTS,
    FakeDeckyTransport,
    FakeSnapshotStore,
    FakeStateStore,
} from "./helpers";
import { FakeSettingsPort } from "../frontend/fakes/FakeSettingsPort";
import { LevelMeterStore } from "../../src/application/ports/LevelMeterPort";
import { ModelCatalogStore } from "../../src/application/ports/ModelCatalogPort";
import type { DictationState } from "../../src/domain/DictationState";

// §80 renders through @decky/ui components that expect the Steam UI
// environment; the stubs below keep the panel's own logic (loading state,
// §80 sections, store subscription) the subject under a plain-DOM shim.
vi.mock("@decky/ui", async () => {
    const React = await import("react");
    const h = React.createElement;
    type Children = import("react").ReactNode;
    return {
        PanelSection: (props: { title?: string; children?: Children }) =>
            h("section", { "data-panel-title": props.title }, props.children),
        PanelSectionRow: (props: { children?: Children }) => h("div", null, props.children),
        ToggleField: (props: { label: string; checked: boolean }) =>
            h("label", { "data-toggle": props.label }, `${props.label}: ${String(props.checked)}`),
        SliderField: (props: { label: string; value: number }) =>
            h("label", { "data-slider": props.label }, `${props.label}: ${String(props.value)}`),
        DropdownItem: (props: { label: string; selectedOption: unknown }) =>
            h(
                "label",
                { "data-dropdown": props.label },
                `${props.label}: ${String(props.selectedOption)}`,
            ),
        ButtonItem: (props: {
            label?: string;
            disabled?: boolean;
            onClick?: () => void;
            children?: Children;
        }) =>
            h(
                "button",
                { disabled: props.disabled === true, onClick: props.onClick },
                props.children ?? props.label,
            ),
        // Field wraps label and children in separate nodes like the Steam UI
        // field, so label and value are individually queryable.
        Field: (props: { label: string; children?: Children }) =>
            h(
                "div",
                { "data-field": props.label },
                h("span", { "data-field-label": props.label }, props.label),
                h("span", { "data-field-value": props.label }, props.children),
            ),
    };
});

afterEach(cleanup);

function fakeDiagnostics(): DiagnosticsSource {
    return {
        loadCapabilityReport: async () => null,
        loadSpeechCapabilities: async () => null,
        hydrateSetupProgress: async () => undefined,
        restartRuntime: async () => undefined,
    };
}

function fakeSetupStore(
    snapshot: SetupProgressSnapshot | null = null,
): FakeSnapshotStore<SetupProgressSnapshot> {
    return new FakeSnapshotStore(snapshot);
}

function recordingState(): DictationState {
    return {
        kind: "recording",
        session: { sessionId: "s1", keyboardContextId: "c1", startedAtMonotonicMs: 0 },
    };
}

describe("SettingsPanel", () => {
    it("mounts and renders the decluttered §80 sections without throwing (review finding F1)", async () => {
        const { container } = render(
            <SettingsPanel
                settings={new FakeSettingsPort()}
                store={new FakeStateStore({ kind: "booting" })}
                setupProgress={fakeSetupStore()}
                diagnostics={fakeDiagnostics()}
            />,
        );
        expect(container.querySelector('[data-panel-title="SpeechToDeck"]')).not.toBeNull();
        expect(screen.getByText("Loading settings…")).not.toBeNull();

        // §80 sections: runtime, speech, output. Kept rows only.
        expect(await screen.findByText(/Enable plugin/)).not.toBeNull();
        expect(screen.getAllByText(/Compute backend/).length).toBeGreaterThan(0);
        expect(screen.getAllByText(/Language/).length).toBeGreaterThan(0);
        expect(screen.getAllByText(/Output mode/).length).toBeGreaterThan(0);

        // v0.2.5 owner declutter: the removed rows and the whole Diagnostics
        // section are gone.
        expect(screen.queryByText(/Runtime health/)).toBeNull();
        expect(screen.queryByText(/Maximum recording duration/)).toBeNull();
        expect(screen.queryByText(/Voice activity detection/)).toBeNull();
        expect(screen.queryByText(/Steam keyboard detected/)).toBeNull();
        expect(container.querySelector('[data-panel-title="Diagnostics"]')).toBeNull();
    });

    it("orders the Speech section Language → Model when the catalog is wired", async () => {
        const store = new ModelCatalogStore();
        store.setModels([
            {
                id: "base",
                engine: "whisper",
                multilingual: true,
                filename: "ggml-base.bin",
                installed: true,
            },
        ]);
        const modelCatalog = {
            store,
            load: async () => undefined,
            download: () => undefined,
            cancel: () => undefined,
        };
        const { container } = render(
            <SettingsPanel
                settings={new FakeSettingsPort()}
                store={new FakeStateStore({ kind: "booting" })}
                setupProgress={fakeSetupStore()}
                diagnostics={fakeDiagnostics()}
                modelCatalog={modelCatalog}
            />,
        );
        await screen.findByText(/Enable plugin/);

        const dropdowns = Array.from(container.querySelectorAll("[data-dropdown]")).map((node) =>
            node.getAttribute("data-dropdown"),
        );
        const languageIndex = dropdowns.indexOf("Language");
        const modelIndex = dropdowns.indexOf("Model");
        expect(languageIndex).toBeGreaterThanOrEqual(0);
        expect(modelIndex).toBeGreaterThan(languageIndex);
    });

    it("rerenders the dictation card from controller-store state changes (§102)", async () => {
        const store = new FakeStateStore({ kind: "ready" });
        render(
            <SettingsPanel
                settings={new FakeSettingsPort()}
                store={store}
                setupProgress={fakeSetupStore()}
                diagnostics={fakeDiagnostics()}
                dictation={{
                    levelMeter: new LevelMeterStore(),
                    transcript: new FakeSnapshotStore(null),
                    onPress: () => undefined,
                    onCopy: async () => true,
                }}
            />,
        );
        expect(await screen.findByText(/Enable plugin/)).not.toBeNull();
        expect(document.querySelector('button[data-state="ready"]')).not.toBeNull();

        await act(async () => {
            store.set(recordingState());
        });
        expect(document.querySelector('button[data-state="recording"]')).not.toBeNull();
    });

    it("renders the setup progress above the §80 sections while setup is running", async () => {
        const setup = fakeSetupStore();
        const { container } = render(
            <SettingsPanel
                settings={new FakeSettingsPort()}
                store={new FakeStateStore({ kind: "booting" })}
                setupProgress={setup}
                diagnostics={fakeDiagnostics()}
            />,
        );
        expect(await screen.findByText(/Enable plugin/)).not.toBeNull();
        expect(container.querySelector("[data-setup-progress]")).toBeNull();

        await act(async () => {
            setup.set(SETUP_SNAPSHOTS.download);
        });
        const setupBlock = container.querySelector("[data-setup-progress]");
        const runtimeSection = container.querySelector('[data-panel-title="Runtime"]');
        expect(setupBlock).not.toBeNull();
        expect(runtimeSection).not.toBeNull();
        // Above the sections: the setup block precedes the Runtime section.
        expect(
            setupBlock!.compareDocumentPosition(runtimeSection!) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();
        // Overall percent for download @37% of step 1: 25 + 37/4 = 34.
        expect(screen.getByText("34%")).not.toBeNull();
    });

    it("hides the setup panel on terminal ready and while the plugin is disabled", async () => {
        const setup = fakeSetupStore(SETUP_SNAPSHOTS.download);
        const { container } = render(
            <SettingsPanel
                settings={new FakeSettingsPort()}
                store={new FakeStateStore({ kind: "booting" })}
                setupProgress={setup}
                diagnostics={fakeDiagnostics()}
            />,
        );
        expect(await screen.findByText(/Enable plugin/)).not.toBeNull();
        expect(container.querySelector("[data-setup-progress]")).not.toBeNull();

        await act(async () => {
            setup.set(SETUP_SNAPSHOTS.ready);
        });
        expect(container.querySelector("[data-setup-progress]")).toBeNull();
    });

    it("hides the setup progress while the plugin is disabled", async () => {
        const settings = new FakeSettingsPort();
        settings.value = { ...settings.value, enabled: false };
        const { container } = render(
            <SettingsPanel
                settings={settings}
                store={new FakeStateStore({ kind: "booting" })}
                setupProgress={fakeSetupStore(SETUP_SNAPSHOTS.download)}
                diagnostics={fakeDiagnostics()}
            />,
        );
        expect(await screen.findByText(/Enable plugin/)).not.toBeNull();
        expect(container.querySelector("[data-setup-progress]")).toBeNull();
    });

    it("wires the failed-state retry button to the restart_runtime callable", async () => {
        const transport = new FakeDeckyTransport();
        const backend = new DeckyBackendClient(transport);
        const diagnostics: DiagnosticsSource = {
            loadCapabilityReport: async () => null,
            loadSpeechCapabilities: async () => null,
            hydrateSetupProgress: async () => undefined,
            // Same callable path the composition root wires for diagnostics.
            restartRuntime: async () => {
                await backend.call("restart_runtime");
            },
        };
        render(
            <SettingsPanel
                settings={new FakeSettingsPort()}
                store={new FakeStateStore({ kind: "booting" })}
                setupProgress={fakeSetupStore(SETUP_SNAPSHOTS.failed)}
                diagnostics={diagnostics}
            />,
        );

        fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

        expect(transport.calls.map((call) => call.route)).toEqual(["restart_runtime"]);
    });

    it("renders the hydrated failure from the status report without live events", async () => {
        // On-device v0.1.3 finding: the setup failure fired before the panel
        // mounted and the plain settings UI showed nothing. Hydration through
        // the real adapter chain reconstructs the failed view, the retry
        // button drives restart_runtime, and a live event later replaces the
        // synthesized snapshot.
        const transport = new FakeDeckyTransport();
        transport.callResponses.set("get_status", FAILED_GET_STATUS_REPORT);
        transport.callResponses.set("restart_runtime", { ok: true, restarted: true });
        const backend = new DeckyBackendClient(transport);
        const adapter = new DeckySpeechAdapter(backend);
        adapter.subscribe(() => undefined); // live events reach the store
        const { container } = render(
            <SettingsPanel
                settings={new FakeSettingsPort()}
                store={new FakeStateStore({ kind: "booting" })}
                setupProgress={adapter.setupProgress}
                diagnostics={{
                    loadCapabilityReport: async () => null,
                    loadSpeechCapabilities: async () => null,
                    hydrateSetupProgress: () => adapter.hydrateSetupFromStatus(),
                    restartRuntime: async () => {
                        await backend.call("restart_runtime");
                    },
                }}
            />,
        );

        // Hydrated failed view (no live setup_progress ever emitted).
        expect(await screen.findByText("MODEL_DOWNLOAD_FAILED")).not.toBeNull();
        expect(container.querySelector('[data-setup-progress="failed"]')).not.toBeNull();

        fireEvent.click(await screen.findByRole("button", { name: "Retry" }));
        expect(transport.calls.map((call) => call.route)).toContain("restart_runtime");

        // A live setup_progress event replaces the synthesized snapshot.
        await act(async () => {
            transport.emit("setup_progress", SETUP_SNAPSHOTS.download);
        });
        expect(container.querySelector('[data-setup-progress="model.ensure"]')).not.toBeNull();
        expect(container.querySelector('[data-setup-progress="failed"]')).toBeNull();
        expect(screen.queryByRole("button", { name: "Retry" })).toBeNull();
    });
});

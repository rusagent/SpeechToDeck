/**
 * SettingsPanel render tests (spec §54/§80/§102).
 *
 * Named production defect (review finding F1): the panel passed the
 * controller's unbound `subscribe`/`getSnapshot` methods to
 * useSyncExternalStore; React invokes the subscriber as a plain function, so
 * `this` was undefined in strict mode and the panel threw on first mount.
 * Oracle: the component mounts, renders the §80 sections from the loaded
 * settings document, and rerenders from controller-store state changes.
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "../../src/presentation/settings/SettingsPanel";
import type { DiagnosticsSource } from "../../src/presentation/settings/DiagnosticsPanel";
import { DeckyBackendClient } from "../../src/infrastructure/decky/DeckyBackendClient";
import type { SetupProgressSnapshot } from "../../src/application/ports/SetupProgressPort";
import { SETUP_SNAPSHOTS, FakeDeckyTransport, FakeSnapshotStore, FakeStateStore } from "./helpers";
import { FakeSettingsPort } from "../frontend/fakes/FakeSettingsPort";
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
    it("mounts and renders the §80 sections without throwing (review finding F1)", async () => {
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

        // §80 sections: runtime, speech, output, diagnostics.
        expect(await screen.findByText(/Enable plugin/)).not.toBeNull();
        expect(screen.getAllByText(/Compute backend/).length).toBeGreaterThan(0);
        expect(screen.getAllByText("Runtime health").length).toBeGreaterThan(0);
        expect(screen.getAllByText(/Model/).length).toBeGreaterThan(0);
        expect(screen.getAllByText(/Language/).length).toBeGreaterThan(0);
        expect(screen.getByText(/Maximum recording duration/)).not.toBeNull();
        expect(screen.getByText(/Voice activity detection/)).not.toBeNull();
        expect(screen.getAllByText(/Output mode/).length).toBeGreaterThan(0);
        expect(screen.getAllByText(/Steam keyboard detected/).length).toBeGreaterThan(0);
    });

    it("rerenders runtime health from controller-store state changes (§102)", async () => {
        const store = new FakeStateStore({ kind: "ready" });
        render(
            <SettingsPanel
                settings={new FakeSettingsPort()}
                store={store}
                setupProgress={fakeSetupStore()}
                diagnostics={fakeDiagnostics()}
            />,
        );
        expect(await screen.findAllByText("Ready")).not.toHaveLength(0);

        await act(async () => {
            store.set(recordingState());
        });
        expect(screen.getAllByText("Recording").length).toBeGreaterThan(0);
        expect(screen.queryByText("Ready")).toBeNull();
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
});

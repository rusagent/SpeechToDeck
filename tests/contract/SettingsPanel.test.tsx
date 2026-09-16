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

import { act, cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SettingsPanel } from "../../src/presentation/settings/SettingsPanel";
import type { DiagnosticsSource } from "../../src/presentation/settings/DiagnosticsPanel";
import { FakeStateStore } from "./helpers";
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
        ButtonItem: (props: { label?: string; children?: Children }) =>
            h("button", null, props.children ?? props.label),
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
});

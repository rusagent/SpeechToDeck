/**
 * SettingsPanel render tests.
 *
 * Named production defects: (review finding) the panel passed the
 * controller's unbound `subscribe`/`getSnapshot` methods to
 * useSyncExternalStore and threw on first mount; (declutter) the
 * owner's panel carried dead weight — microphone chip, duration slider, VAD
 * toggle, runtime-health row, whole Diagnostics section — which this suite
 * proves removed, with Speech reading Language → Model; (load-timeout fix)
 * a wedged backend settings load left the eternal "Loading settings…"
 * spinner — the panel must leave the loading state after 10 s on the
 * injected monotonic clock and offer Retry.
 */

import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ReactNode } from "react";
import { SettingsPanel } from "../../src/presentation/settings/SettingsPanel";
import type { SettingsPanelProps } from "../../src/presentation/settings/SettingsPanel";
import type { DiagnosticsSource } from "../../src/presentation/settings/DiagnosticsSource";
import { DeckyBackendClient } from "../../src/infrastructure/decky/DeckyBackendClient";
import { DeckySpeechAdapter } from "../../src/infrastructure/decky/DeckySpeechAdapter";
import type { ClockPort } from "../../src/application/ports/ClockPort";
import type { PluginSettings, SettingsPort } from "../../src/application/ports/SettingsPort";
import type { SetupProgressSnapshot } from "../../src/application/ports/SetupProgressPort";
import {
    FAILED_GET_STATUS_REPORT,
    SETUP_SNAPSHOTS,
    FakeDeckyTransport,
    FakeSnapshotStore,
    FakeStateStore,
} from "./helpers";
import { FakeSettingsPort, TEST_SETTINGS } from "../frontend/fakes/FakeSettingsPort";
import { LevelMeterStore } from "../../src/application/ports/LevelMeterPort";
import { ModelCatalogStore } from "../../src/application/ports/ModelCatalogPort";
import type { DictationState } from "../../src/domain/DictationState";

// The panel renders through @decky/ui components that expect the Steam UI
// environment; the stubs below keep the panel's own logic (loading state,
// sections, store subscription) the subject under a plain-DOM shim.
vi.mock("@decky/ui", async () => {
    const React = await import("react");
    const h = React.createElement;
    type Children = import("react").ReactNode;
    const showModalNodes: Children[] = [];
    return {
        PanelSection: (props: { title?: string; children?: Children }) =>
            h("section", { "data-panel-title": props.title }, props.children),
        PanelSectionRow: (props: { children?: Children }) => h("div", null, props.children),
        ToggleField: (props: { label: string; checked: boolean }) =>
            h("label", { "data-toggle": props.label }, `${props.label}: ${String(props.checked)}`),
        SliderField: (props: { label: string; value: number }) =>
            h("label", { "data-slider": props.label }, `${props.label}: ${String(props.value)}`),
        // Semi-controlled Steam semantics: with `controlled: true` the
        // displayed value derives from selectedOption (the ModelSelect/
        // LanguagePicker revert oracle); without it, from internal state.
        DropdownItem: (props: {
            label: string;
            rgOptions?: {
                data?: unknown;
                label?: Children;
                options?: { data: unknown; label: Children }[];
            }[];
            selectedOption: unknown;
            controlled?: boolean;
        }) => {
            const state = React.useState(props.selectedOption);
            const value = props.controlled === true ? props.selectedOption : state[0];
            type FlatOption = { data: unknown; label?: Children };
            const flat = (props.rgOptions ?? []).flatMap<FlatOption>((entry) =>
                entry.data !== undefined
                    ? [{ data: entry.data, label: entry.label }]
                    : (entry.options ?? []),
            );
            const selected = flat.find((option) => option.data === value);
            return h(
                "label",
                { "data-dropdown": props.label },
                `${props.label}: ${selected ? String(selected.label) : String(value)}`,
            );
        },
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
        // Manage-models affordance + modal host stubs (in-app model cleanup):
        // DialogButton forwards disabled; showModal captures the opened node
        // (the manage modal's internals are covered by ManageModels.test.tsx).
        DialogButton: (props: { onClick?: () => void; disabled?: boolean; children?: Children }) =>
            h(
                "button",
                { onClick: props.onClick, disabled: props.disabled === true },
                props.children,
            ),
        ConfirmModal: (props: Record<string, unknown> & { children?: Children }) =>
            h("div", { "data-confirm": "true" }, props.children),
        showModal: (node: Children) => {
            showModalNodes.push(node);
            return { Close: () => undefined, Update: () => undefined };
        },
        __showModalNodes: showModalNodes,
    };
});

afterEach(cleanup);

// The test-only export from the mock (typed through the module shape).
const deckyUi = await import("@decky/ui");
const showModalNodes = (deckyUi as unknown as { __showModalNodes: ReactNode[] }).__showModalNodes;

function fakeDiagnostics(): DiagnosticsSource {
    return {
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

/** Timeless clock for call sites that never reach the load deadline. */
function stubClock(): ClockPort {
    return { nowMonotonicMs: () => 0 };
}

/** Controllable monotonic clock for the load-deadline tests. */
function fakeClock(): { clock: ClockPort; elapse: (ms: number) => void } {
    let now = 0;
    return {
        clock: { nowMonotonicMs: () => now },
        elapse: (ms: number) => {
            now += ms;
        },
    };
}

/**
 * Settings port whose load() hands the resolver to the test: the load stays
 * pending until `resolveLoad` fires, and the call count proves Retry really
 * restarted the load.
 */
function gatedSettingsPort(): {
    port: SettingsPort;
    resolveLoad: (value: PluginSettings) => void;
    loadCalls: () => number;
} {
    const resolvers: Array<(value: PluginSettings) => void> = [];
    let calls = 0;
    return {
        port: {
            load: () =>
                new Promise<PluginSettings>((resolve) => {
                    calls += 1;
                    resolvers.push(resolve);
                }),
            save: async () => undefined,
        },
        // The newest resolver is the live load: after a Retry the first
        // attempt's promise is already cancelled, so FIFO would resolve a
        // dead promise and the panel would wait forever.
        resolveLoad: (value: PluginSettings) => resolvers.pop()?.(value),
        loadCalls: () => calls,
    };
}

describe("SettingsPanel", () => {
    it("mounts and renders the decluttered sections without throwing (review finding)", async () => {
        const { container } = render(
            <SettingsPanel
                settings={new FakeSettingsPort()}
                store={new FakeStateStore({ kind: "booting" })}
                setupProgress={fakeSetupStore()}
                diagnostics={fakeDiagnostics()}
                clock={stubClock()}
            />,
        );
        expect(container.querySelector('[data-panel-title="SpeechToDeck"]')).not.toBeNull();
        expect(screen.getByText("Loading settings…")).not.toBeNull();

        // Sections: runtime, speech, output. Kept rows only.
        expect(await screen.findByText(/Enable plugin/)).not.toBeNull();
        expect(screen.getAllByText(/Language/).length).toBeGreaterThan(0);
        expect(screen.getAllByText(/Output mode/).length).toBeGreaterThan(0);

        // Removed rows and the whole Diagnostics section stay gone (declutter
        // owner declutter; the Compute backend select followed later — owner
        // decision that the Vulkan/CPU choice is an internal concern, the
        // setting stays "auto" and is simply never rendered).
        expect(screen.queryByText(/Compute backend/)).toBeNull();
        expect(screen.queryByText(/Runtime health/)).toBeNull();
        expect(screen.queryByText(/Maximum recording duration/)).toBeNull();
        expect(screen.queryByText(/Voice activity detection/)).toBeNull();
        expect(screen.queryByText(/Steam keyboard detected/)).toBeNull();
        expect(container.querySelector('[data-panel-title="Diagnostics"]')).toBeNull();
    });

    // Rework: the Speech section reads Model → (conditional) Language.
    // The picker renders ONLY while the selected model does not pin a
    // language itself (unloaded catalog, unknown id, or general model); a
    // language-specific selection hides it. The persisted `language` value is
    // never rewritten.
    it("orders the Speech section Model → Language for a general catalog model", async () => {
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
            deleteModel: async () => undefined,
        };
        const { container } = render(
            <SettingsPanel
                settings={new FakeSettingsPort()}
                store={new FakeStateStore({ kind: "booting" })}
                setupProgress={fakeSetupStore()}
                diagnostics={fakeDiagnostics()}
                clock={stubClock()}
                modelCatalog={modelCatalog}
            />,
        );
        await screen.findByText(/Enable plugin/);

        const dropdowns = Array.from(container.querySelectorAll("[data-dropdown]")).map((node) =>
            node.getAttribute("data-dropdown"),
        );
        const languageIndex = dropdowns.indexOf("Language");
        const modelIndex = dropdowns.indexOf("Model");
        expect(modelIndex).toBeGreaterThanOrEqual(0);
        expect(languageIndex).toBeGreaterThan(modelIndex);
    });

    it("hides the Language picker while the selected model is language-specific", async () => {
        const store = new ModelCatalogStore();
        store.setModels([
            {
                id: "distil-small-en",
                engine: "whisper",
                multilingual: false,
                filename: "ggml-distil-small.en.bin",
                installed: true,
                languages: ["en"],
            },
        ]);
        const modelCatalog = {
            store,
            load: async () => undefined,
            download: () => undefined,
            cancel: () => undefined,
            deleteModel: async () => undefined,
        };
        const settings = new FakeSettingsPort();
        settings.value = { ...settings.value, modelId: "distil-small-en", language: "de" };
        const { container } = render(
            <SettingsPanel
                settings={settings}
                store={new FakeStateStore({ kind: "booting" })}
                setupProgress={fakeSetupStore()}
                diagnostics={fakeDiagnostics()}
                clock={stubClock()}
                modelCatalog={modelCatalog}
            />,
        );
        await screen.findByText(/Enable plugin/);

        expect(container.querySelector('[data-dropdown="Model"]')).not.toBeNull();
        expect(container.querySelector('[data-dropdown="Language"]')).toBeNull();
    });

    it("keeps the Language picker for an unknown model id and restores its prior value", async () => {
        // An older backend catalog without the persisted model id counts as
        // "not in the catalog": the picker stays, still bound to the
        // persisted language (never cleared).
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
            deleteModel: async () => undefined,
        };
        const settings = new FakeSettingsPort();
        settings.value = { ...settings.value, modelId: "unknown-legacy-model", language: "fr" };
        const { container } = render(
            <SettingsPanel
                settings={settings}
                store={new FakeStateStore({ kind: "booting" })}
                setupProgress={fakeSetupStore()}
                diagnostics={fakeDiagnostics()}
                clock={stubClock()}
                modelCatalog={modelCatalog}
            />,
        );
        await screen.findByText(/Enable plugin/);

        const language = container.querySelector('[data-dropdown="Language"]');
        expect(language).not.toBeNull();
        expect(language?.textContent).toContain("fr");
    });

    it("renders the Manage models affordance below the Model select and opens the manage modal", async () => {
        // In-app model cleanup (owner request): the affordance renders only
        // over a LOADED catalog and opens the modal through the production
        // openManageModelsModal path (its internals are covered by
        // ManageModels.test.tsx).
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
            deleteModel: async () => undefined,
        };
        const { container } = render(
            <SettingsPanel
                settings={new FakeSettingsPort()}
                store={new FakeStateStore({ kind: "booting" })}
                setupProgress={fakeSetupStore()}
                diagnostics={fakeDiagnostics()}
                clock={stubClock()}
                modelCatalog={modelCatalog}
            />,
        );
        await screen.findByText(/Enable plugin/);

        const manage = screen.getByRole("button", { name: "Manage models" });
        // Below the Model select, inside the Speech section.
        const speechSection = container.querySelector('[data-panel-title="Speech"]');
        expect(speechSection).not.toBeNull();
        expect(speechSection?.contains(manage)).toBe(true);
        const modelSelect = container.querySelector('[data-dropdown="Model"]');
        expect(modelSelect).not.toBeNull();
        expect(
            modelSelect!.compareDocumentPosition(manage) & Node.DOCUMENT_POSITION_FOLLOWING,
        ).toBeTruthy();

        fireEvent.click(manage);
        expect(showModalNodes).toHaveLength(1);
    });

    it("hides the Manage models affordance while the catalog is unavailable", async () => {
        const modelCatalog = {
            store: new ModelCatalogStore(), // never loaded: no models
            load: async () => undefined,
            download: () => undefined,
            cancel: () => undefined,
            deleteModel: async () => undefined,
        };
        render(
            <SettingsPanel
                settings={new FakeSettingsPort()}
                store={new FakeStateStore({ kind: "booting" })}
                setupProgress={fakeSetupStore()}
                diagnostics={fakeDiagnostics()}
                clock={stubClock()}
                modelCatalog={modelCatalog}
            />,
        );
        await screen.findByText(/Enable plugin/);

        expect(screen.queryByRole("button", { name: "Manage models" })).toBeNull();
    });

    it("rerenders the dictation card from controller-store state changes", async () => {
        const store = new FakeStateStore({ kind: "ready" });
        render(
            <SettingsPanel
                settings={new FakeSettingsPort()}
                store={store}
                setupProgress={fakeSetupStore()}
                diagnostics={fakeDiagnostics()}
                clock={stubClock()}
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

    it("renders the setup progress above the panel sections while setup is running", async () => {
        const setup = fakeSetupStore();
        const { container } = render(
            <SettingsPanel
                settings={new FakeSettingsPort()}
                store={new FakeStateStore({ kind: "booting" })}
                setupProgress={setup}
                diagnostics={fakeDiagnostics()}
                clock={stubClock()}
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
                clock={stubClock()}
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
                clock={stubClock()}
            />,
        );
        expect(await screen.findByText(/Enable plugin/)).not.toBeNull();
        expect(container.querySelector("[data-setup-progress]")).toBeNull();
    });

    it("wires the failed-state retry button to the restart_runtime callable", async () => {
        const transport = new FakeDeckyTransport();
        const backend = new DeckyBackendClient(transport);
        const diagnostics: DiagnosticsSource = {
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
                clock={stubClock()}
            />,
        );

        fireEvent.click(await screen.findByRole("button", { name: "Retry" }));

        expect(transport.calls.map((call) => call.route)).toEqual(["restart_runtime"]);
    });

    it("renders the hydrated failure from the status report without live events", async () => {
        // On-device finding: the setup failure fired before the panel
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
                    hydrateSetupProgress: () => adapter.hydrateSetupFromStatus(),
                    restartRuntime: async () => {
                        await backend.call("restart_runtime");
                    },
                }}
                clock={stubClock()}
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

// Load-timeout decision points (the eternal-spinner defect): the deadline is
// measured on the injected monotonic clock, the timer only wakes the check.
describe("SettingsPanel settings-load timeout", () => {
    afterEach(() => {
        cleanup();
        vi.useRealTimers();
    });

    function renderWithGate(gate: ReturnType<typeof gatedSettingsPort>, clock: ClockPort): void {
        render(
            <SettingsPanel
                settings={gate.port}
                store={new FakeStateStore({ kind: "booting" })}
                setupProgress={fakeSetupStore()}
                diagnostics={fakeDiagnostics()}
                clock={clock}
            />,
        );
    }

    it("leaves the loading state with message, hint, and Retry when the load outlives 10 s", async () => {
        vi.useFakeTimers();
        const gate = gatedSettingsPort();
        const { clock, elapse } = fakeClock();
        renderWithGate(gate, clock);
        expect(screen.getByText("Loading settings…")).not.toBeNull();

        await act(async () => {
            elapse(10_000);
            vi.advanceTimersByTime(10_000);
        });

        expect(screen.queryByText("Loading settings…")).toBeNull();
        expect(screen.getByText("Backend is not responding.")).not.toBeNull();
        expect(
            screen.getByText(
                "Close and reopen this panel. If it persists, reload the plugin and open it again.",
            ),
        ).not.toBeNull();
        expect(screen.getByRole("button", { name: "Retry" })).not.toBeNull();
    });

    it("restarts the load with a fresh deadline on Retry and clears the failed state", async () => {
        vi.useFakeTimers();
        const gate = gatedSettingsPort();
        const { clock, elapse } = fakeClock();
        renderWithGate(gate, clock);
        await act(async () => {
            elapse(10_000);
            vi.advanceTimersByTime(10_000);
        });
        expect(screen.getByText("Backend is not responding.")).not.toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Retry" }));

        expect(screen.queryByText("Backend is not responding.")).toBeNull();
        expect(screen.getByText("Loading settings…")).not.toBeNull();
        expect(gate.loadCalls()).toBe(2);

        await act(async () => {
            gate.resolveLoad({ ...TEST_SETTINGS });
        });
        expect(screen.getByText(/Enable plugin/)).not.toBeNull();
        expect(screen.queryByText("Backend is not responding.")).toBeNull();
    });

    it("renders the loaded panel when the load resolves before the deadline", async () => {
        vi.useFakeTimers();
        const gate = gatedSettingsPort();
        const { clock, elapse } = fakeClock();
        renderWithGate(gate, clock);
        await act(async () => {
            gate.resolveLoad({ ...TEST_SETTINGS });
        });
        expect(screen.getByText(/Enable plugin/)).not.toBeNull();

        // Well past the original deadline: the success retired the wakeup,
        // so the panel never flips into the failed state.
        await act(async () => {
            elapse(60_000);
            vi.advanceTimersByTime(60_000);
        });
        expect(screen.getByText(/Enable plugin/)).not.toBeNull();
        expect(screen.queryByText("Backend is not responding.")).toBeNull();
    });

    it("renders a late success normally when the load resolves after the timeout fired", async () => {
        // Pinned behavior: data arriving late wins over the failed state.
        vi.useFakeTimers();
        const gate = gatedSettingsPort();
        const { clock, elapse } = fakeClock();
        renderWithGate(gate, clock);
        await act(async () => {
            elapse(10_000);
            vi.advanceTimersByTime(10_000);
        });
        expect(screen.getByText("Backend is not responding.")).not.toBeNull();

        await act(async () => {
            gate.resolveLoad({ ...TEST_SETTINGS });
        });
        expect(screen.getByText(/Enable plugin/)).not.toBeNull();
        expect(screen.queryByText("Backend is not responding.")).toBeNull();
    });
});

// Self-heal decision points (install wedge): the panel reports each
// settled boot-load outcome to the optional port; two consecutive
// full-deadline timeouts are the wedged signature that arms the one-time
// loader reload (the hint then names it), a coded rejection never triggers
// it, and the loader's re-import broadcast re-arms the load while the panel
// sits in the failed state. The reload trigger/latch itself is covered by
// DeckySelfHeal.test.ts over the transport seam.
describe("SettingsPanel settings-load self-heal", () => {
    type LoadOutcome = "timeout" | "rejected" | "success";

    const GENERIC_HINT =
        "Close and reopen this panel. If it persists, reload the plugin and open it again.";

    afterEach(() => {
        cleanup();
        vi.useRealTimers();
    });

    function fakeSelfHeal(triggerOnSecondTimeout: boolean): {
        selfHeal: NonNullable<SettingsPanelProps["selfHeal"]>;
        reports: LoadOutcome[];
        importListeners: (() => void)[];
        emitImport: () => void;
    } {
        const reports: LoadOutcome[] = [];
        const importListeners: (() => void)[] = [];
        let timeoutStreak = 0;
        return {
            reports,
            importListeners,
            emitImport: () => {
                for (const listener of [...importListeners]) {
                    listener();
                }
            },
            selfHeal: {
                // Mirrors the adapter's streak semantics (the module latch
                // itself is covered by DeckySelfHeal.test.ts): the trigger
                // fires on the SECOND consecutive timeout report or never.
                reportLoadOutcome: (outcome) => {
                    reports.push(outcome);
                    if (outcome !== "timeout") {
                        timeoutStreak = 0;
                        return false;
                    }
                    timeoutStreak += 1;
                    return triggerOnSecondTimeout && timeoutStreak >= 2;
                },
                onImportPlugin: (listener) => {
                    importListeners.push(listener);
                    return () => {
                        const index = importListeners.indexOf(listener);
                        if (index >= 0) {
                            importListeners.splice(index, 1);
                        }
                    };
                },
            },
        };
    }

    function renderWithHeal(
        gate: ReturnType<typeof gatedSettingsPort>,
        clock: ClockPort,
        selfHeal: NonNullable<SettingsPanelProps["selfHeal"]>,
    ): void {
        render(
            <SettingsPanel
                settings={gate.port}
                store={new FakeStateStore({ kind: "booting" })}
                setupProgress={fakeSetupStore()}
                diagnostics={fakeDiagnostics()}
                clock={clock}
                selfHeal={selfHeal}
            />,
        );
    }

    it("fires the self-heal on the second consecutive timeout and names the reload", async () => {
        vi.useFakeTimers();
        const gate = gatedSettingsPort();
        const { clock, elapse } = fakeClock();
        const heal = fakeSelfHeal(true);
        renderWithHeal(gate, clock, heal.selfHeal);

        await act(async () => {
            elapse(10_000);
            vi.advanceTimersByTime(10_000);
        });
        // First full-deadline timeout: honest failed state, generic hint.
        expect(heal.reports).toEqual(["timeout"]);
        expect(screen.getByText("Backend is not responding.")).not.toBeNull();
        expect(screen.queryByText("Reloading the plugin backend …")).toBeNull();

        fireEvent.click(screen.getByRole("button", { name: "Retry" }));
        await act(async () => {
            elapse(10_000);
            vi.advanceTimersByTime(10_000);
        });

        expect(heal.reports).toEqual(["timeout", "timeout"]);
        expect(screen.getByText("Reloading the plugin backend …")).not.toBeNull();
        expect(screen.queryByText(GENERIC_HINT)).toBeNull();
        // Still the honest failed state with Retry — never a fake progress view.
        expect(screen.getByText("Backend is not responding.")).not.toBeNull();
        expect(screen.getByRole("button", { name: "Retry" })).not.toBeNull();
    });

    it("reports a coded rejection but never triggers the reload", async () => {
        const port: SettingsPort = {
            load: () => Promise.reject(new Error("backend says no")),
            save: async () => undefined,
        };
        const heal = fakeSelfHeal(true); // would fire on a second timeout report
        render(
            <SettingsPanel
                settings={port}
                store={new FakeStateStore({ kind: "booting" })}
                setupProgress={fakeSetupStore()}
                diagnostics={fakeDiagnostics()}
                clock={stubClock()}
                selfHeal={heal.selfHeal}
            />,
        );

        await act(async () => {
            await Promise.resolve();
            await Promise.resolve();
        });

        expect(screen.getByText("Backend is not responding.")).not.toBeNull();
        expect(heal.reports).toEqual(["rejected"]);
        expect(screen.queryByText("Reloading the plugin backend …")).toBeNull();
    });

    it("re-arms the boot load when the loader re-import fires during the failed state", async () => {
        vi.useFakeTimers();
        const gate = gatedSettingsPort();
        const { clock, elapse } = fakeClock();
        const heal = fakeSelfHeal(false);
        renderWithHeal(gate, clock, heal.selfHeal);

        await act(async () => {
            elapse(10_000);
            vi.advanceTimersByTime(10_000);
        });
        expect(screen.getByText("Backend is not responding.")).not.toBeNull();
        expect(gate.loadCalls()).toBe(1);

        act(() => {
            heal.emitImport();
        });

        // Fresh backend is up: the failed state cleared and the load restarts.
        expect(screen.queryByText("Backend is not responding.")).toBeNull();
        expect(screen.getByText("Loading settings…")).not.toBeNull();
        expect(gate.loadCalls()).toBe(2);

        await act(async () => {
            gate.resolveLoad({ ...TEST_SETTINGS });
        });
        expect(screen.getByText(/Enable plugin/)).not.toBeNull();
        expect(heal.reports).toEqual(["timeout", "success"]);

        // Outside a failure the re-import subscription is gone: no restart.
        act(() => {
            heal.emitImport();
        });
        expect(gate.loadCalls()).toBe(2);
    });
});

/**
 * Visual-harness entry (spec §19/§20/§80/§107 acceptance surface).
 *
 * Mounts the REAL presentation components — SettingsPanel and
 * MicrophoneButton — with the repository's existing fakes
 * (FakeSettingsPort, FakeStateStore) and realistic capability reports, on
 * a plain HTML page sized like the Deck QAM plugin column (~410px). The
 * `@decky/ui` primitives are resolved from the `DeckyUI` global exactly as
 * in the packaged plugin; outside Steam the committed stand-in
 * (decky-ui-standin.js) provides that global with the Deck visual language.
 *
 * Cases are selected via query parameters (`case`, `locale`, `state`,
 * `scroll`). The same mount function is exercised by the jsdom smoke test
 * (harness.test.tsx) for every captured state.
 */

import * as React from "react";
import { createRoot } from "react-dom/client";
import { SettingsPanel } from "../../src/presentation/settings/SettingsPanel";
import { MicrophoneButton } from "../../src/presentation/keyboard/MicrophoneButton";
import { translateError } from "../../src/presentation/i18n/messages";
import type { Locale } from "../../src/presentation/i18n/messages";
import { DictationError } from "../../src/domain/DictationError";
import type { DictationState } from "../../src/domain/DictationState";
import type { DiagnosticsSource } from "../../src/presentation/settings/DiagnosticsPanel";
import type { KeyboardCapabilityReport } from "../../src/domain/Capability";
import type { SpeechCapabilities } from "../../src/application/ports/SpeechPort";
import type {
    SetupProgressSnapshot,
    SetupProgressStore,
} from "../../src/application/ports/SetupProgressPort";
import { DeckyBackendClient } from "../../src/infrastructure/decky/DeckyBackendClient";
import { DeckySpeechAdapter } from "../../src/infrastructure/decky/DeckySpeechAdapter";
import { FakeSettingsPort } from "../../tests/frontend/fakes/FakeSettingsPort";
import {
    FAILED_GET_STATUS_REPORT,
    SETUP_SNAPSHOTS,
    FakeDeckyTransport,
    FakeSnapshotStore,
    FakeStateStore,
} from "../../tests/contract/helpers";

export type HarnessCaseId = "panel" | "mic" | "setup";

/** Which `setup_progress` snapshot the setup case mounts (REAL component). */
export type HarnessSetupVariant = keyof typeof SETUP_SNAPSHOTS | "hydrated-failed" | "none";

export interface HarnessParams {
    readonly caseId: HarnessCaseId;
    readonly locale: Locale;
    /** Store state for the panel case: `ready` | `recording` | `error`. */
    readonly stateKind: "ready" | "recording" | "error";
    /** Setup snapshot for the setup case. */
    readonly setup: HarnessSetupVariant;
    /** Optional `data-panel-title` of the section to scroll into view. */
    readonly scroll: string | null;
}

/** Every captured state; the smoke test mounts exactly these. */
export const CAPTURED_CASES: readonly HarnessParams[] = [
    { caseId: "panel", locale: "en", stateKind: "ready", setup: "none", scroll: null },
    { caseId: "panel", locale: "de", stateKind: "ready", setup: "none", scroll: null },
    { caseId: "panel", locale: "en", stateKind: "recording", setup: "none", scroll: null },
    { caseId: "mic", locale: "en", stateKind: "ready", setup: "none", scroll: null },
    { caseId: "mic", locale: "de", stateKind: "ready", setup: "none", scroll: null },
    // Setup progress: real panel with the dedicated store preset per state.
    { caseId: "setup", locale: "en", stateKind: "ready", setup: "indeterminate", scroll: null },
    { caseId: "setup", locale: "en", stateKind: "ready", setup: "download", scroll: null },
    { caseId: "setup", locale: "en", stateKind: "ready", setup: "failed", scroll: null },
    { caseId: "setup", locale: "de", stateKind: "ready", setup: "failed", scroll: null },
    { caseId: "setup", locale: "en", stateKind: "ready", setup: "ready", scroll: null },
    // Hydrated failure: no live event at all — the panel shows the failed
    // state because the real adapter rebuilt it from the §30 status report.
    { caseId: "setup", locale: "en", stateKind: "ready", setup: "hydrated-failed", scroll: null },
];

const REPORT: KeyboardCapabilityReport = {
    windowReachable: true,
    managerRecognizable: true,
    keyboardSignatureSupported: true,
    clipboardUsable: true,
    nativePasteRecognized: true,
    supported: true,
    profileId: "steam-vk-semantic-v1",
};

const SPEECH: SpeechCapabilities = {
    speechRuntimeAvailable: true,
    microphoneAvailable: true,
    cpuAvailable: true,
    vulkanAvailable: true,
    modelInstalled: true,
};

function fakeDiagnostics(): DiagnosticsSource {
    return {
        loadCapabilityReport: async () => REPORT,
        loadSpeechCapabilities: async () => SPEECH,
        hydrateSetupProgress: async () => undefined,
        restartRuntime: async () => undefined,
    };
}

/**
 * The real hydration chain for the `hydrated-failed` case: a REAL adapter
 * over a transport seeded with the failed §30 status report. The panel
 * mounts with an empty setup store and reconstructs the failed state through
 * the production `hydrateSetupFromStatus` path — no live event involved.
 */
function hydratedFailureCase(): {
    store: SetupProgressStore;
    diagnostics: DiagnosticsSource;
} {
    const transport = new FakeDeckyTransport();
    transport.callResponses.set("get_status", FAILED_GET_STATUS_REPORT);
    const adapter = new DeckySpeechAdapter(new DeckyBackendClient(transport));
    adapter.subscribe(() => undefined); // arm the backend event subscriptions
    return {
        store: adapter.setupProgress,
        diagnostics: {
            loadCapabilityReport: async () => REPORT,
            loadSpeechCapabilities: async () => SPEECH,
            hydrateSetupProgress: () => adapter.hydrateSetupFromStatus(),
            restartRuntime: async () => undefined,
        },
    };
}

function fakeState(stateKind: HarnessParams["stateKind"]): DictationState {
    switch (stateKind) {
        case "ready":
            return { kind: "ready" };
        case "recording":
            return {
                kind: "recording",
                session: {
                    sessionId: "harness-1",
                    keyboardContextId: "ctx-1",
                    startedAtMonotonicMs: performance.now() - 83_000,
                },
            };
        case "error":
            return {
                kind: "error",
                error: new DictationError("TRANSCRIPTION_FAILED"),
                recoverable: true,
            };
    }
}

function PanelCase({
    locale,
    stateKind,
    setup,
}: {
    locale: Locale;
    stateKind: HarnessParams["stateKind"];
    setup: HarnessSetupVariant;
}) {
    const hydration = setup === "hydrated-failed" ? hydratedFailureCase() : null;
    const setupSnapshot: SetupProgressSnapshot | null =
        setup === "none" || setup === "hydrated-failed" ? null : SETUP_SNAPSHOTS[setup];
    return (
        <SettingsPanel
            settings={new FakeSettingsPort()}
            store={new FakeStateStore(fakeState(stateKind))}
            setupProgress={
                hydration
                    ? hydration.store
                    : new FakeSnapshotStore<SetupProgressSnapshot | null>(setupSnapshot)
            }
            diagnostics={hydration ? hydration.diagnostics : fakeDiagnostics()}
            locale={locale}
        />
    );
}

function MicCase({ locale }: { locale: Locale }): React.ReactElement {
    const message = translateError(locale, "TRANSCRIPTION_FAILED");
    const noop = (): void => undefined;
    return (
        <div className="mic-row">
            <figure>
                <MicrophoneButton state="ready" disabled={false} onPress={noop} locale={locale} />
                <figcaption>ready</figcaption>
            </figure>
            <figure>
                <MicrophoneButton
                    state="recording"
                    disabled={false}
                    onPress={noop}
                    locale={locale}
                    elapsedLabel="01:23"
                />
                <figcaption>recording</figcaption>
            </figure>
            <figure>
                <MicrophoneButton
                    state="processing"
                    disabled={true}
                    onPress={noop}
                    locale={locale}
                />
                <figcaption>processing</figcaption>
            </figure>
            <figure>
                <MicrophoneButton
                    state="error"
                    disabled={true}
                    onPress={noop}
                    locale={locale}
                    errorMessage={message}
                />
                <figcaption>error</figcaption>
            </figure>
        </div>
    );
}

function Harness({ params }: { params: HarnessParams }): React.ReactElement {
    return params.caseId === "mic" ? (
        <MicCase locale={params.locale} />
    ) : (
        <PanelCase locale={params.locale} stateKind={params.stateKind} setup={params.setup} />
    );
}

/** Mounts one captured state; returns the disposer. Shared with the smoke test. */
export function mountVisualHarness(container: HTMLElement, params: HarnessParams): () => void {
    const root = createRoot(container);
    root.render(<Harness params={params} />);
    return () => root.unmount();
}

const SETUP_VARIANTS: readonly HarnessSetupVariant[] = [
    "download",
    "indeterminate",
    "failed",
    "ready",
    "hydrated-failed",
];

function paramsFromLocation(): HarnessParams {
    const search = new URLSearchParams(window.location.search);
    const rawCase = search.get("case");
    const caseId: HarnessCaseId =
        rawCase === "mic" ? "mic" : rawCase === "setup" ? "setup" : "panel";
    const locale: Locale = search.get("locale") === "de" ? "de" : "en";
    const state = search.get("state");
    const variant = search.get("variant");
    const setup: HarnessSetupVariant = SETUP_VARIANTS.includes(variant as HarnessSetupVariant)
        ? (variant as HarnessSetupVariant)
        : "none";
    return {
        caseId,
        locale,
        stateKind: state === "recording" || state === "error" ? state : "ready",
        setup,
        scroll: search.get("scroll"),
    };
}

// Browser auto-mount: only on the harness page itself (jsdom smoke calls
// mountVisualHarness directly and has no #visual-root + ?case URL).
const visualRoot = typeof document !== "undefined" ? document.getElementById("visual-root") : null;
if (
    visualRoot !== null &&
    typeof window !== "undefined" &&
    window.location.search.includes("case=")
) {
    const params = paramsFromLocation();
    mountVisualHarness(visualRoot, params);
    const settle = (): void => {
        // Numeric capture geometry for the driver: the page stays
        // unscrolled and the capture driver screenshots the full window and
        // crops the target region — headless Chromium maps window pixels
        // 1:1 onto the page from its origin, but does not reliably honor
        // page-side scroll offsets (the old scrollIntoView targeting
        // captured the wrong region for section shots).
        const doc = document.documentElement;
        visualRoot.dataset.overflowX = doc.scrollWidth > doc.clientWidth ? "true" : "false";
        const sections = Array.from(
            document.querySelectorAll<HTMLElement>(".decky-panel-section"),
        ).map((section) => {
            const rect = section.getBoundingClientRect();
            return {
                title: section.dataset.panelTitle ?? "",
                top: Math.round(rect.top + window.scrollY),
                height: Math.round(rect.height),
            };
        });
        visualRoot.dataset.geometry = JSON.stringify({
            docH: doc.scrollHeight,
            rootX: Math.round(visualRoot.getBoundingClientRect().left + window.scrollX),
            sections,
        });
    };
    window.requestAnimationFrame(settle);
    // Fallback for capture drivers whose virtual clock does not run rAF.
    window.setTimeout(settle, 300);
}

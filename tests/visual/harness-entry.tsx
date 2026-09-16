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
import { FakeSettingsPort } from "../../tests/frontend/fakes/FakeSettingsPort";
import { FakeStateStore } from "../../tests/contract/helpers";

export type HarnessCaseId = "panel" | "mic";

export interface HarnessParams {
    readonly caseId: HarnessCaseId;
    readonly locale: Locale;
    /** Store state for the panel case: `ready` | `recording` | `error`. */
    readonly stateKind: "ready" | "recording" | "error";
    /** Optional `data-panel-title` of the section to scroll into view. */
    readonly scroll: string | null;
}

/** Every captured state; the smoke test mounts exactly these. */
export const CAPTURED_CASES: readonly HarnessParams[] = [
    { caseId: "panel", locale: "en", stateKind: "ready", scroll: null },
    { caseId: "panel", locale: "de", stateKind: "ready", scroll: null },
    { caseId: "panel", locale: "en", stateKind: "recording", scroll: null },
    { caseId: "mic", locale: "en", stateKind: "ready", scroll: null },
    { caseId: "mic", locale: "de", stateKind: "ready", scroll: null },
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
        restartRuntime: async () => undefined,
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
}: {
    locale: Locale;
    stateKind: HarnessParams["stateKind"];
}) {
    return (
        <SettingsPanel
            settings={new FakeSettingsPort()}
            store={new FakeStateStore(fakeState(stateKind))}
            diagnostics={fakeDiagnostics()}
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
    return params.caseId === "panel" ? (
        <PanelCase locale={params.locale} stateKind={params.stateKind} />
    ) : (
        <MicCase locale={params.locale} />
    );
}

/** Mounts one captured state; returns the disposer. Shared with the smoke test. */
export function mountVisualHarness(container: HTMLElement, params: HarnessParams): () => void {
    const root = createRoot(container);
    root.render(<Harness params={params} />);
    return () => root.unmount();
}

function paramsFromLocation(): HarnessParams {
    const search = new URLSearchParams(window.location.search);
    const caseId = search.get("case") === "mic" ? "mic" : "panel";
    const locale: Locale = search.get("locale") === "de" ? "de" : "en";
    const state = search.get("state");
    return {
        caseId,
        locale,
        stateKind: state === "recording" || state === "error" ? state : "ready",
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

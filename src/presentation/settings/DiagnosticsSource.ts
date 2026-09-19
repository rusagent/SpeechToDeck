/**
 * DiagnosticsSource — the panel's data-source seam wired by the composition
 * root (no Decky/Steam imports).
 *
 * v0.2.5: the read-only Diagnostics section was removed from the panel
 * (owner declutter), so the capability loaders below are no longer consumed
 * by the panel itself; the seam keeps them (they are wired by the
 * composition root for the keyboard-mount/capability surface) while the
 * panel consumes only the setup-progress hydration and the explicit runtime
 * restart behind the setup retry button.
 */

import type { KeyboardCapabilityReport } from "../../domain/Capability";
import type {
    CdpDiagnosticsReport,
    DictationFlowReport,
    SpeechCapabilities,
} from "../../application/ports/SpeechPort";
import type {
    KeyboardHostDiagnostics,
    TabBridgeDiagnostics,
} from "../../application/ports/KeyboardHostPort";

export interface DiagnosticsSource {
    loadCapabilityReport(): Promise<KeyboardCapabilityReport | null>;
    loadSpeechCapabilities(): Promise<SpeechCapabilities | null>;
    /**
     * Optional since v0.1.6: the cross-view diagnostics rows render unknown
     * when the composition does not provide them (§99 additive surface).
     */
    loadCdpDiagnostics?(): Promise<CdpDiagnosticsReport | null>;
    loadKeyboardHookDiagnostics?(): Promise<KeyboardHostDiagnostics | null>;
    /**
     * Optional since v0.1.7: observed tab-bridge facts (injected / keyboard
     * seen / press channel live) from the bridge's own state (§99).
     */
    loadTabBridgeDiagnostics?(): Promise<TabBridgeDiagnostics | null>;
    /**
     * Optional since v0.2: backend running state plus the active clipboard
     * backend for the "Dictation flow" row (§99 additive surface).
     */
    loadDictationFlowDiagnostics?(): Promise<DictationFlowReport | null>;
    /**
     * Hydrates the setup store from the §30 status report so a startup
     * failure that fired before the panel subscribed still renders (live
     * events always win). No-op when the runtime is fine or a snapshot
     * already exists.
     */
    hydrateSetupProgress(): Promise<void>;
    restartRuntime(): Promise<void>;
}

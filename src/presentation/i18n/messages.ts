/**
 * Translation dictionaries (spec §108).
 *
 * Every user-visible frontend string lives here — no strings buried in
 * components, adapters or services. English and German are complete; the
 * `Record<MessageKey, string>` shape makes the compiler reject a locale that
 * misses a key, so additional languages can be added without code changes
 * elsewhere. UI text for errors is mapped from stable §68 codes only —
 * frontend logic never parses exception strings (§68).
 */

import type { DictationErrorCode } from "../../domain/DictationError";
import type { DictationState } from "../../domain/DictationState";
import type { SpeechRuntimeStatus } from "../../application/ports/SpeechPort";
import type { UnavailableReason } from "../../domain/DictationState";

export type Locale = "en" | "de";

export const EN_MESSAGES = {
    "panel.title": "SpeechToDeck",

    "section.runtime": "Runtime",
    "section.speech": "Speech",
    "section.output": "Output",
    "section.diagnostics": "Diagnostics",
    "section.dictation": "Dictation",

    "setting.enabled": "Enable plugin",
    "setting.computeBackend": "Compute backend",
    "setting.runtimeHealth": "Runtime health",
    "setting.model": "Model",
    "setting.language": "Language",
    "setting.microphone": "Microphone",
    "setting.maxDuration": "Maximum recording duration (seconds)",
    "setting.vad": "Voice activity detection",
    "setting.outputMode": "Output mode",
    "setting.loading": "Loading settings…",
    "setting.saveFailed": "Saving settings failed. The change was not persisted.",

    "option.backend.auto": "Auto (Vulkan if available)",
    "option.backend.vulkan": "Vulkan",
    "option.backend.cpu": "CPU",
    "option.model.tiny": "Tiny (fastest)",
    "option.model.base": "Base (default)",
    "option.model.small": "Small (most accurate)",
    "option.language.system": "System language",
    "option.language.auto": "Auto-detect",
    "option.output.direct-insert": "Direct insert",
    "option.output.clipboard-only": "Clipboard only",

    "hint.backend.auto": "Checks for Vulkan and uses the CPU when Vulkan is unavailable.",
    "hint.backend.vulkan":
        "Vulkan is required. If it fails, an error is shown — no silent switch to CPU.",
    "hint.backend.cpu": "Uses the CPU only.",
    "hint.model.installed": "Model is installed and ready.",
    "hint.model.notInstalled":
        "Model is not installed. Dictation stays unavailable until it is downloaded.",
    "hint.model.unknown": "Installation status is not known yet.",
    "hint.language.system": "Uses the Steam interface language.",
    "hint.language.auto": "Detects the spoken language automatically.",
    "hint.language.explicit": "Transcriptions are made in this language.",

    "common.available": "Available",
    "common.unavailable": "Unavailable",
    "common.unknown": "Unknown",
    "common.none": "None",

    "runtime.status.starting": "Starting",
    "runtime.status.ready": "Ready",
    "runtime.status.unavailable": "Unavailable",
    "runtime.status.crashed": "Crashed",

    "runtime.health.booting": "Starting…",
    "runtime.health.unavailable": "Unavailable",
    "runtime.health.ready": "Ready",
    "runtime.health.starting": "Starting recording…",
    "runtime.health.recording": "Recording",
    "runtime.health.stopping": "Stopping…",
    "runtime.health.transcribing": "Transcribing…",
    "runtime.health.inserting": "Inserting…",
    "runtime.health.error": "Error",

    "unavailable.PLUGIN_DISABLED": "Plugin is disabled in the settings.",
    "unavailable.KEYBOARD_HOOK_UNAVAILABLE":
        "Steam keyboard integration is unavailable on this Steam build.",
    "unavailable.SPEECH_RUNTIME_UNAVAILABLE": "The speech runtime could not be started.",
    "unavailable.MICROPHONE_UNAVAILABLE": "No microphone is available.",
    "unavailable.MODEL_NOT_INSTALLED": "The selected model is not installed.",
    "unavailable.SETTINGS_LOAD_FAILED": "Settings could not be loaded.",

    "diagnostics.keyboardDetected": "Steam keyboard detected",
    "diagnostics.pasteCapability": "Paste capability",
    "diagnostics.clipboardCapability": "Clipboard capability",
    "diagnostics.cdpDiagnostics": "CDP cross-view diagnostics",
    "diagnostics.tabBridge": "Tab bridge",
    "diagnostics.tabBridgeInjected": "Tab bridge injected",
    "diagnostics.tabBridgeKeyboardSeen": "Keyboard view seen",
    "diagnostics.tabBridgePressChannel": "Press channel live",
    "diagnostics.runtimeStatus": "Runtime status",
    "diagnostics.model": "Model",
    "diagnostics.computeBackend": "Compute backend",
    "diagnostics.lastError": "Last runtime error",
    "diagnostics.restartRuntime": "Restart runtime",
    "diagnostics.dictationFlow": "Dictation flow",
    "diagnostics.dictationFlow.running": "backend running",
    "diagnostics.dictationFlow.stopped": "backend stopped",
    "diagnostics.dictationFlow.xclip": "system clipboard writer ready",
    "diagnostics.dictationFlow.clipboardUnavailable": "copying via the panel button",

    "degrade.not-probed": "Diagnostics have not run yet.",
    "degrade.remote-cdp-disabled":
        "Optional: enable “Allow Remote CEF Debugging” in the Decky settings for cross-view diagnostics.",
    "degrade.sp-target-not-found": "The main Steam UI view was not found.",
    "degrade.bridge-not-injected": "The keyboard bridge is not installed in the Steam view yet.",
    "degrade.probe-failed": "The diagnostics probe failed.",
    "degrade.registry-not-found": "The Steam window registry was not found.",
    "degrade.manager-not-found":
        "No keyboard manager is registered right now; it appears while the keyboard is in use.",
    "degrade.signature-not-found": "The keyboard signature was not found in any reachable view.",
    "degrade.unknown": "Currently unavailable.",

    "setup.title": "Setup in progress…",
    "setup.step.runtimeVerify": "Verify runtime",
    "setup.step.modelEnsure": "Model",
    "setup.step.daemonStart": "Start daemon",
    "setup.step.modelWarmup": "Load model",
    "setup.state.ready": "Ready",
    "setup.state.failed": "Failed",
    "setup.detail.checksum": "Verifying checksum…",
    "setup.detail.downloading": "Downloading…",
    "setup.detail.verifying": "Verifying…",
    "setup.detail.spawning": "Starting daemon…",
    "setup.detail.warmup": "Loading model into memory…",
    "setup.retry": "Retry",
    "setup.errorPrefix": "Setup failed",
    "setup.errorUnknown": "An unexpected setup error occurred.",

    "mic.label.ready": "Start voice input",
    "mic.label.recording": "Recording — press to stop",
    "mic.label.processing": "Processing…",
    "mic.label.error": "Voice input error — details in the plugin panel",

    "dictation.level.label": "Live microphone level",
    "dictation.level.style": "Visualizer",
    "dictation.level.style.heatmap": "Magma heat",
    "dictation.level.style.classic": "Classic bars",
    "dictation.level.style.mirror": "Mirror",
    "dictation.transcript.label": "Transcript",
    "dictation.clipboard.copied": "Copied — open the Steam keyboard (STEAM+X) and press Paste.",
    "dictation.clipboard.failed": "Copying failed — use “Copy again”.",
    "dictation.copyAgain": "Copy again",
    "dictation.copying": "Copying…",
} as const;

export type MessageKey = keyof typeof EN_MESSAGES;

export const DE_MESSAGES: Record<MessageKey, string> = {
    // Brand name: identical across locales (EN/DE parity).
    "panel.title": "SpeechToDeck",

    "section.runtime": "Laufzeit",
    "section.speech": "Spracherkennung",
    "section.output": "Ausgabe",
    "section.diagnostics": "Diagnose",
    "section.dictation": "Diktieren",

    "setting.enabled": "Plugin aktivieren",
    "setting.computeBackend": "Recheneinheit",
    "setting.runtimeHealth": "Laufzeitstatus",
    "setting.model": "Modell",
    "setting.language": "Sprache",
    "setting.microphone": "Mikrofon",
    "setting.maxDuration": "Maximale Aufnahmedauer (Sekunden)",
    "setting.vad": "Sprachaktivitätserkennung",
    "setting.outputMode": "Ausgabemodus",
    "setting.loading": "Einstellungen werden geladen…",
    "setting.saveFailed":
        "Speichern der Einstellungen fehlgeschlagen. Die Änderung wurde nicht übernommen.",

    "option.backend.auto": "Automatisch (Vulkan, falls verfügbar)",
    "option.backend.vulkan": "Vulkan",
    "option.backend.cpu": "CPU",
    "option.model.tiny": "Tiny (am schnellsten)",
    "option.model.base": "Base (Standard)",
    "option.model.small": "Small (am genauesten)",
    "option.language.system": "Systemsprache",
    "option.language.auto": "Automatisch erkennen",
    "option.output.direct-insert": "Direkt einfügen",
    "option.output.clipboard-only": "Nur Zwischenablage",

    "hint.backend.auto": "Prüft Vulkan und nutzt die CPU, wenn Vulkan nicht verfügbar ist.",
    "hint.backend.vulkan":
        "Vulkan ist erforderlich. Schlägt es fehl, wird ein Fehler angezeigt — kein stiller Wechsel zu CPU.",
    "hint.backend.cpu": "Nutzt nur die CPU.",
    "hint.model.installed": "Modell ist installiert und bereit.",
    "hint.model.notInstalled":
        "Modell ist nicht installiert. Spracheingabe bleibt unverfügbar, bis es geladen wurde.",
    "hint.model.unknown": "Der Installationsstatus ist noch nicht bekannt.",
    "hint.language.system": "Nutzt die Sprache der Steam-Oberfläche.",
    "hint.language.auto": "Erkennt die gesprochene Sprache automatisch.",
    "hint.language.explicit": "Transkriptionen werden in dieser Sprache erstellt.",

    "common.available": "Verfügbar",
    "common.unavailable": "Nicht verfügbar",
    "common.unknown": "Unbekannt",
    "common.none": "Keine",

    "runtime.status.starting": "Startet",
    "runtime.status.ready": "Bereit",
    "runtime.status.unavailable": "Nicht verfügbar",
    "runtime.status.crashed": "Abgestürzt",

    "runtime.health.booting": "Startet…",
    "runtime.health.unavailable": "Nicht verfügbar",
    "runtime.health.ready": "Bereit",
    "runtime.health.starting": "Aufnahme wird gestartet…",
    "runtime.health.recording": "Aufnahme läuft",
    "runtime.health.stopping": "Wird beendet…",
    "runtime.health.transcribing": "Transkribiere…",
    "runtime.health.inserting": "Einfügen…",
    "runtime.health.error": "Fehler",

    "unavailable.PLUGIN_DISABLED": "Plugin ist in den Einstellungen deaktiviert.",
    "unavailable.KEYBOARD_HOOK_UNAVAILABLE":
        "Die Steam-Tastatur-Integration ist für diesen Steam-Build nicht verfügbar.",
    "unavailable.SPEECH_RUNTIME_UNAVAILABLE": "Die Spracherkennung konnte nicht gestartet werden.",
    "unavailable.MICROPHONE_UNAVAILABLE": "Kein Mikrofon verfügbar.",
    "unavailable.MODEL_NOT_INSTALLED": "Das ausgewählte Modell ist nicht installiert.",
    "unavailable.SETTINGS_LOAD_FAILED": "Einstellungen konnten nicht geladen werden.",

    "diagnostics.keyboardDetected": "Steam-Tastatur erkannt",
    "diagnostics.pasteCapability": "Einfügen-Fähigkeit",
    "diagnostics.clipboardCapability": "Zwischenablage-Fähigkeit",
    "diagnostics.cdpDiagnostics": "CDP-übergreifende Diagnose",
    "diagnostics.tabBridge": "Tab-Brücke",
    "diagnostics.tabBridgeInjected": "Tab-Brücke injiziert",
    "diagnostics.tabBridgeKeyboardSeen": "Tastaturansicht gesehen",
    "diagnostics.tabBridgePressChannel": "Druckkanal aktiv",
    "diagnostics.runtimeStatus": "Laufzeitstatus",
    "diagnostics.model": "Modell",
    "diagnostics.computeBackend": "Recheneinheit",
    "diagnostics.lastError": "Letzter Laufzeitfehler",
    "diagnostics.restartRuntime": "Laufzeit neu starten",
    "diagnostics.dictationFlow": "Diktier-Ablauf",
    "diagnostics.dictationFlow.running": "Backend läuft",
    "diagnostics.dictationFlow.stopped": "Backend gestoppt",
    "diagnostics.dictationFlow.xclip": "System-Zwischenablage bereit",
    "diagnostics.dictationFlow.clipboardUnavailable": "Kopieren über den Panel-Knopf",

    "degrade.not-probed": "Diagnose wurde noch nicht ausgeführt.",
    "degrade.remote-cdp-disabled":
        "Optional: Aktiviere „Allow Remote CEF Debugging“ in den Decky-Einstellungen für übergreifende Diagnose.",
    "degrade.sp-target-not-found": "Die Steam-Hauptansicht wurde nicht gefunden.",
    "degrade.bridge-not-injected":
        "Die Tastatur-Brücke ist noch nicht in der Steam-Ansicht installiert.",
    "degrade.probe-failed": "Die Diagnoseabfrage ist fehlgeschlagen.",
    "degrade.registry-not-found": "Die Steam-Fensterregistrierung wurde nicht gefunden.",
    "degrade.manager-not-found":
        "Derzeit ist kein Tastatur-Manager registriert; er erscheint bei Benutzung der Tastatur.",
    "degrade.signature-not-found":
        "Das Tastatur-Signaturmerkmal wurde in keiner erreichbaren Ansicht gefunden.",
    "degrade.unknown": "Derzeit nicht verfügbar.",

    "setup.title": "Setup läuft…",
    "setup.step.runtimeVerify": "Runtime verifizieren",
    "setup.step.modelEnsure": "Modell",
    "setup.step.daemonStart": "Daemon starten",
    "setup.step.modelWarmup": "Modell laden",
    "setup.state.ready": "Bereit",
    "setup.state.failed": "Fehlgeschlagen",
    "setup.detail.checksum": "Prüfsumme wird geprüft…",
    "setup.detail.downloading": "Wird heruntergeladen…",
    "setup.detail.verifying": "Wird verifiziert…",
    "setup.detail.spawning": "Daemon wird gestartet…",
    "setup.detail.warmup": "Modell wird geladen…",
    "setup.retry": "Erneut versuchen",
    "setup.errorPrefix": "Setup fehlgeschlagen",
    "setup.errorUnknown": "Es ist ein unerwarteter Setup-Fehler aufgetreten.",

    "mic.label.ready": "Spracheingabe starten",
    "mic.label.recording": "Aufnahme läuft — zum Beenden drücken",
    "mic.label.processing": "Verarbeitung…",
    "mic.label.error": "Fehler bei der Spracheingabe — Details im Plugin-Panel",

    "dictation.level.label": "Live-Mikrofonpegel",
    "dictation.level.style": "Darstellung",
    "dictation.level.style.heatmap": "Magma-Hitze",
    "dictation.level.style.classic": "Klassische Balken",
    "dictation.level.style.mirror": "Spiegel",
    "dictation.transcript.label": "Transkript",
    "dictation.clipboard.copied":
        "Kopiert — öffne die Steam-Tastatur (STEAM+X) und drücke Einfügen.",
    "dictation.clipboard.failed": "Kopieren fehlgeschlagen — benutze „Erneut kopieren“.",
    "dictation.copyAgain": "Erneut kopieren",
    "dictation.copying": "Kopieren…",
} as const;

export const MESSAGES: Record<Locale, Record<MessageKey, string>> = {
    en: EN_MESSAGES,
    de: DE_MESSAGES,
};

/** Error-code → UI text mapping (§68). Complete over all stable codes. */
export const ERROR_MESSAGES: Record<Locale, Record<DictationErrorCode, string>> = {
    en: {
        STEAM_KEYBOARD_NOT_FOUND: "Steam keyboard not found.",
        STEAM_PROFILE_UNSUPPORTED: "This Steam keyboard layout is not supported yet.",
        PASTE_ACTION_UNAVAILABLE: "Direct paste is unavailable on this keyboard.",
        CLIPBOARD_WRITE_FAILED: "Copying the transcript to the clipboard failed.",

        MICROPHONE_UNAVAILABLE: "No microphone is available.",
        RUNTIME_START_FAILED: "The speech runtime failed to start.",
        RUNTIME_CRASHED: "The speech runtime crashed.",
        RECORDING_START_FAILED: "Recording could not be started.",
        RECORDING_STOP_FAILED: "Recording could not be stopped.",
        TRANSCRIPTION_FAILED: "Transcription failed.",
        TRANSCRIPTION_TIMEOUT: "Transcription took too long.",

        MODEL_NOT_INSTALLED: "The selected model is not installed.",
        MODEL_DOWNLOAD_FAILED: "Downloading the model failed.",
        MODEL_CHECKSUM_FAILED: "The downloaded model failed the integrity check.",

        SESSION_CONFLICT: "Another recording is already active.",
        STALE_SESSION: "This recording is no longer active.",
        KEYBOARD_CONTEXT_CHANGED: "The keyboard closed before the text could be inserted.",

        TRANSCRIPT_INVALID: "The transcript contains invalid characters.",
        TRANSCRIPT_TOO_LARGE: "The transcript is too large to insert.",

        RUNTIME_UNAVAILABLE: "The speech runtime is not available.",
        INVALID_SESSION_ID: "This recording session is no longer valid.",
        INVALID_TRANSCRIPT: "The transcript contains invalid characters.",
        SETTINGS_INVALID: "The settings are invalid.",
        MANIFEST_INVALID: "The model manifest is invalid.",
        INTERNAL_ERROR: "An unexpected internal error occurred.",
    },
    de: {
        STEAM_KEYBOARD_NOT_FOUND: "Steam-Tastatur nicht gefunden.",
        STEAM_PROFILE_UNSUPPORTED: "Dieses Steam-Tastatur-Layout wird noch nicht unterstützt.",
        PASTE_ACTION_UNAVAILABLE: "Direktes Einfügen ist auf dieser Tastatur nicht verfügbar.",
        CLIPBOARD_WRITE_FAILED:
            "Kopieren des Transkripts in die Zwischenablage ist fehlgeschlagen.",

        MICROPHONE_UNAVAILABLE: "Kein Mikrofon verfügbar.",
        RUNTIME_START_FAILED: "Die Spracherkennung konnte nicht gestartet werden.",
        RUNTIME_CRASHED: "Die Spracherkennung ist abgestürzt.",
        RECORDING_START_FAILED: "Die Aufnahme konnte nicht gestartet werden.",
        RECORDING_STOP_FAILED: "Die Aufnahme konnte nicht beendet werden.",
        TRANSCRIPTION_FAILED: "Transkription fehlgeschlagen.",
        TRANSCRIPTION_TIMEOUT: "Die Transkription hat zu lange gedauert.",

        MODEL_NOT_INSTALLED: "Das ausgewählte Modell ist nicht installiert.",
        MODEL_DOWNLOAD_FAILED: "Herunterladen des Modells ist fehlgeschlagen.",
        MODEL_CHECKSUM_FAILED:
            "Das heruntergeladene Modell hat die Integritätsprüfung nicht bestanden.",

        SESSION_CONFLICT: "Es läuft bereits eine andere Aufnahme.",
        STALE_SESSION: "Diese Aufnahme ist nicht mehr aktiv.",
        KEYBOARD_CONTEXT_CHANGED:
            "Die Tastatur wurde geschlossen, bevor der Text eingefügt werden konnte.",

        TRANSCRIPT_INVALID: "Das Transkript enthält ungültige Zeichen.",
        TRANSCRIPT_TOO_LARGE: "Das Transkript ist zu groß zum Einfügen.",

        RUNTIME_UNAVAILABLE: "Die Spracherkennung ist nicht verfügbar.",
        INVALID_SESSION_ID: "Diese Aufnahmesitzung ist nicht mehr gültig.",
        INVALID_TRANSCRIPT: "Das Transkript enthält ungültige Zeichen.",
        SETTINGS_INVALID: "Die Einstellungen sind ungültig.",
        MANIFEST_INVALID: "Die Modell-Manifestdatei ist ungültig.",
        INTERNAL_ERROR: "Es ist ein unerwarteter interner Fehler aufgetreten.",
    },
};

export function translate(locale: Locale, key: MessageKey): string {
    return MESSAGES[locale][key];
}

export function translateRuntimeStatus(locale: Locale, status: SpeechRuntimeStatus): string {
    const key = `runtime.status.${status}` as MessageKey;
    return translate(locale, key);
}

export function translateRuntimeHealth(locale: Locale, state: DictationState): string {
    if (state.kind === "unavailable") {
        return translate(locale, `unavailable.${state.reason}` as MessageKey);
    }
    return translate(locale, `runtime.health.${state.kind}` as MessageKey);
}

export function translateError(locale: Locale, code: DictationErrorCode): string {
    return ERROR_MESSAGES[locale][code];
}

/**
 * Stable degrade reason code → UI text (§68 analog for the v0.1.6 keyboard
 * hook and CDP diagnostics reasons). Unknown codes fall back to a generic
 * line instead of leaking raw internals into the UI.
 */
export function translateDegradeReason(locale: Locale, reason: string | null): string {
    if (reason === null) {
        return translate(locale, "degrade.unknown");
    }
    const key = `degrade.${reason}` as MessageKey;
    const message = MESSAGES[locale][key];
    return key in MESSAGES[locale] ? message : translate(locale, "degrade.unknown");
}

/** Accessible names for the microphone visual states (§107). */
export type MicrophoneLabelState = "ready" | "recording" | "processing" | "error";

export function translateMicLabel(locale: Locale, state: MicrophoneLabelState): string {
    return translate(locale, `mic.label.${state}` as MessageKey);
}

export function translateUnavailableReason(locale: Locale, reason: UnavailableReason): string {
    return translate(locale, `unavailable.${reason}` as MessageKey);
}

/**
 * Locale detection from a BCP-47 language tag. English is the fallback for
 * every tag that is not a German variant.
 */
export function detectLocale(languageTag: string | null | undefined): Locale {
    if (
        languageTag !== null &&
        languageTag !== undefined &&
        languageTag.toLowerCase().startsWith("de")
    ) {
        return "de";
    }
    return "en";
}

/** The environment locale, or English when no navigator is present. */
export function detectEnvironmentLocale(): Locale {
    if (typeof navigator === "undefined") {
        return "en";
    }
    return detectLocale(navigator.language);
}

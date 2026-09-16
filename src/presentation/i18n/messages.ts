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
    "diagnostics.runtimeStatus": "Runtime status",
    "diagnostics.model": "Model",
    "diagnostics.computeBackend": "Compute backend",
    "diagnostics.lastError": "Last runtime error",
    "diagnostics.restartRuntime": "Restart runtime",

    "mic.label.ready": "Start voice input",
    "mic.label.recording": "Recording — press to stop",
    "mic.label.processing": "Processing…",
    "mic.label.error": "Voice input error — details in the plugin panel",
} as const;

export type MessageKey = keyof typeof EN_MESSAGES;

export const DE_MESSAGES: Record<MessageKey, string> = {
    // Brand name: identical across locales (EN/DE parity).
    "panel.title": "SpeechToDeck",

    "section.runtime": "Laufzeit",
    "section.speech": "Spracherkennung",
    "section.output": "Ausgabe",
    "section.diagnostics": "Diagnose",

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
    "diagnostics.runtimeStatus": "Laufzeitstatus",
    "diagnostics.model": "Modell",
    "diagnostics.computeBackend": "Recheneinheit",
    "diagnostics.lastError": "Letzter Laufzeitfehler",
    "diagnostics.restartRuntime": "Laufzeit neu starten",

    "mic.label.ready": "Spracheingabe starten",
    "mic.label.recording": "Aufnahme läuft — zum Beenden drücken",
    "mic.label.processing": "Verarbeitung…",
    "mic.label.error": "Fehler bei der Spracheingabe — Details im Plugin-Panel",
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

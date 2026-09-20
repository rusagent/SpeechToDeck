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
import type { SpeechRuntimeStatus } from "../../application/ports/SpeechPort";

export type Locale = "en" | "de";

export const EN_MESSAGES = {
    "panel.title": "SpeechToDeck",

    "section.runtime": "Runtime",
    "section.speech": "Speech",
    "section.output": "Output",
    "section.dictation": "Dictation",

    "setting.enabled": "Enable plugin",
    "setting.computeBackend": "Compute backend",
    "setting.model": "Model",
    "setting.language": "Language",
    "setting.outputMode": "Output mode",
    "setting.loading": "Loading settings…",
    "setting.saveFailed": "Saving settings failed. The change was not persisted.",
    "setting.loadFailed": "Backend is not responding.",
    "setting.loadFailedHint":
        "Close and reopen this panel. If it persists, reload the plugin and open it again.",

    "option.backend.auto": "Auto (Vulkan if available)",
    "option.backend.vulkan": "Vulkan",
    "option.backend.cpu": "CPU",
    "option.model.tiny": "Tiny (fastest)",
    "option.model.base": "Base (default)",
    "option.model.small": "Small (most accurate)",
    "option.model.whisper-large-v3-turbo-q5_0": "Large v3 Turbo Q5_0",
    "option.model.whisper-large-v3-turbo": "Large v3 Turbo",
    "option.model.distil-small-en": "Distil Small (English)",
    "option.model.distil-medium-en": "Distil Medium (English)",
    "option.model.whisper-large-v3-turbo-german-q5_0": "Large v3 Turbo German Q5_0",
    "option.model.whisper-large-v3-turbo-german-f16": "Large v3 Turbo German F16",
    "option.model.whisper-large-v3-french-q5_0": "Large v3 French Q5_0",
    "option.model.kotoba-whisper-v2.0-q5_0": "Kotoba v2.0 Japanese Q5_0",
    "option.model.kotoba-whisper-v2.0-f16": "Kotoba v2.0 Japanese F16",
    "option.language.system": "System language",
    "option.language.auto": "Auto-detect",
    "option.output.direct-insert": "Direct insert",
    "option.output.clipboard-only": "Clipboard only",

    "hint.backend.auto": "Checks for Vulkan and uses the CPU when Vulkan is unavailable.",
    "hint.backend.vulkan":
        "Vulkan is required. If it fails, an error is shown - no silent switch to CPU.",
    "hint.backend.cpu": "Uses the CPU only.",
    "hint.language.system": "Same as auto-detect: the spoken language is detected automatically.",
    "hint.language.auto": "Detects the spoken language automatically.",
    "hint.language.explicit": "Transcriptions are made in this language.",

    "model.group.general": "General",
    "model.group.lang.de": "Deutsch",
    "model.group.lang.en": "English",
    "model.group.lang.fr": "Français",
    "model.group.lang.ja": "日本語",
    "model.recommended": "Recommended",
    "model.modal.preparing": "Starting download…",
    "model.modal.cancel": "Cancel",
    "model.modal.close": "Close",
    "model.modal.failed": "Download failed",
    "model.catalog.unavailable": "The model catalog could not be loaded.",

    "runtime.status.starting": "Starting",
    "runtime.status.ready": "Ready",
    "runtime.status.unavailable": "Unavailable",
    "runtime.status.crashed": "Crashed",

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
    "mic.label.recording": "Recording - press to stop",
    "mic.label.processing": "Processing…",
    // The concrete §68 code chip plus the mapped text render right on the
    // card's error line; the label stays generic (the old wording pointed to
    // the removed Diagnostics section, 40768ed).
    "mic.label.error": "Voice input error",

    "dictation.level.label": "Live microphone level",
    "dictation.level.style": "Visualizer",
    "dictation.level.style.heatmap": "Magma heat",
    "dictation.level.style.classic": "Classic bars",
    "dictation.level.style.mirror": "Mirror",
    "dictation.transcript.label": "Transcript",
    "dictation.clipboard.copied": "Copied - open the Steam keyboard (STEAM+X) and press Paste.",
    "dictation.clipboard.failed": "Copying failed - use “Copy again”.",
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
    "section.dictation": "Diktieren",

    "setting.enabled": "Plugin aktivieren",
    "setting.computeBackend": "Recheneinheit",
    "setting.model": "Modell",
    "setting.language": "Sprache",
    "setting.outputMode": "Ausgabemodus",
    "setting.loading": "Einstellungen werden geladen…",
    "setting.saveFailed":
        "Speichern der Einstellungen fehlgeschlagen. Die Änderung wurde nicht übernommen.",
    "setting.loadFailed": "Das Backend antwortet nicht.",
    "setting.loadFailedHint":
        "Schließe und öffne dieses Panel erneut. Falls es bestehen bleibt, lade das Plugin neu und öffne es wieder.",

    "option.backend.auto": "Automatisch (Vulkan, falls verfügbar)",
    "option.backend.vulkan": "Vulkan",
    "option.backend.cpu": "CPU",
    "option.model.tiny": "Tiny (am schnellsten)",
    "option.model.base": "Base (Standard)",
    "option.model.small": "Small (am genauesten)",
    "option.model.whisper-large-v3-turbo-q5_0": "Large v3 Turbo Q5_0",
    "option.model.whisper-large-v3-turbo": "Large v3 Turbo",
    "option.model.distil-small-en": "Distil Small (Englisch)",
    "option.model.distil-medium-en": "Distil Medium (Englisch)",
    "option.model.whisper-large-v3-turbo-german-q5_0": "Large v3 Turbo Deutsch Q5_0",
    "option.model.whisper-large-v3-turbo-german-f16": "Large v3 Turbo Deutsch F16",
    "option.model.whisper-large-v3-french-q5_0": "Large v3 Französisch Q5_0",
    "option.model.kotoba-whisper-v2.0-q5_0": "Kotoba v2.0 Japanisch Q5_0",
    "option.model.kotoba-whisper-v2.0-f16": "Kotoba v2.0 Japanisch F16",
    "option.language.system": "Systemsprache",
    "option.language.auto": "Automatisch erkennen",
    "option.output.direct-insert": "Direkt einfügen",
    "option.output.clipboard-only": "Nur Zwischenablage",

    "hint.backend.auto": "Prüft Vulkan und nutzt die CPU, wenn Vulkan nicht verfügbar ist.",
    "hint.backend.vulkan":
        "Vulkan ist erforderlich. Schlägt es fehl, wird ein Fehler angezeigt - kein stiller Wechsel zu CPU.",
    "hint.backend.cpu": "Nutzt nur die CPU.",
    "hint.language.system":
        "Wie Automatisch erkennen: Die gesprochene Sprache wird automatisch erkannt.",
    "hint.language.auto": "Erkennt die gesprochene Sprache automatisch.",
    "hint.language.explicit": "Transkriptionen werden in dieser Sprache erstellt.",

    "model.group.general": "Allgemein",
    "model.group.lang.de": "Deutsch",
    "model.group.lang.en": "English",
    "model.group.lang.fr": "Français",
    "model.group.lang.ja": "日本語",
    "model.recommended": "Empfohlen",
    "model.modal.preparing": "Download wird gestartet…",
    "model.modal.cancel": "Abbrechen",
    "model.modal.close": "Schließen",
    "model.modal.failed": "Download fehlgeschlagen",
    "model.catalog.unavailable": "Die Modell-Liste konnte nicht geladen werden.",

    "runtime.status.starting": "Startet",
    "runtime.status.ready": "Bereit",
    "runtime.status.unavailable": "Nicht verfügbar",
    "runtime.status.crashed": "Abgestürzt",

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
    "mic.label.recording": "Aufnahme läuft - zum Beenden drücken",
    "mic.label.processing": "Verarbeitung…",
    "mic.label.error": "Fehler bei der Spracheingabe",

    "dictation.level.label": "Live-Mikrofonpegel",
    "dictation.level.style": "Darstellung",
    "dictation.level.style.heatmap": "Magma-Hitze",
    "dictation.level.style.classic": "Klassische Balken",
    "dictation.level.style.mirror": "Spiegel",
    "dictation.transcript.label": "Transkript",
    "dictation.clipboard.copied":
        "Kopiert - öffne die Steam-Tastatur (STEAM+X) und drücke Einfügen.",
    "dictation.clipboard.failed": "Kopieren fehlgeschlagen - benutze „Erneut kopieren“.",
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
        MODEL_DOWNLOAD_CANCELLED: "The model download was canceled.",
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
        MODEL_DOWNLOAD_CANCELLED: "Das Herunterladen des Modells wurde abgebrochen.",
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

/**
 * Message keys of the curated catalog display names (ADR-011). Model names
 * are product identifiers; the German locale only localizes the language
 * adjectives. An id without a curated key (an older backend catalog) renders
 * as the raw id instead of an empty string.
 */
const MODEL_NAME_KEYS: Record<string, MessageKey> = {
    tiny: "option.model.tiny",
    base: "option.model.base",
    small: "option.model.small",
    "whisper-large-v3-turbo-q5_0": "option.model.whisper-large-v3-turbo-q5_0",
    "whisper-large-v3-turbo": "option.model.whisper-large-v3-turbo",
    "distil-small-en": "option.model.distil-small-en",
    "distil-medium-en": "option.model.distil-medium-en",
    "whisper-large-v3-turbo-german-q5_0": "option.model.whisper-large-v3-turbo-german-q5_0",
    "whisper-large-v3-turbo-german-f16": "option.model.whisper-large-v3-turbo-german-f16",
    "whisper-large-v3-french-q5_0": "option.model.whisper-large-v3-french-q5_0",
    "kotoba-whisper-v2.0-q5_0": "option.model.kotoba-whisper-v2.0-q5_0",
    "kotoba-whisper-v2.0-f16": "option.model.kotoba-whisper-v2.0-f16",
};

export function modelDisplayName(locale: Locale, modelId: string): string {
    const key = MODEL_NAME_KEYS[modelId];
    return key === undefined ? modelId : translate(locale, key);
}

export function translateRuntimeStatus(locale: Locale, status: SpeechRuntimeStatus): string {
    const key = `runtime.status.${status}` as MessageKey;
    return translate(locale, key);
}

export function translateError(locale: Locale, code: DictationErrorCode): string {
    return ERROR_MESSAGES[locale][code];
}

/** Accessible names for the microphone visual states (§107). */
export type MicrophoneLabelState = "ready" | "recording" | "processing" | "error";

export function translateMicLabel(locale: Locale, state: MicrophoneLabelState): string {
    return translate(locale, `mic.label.${state}` as MessageKey);
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

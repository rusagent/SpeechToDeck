import type { DictationErrorCode } from "../../domain/DictationError";
import type { SpeechRuntimeStatus } from "../../application/ports/SpeechPort";

export type Locale = "en" | "de";

export const EN_MESSAGES = {
    "panel.title": "SpeechToDeck",

    "section.runtime": "Runtime",
    "section.speech": "Speech",
    "section.dictation": "Dictation",

    "setting.enabled": "Enable plugin",
    "setting.model": "Model",
    "setting.language": "Language",
    "setting.loading": "Loading settings…",
    "setting.saveFailed": "Saving settings failed. The change was not persisted.",
    "setting.loadFailed": "Backend is not responding.",
    "setting.loadFailedHint":
        "Close and reopen this panel. If it persists, reload the plugin and open it again.",
    "setting.loadFailedReloading": "Reloading the plugin backend …",

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
    "model.manage.open": "Manage models",
    "model.manage.title": "Manage models",
    "model.manage.hint":
        "Installed models can be deleted to free up space. Deleted models can be downloaded again at any time.",
    "model.manage.selected": "selected",
    "model.manage.delete": "Delete",
    "model.manage.deleteAll": "Delete all inactive",
    "model.manage.deleting": "Deleting…",
    "model.manage.deleteFailed": "Deleting the model failed.",
    "model.manage.confirmTitle": "Delete model",
    "model.manage.confirmAllTitle": "Delete inactive models",
    "model.manage.confirmSingle":
        "The model is removed from disk. You can download it again at any time.",
    "model.manage.confirmAll":
        "The inactive models are removed from disk. You can download them again at any time. The selected model is kept.",

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
    "panel.title": "SpeechToDeck",

    "section.runtime": "Laufzeit",
    "section.speech": "Spracherkennung",
    "section.dictation": "Diktieren",

    "setting.enabled": "Plugin aktivieren",
    "setting.model": "Modell",
    "setting.language": "Sprache",
    "setting.loading": "Einstellungen werden geladen…",
    "setting.saveFailed":
        "Speichern der Einstellungen fehlgeschlagen. Die Änderung wurde nicht übernommen.",
    "setting.loadFailed": "Das Backend antwortet nicht.",
    "setting.loadFailedHint":
        "Schließe und öffne dieses Panel erneut. Falls es bestehen bleibt, lade das Plugin neu und öffne es wieder.",
    "setting.loadFailedReloading": "Plugin-Backend wird neu geladen …",

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
    "model.manage.open": "Modelle verwalten",
    "model.manage.title": "Modelle verwalten",
    "model.manage.hint":
        "Installierte Modelle können gelöscht werden, um Speicherplatz freizugeben. Gelöschte Modelle kannst du jederzeit erneut herunterladen.",
    "model.manage.selected": "ausgewählt",
    "model.manage.delete": "Löschen",
    "model.manage.deleteAll": "Alle inaktiven löschen",
    "model.manage.deleting": "Wird gelöscht…",
    "model.manage.deleteFailed": "Löschen des Modells ist fehlgeschlagen.",
    "model.manage.confirmTitle": "Modell löschen",
    "model.manage.confirmAllTitle": "Inaktive Modelle löschen",
    "model.manage.confirmSingle":
        "Das Modell wird von der Festplatte entfernt. Du kannst es jederzeit erneut herunterladen.",
    "model.manage.confirmAll":
        "Die inaktiven Modelle werden von der Festplatte entfernt. Du kannst sie jederzeit erneut herunterladen. Das ausgewählte Modell bleibt erhalten.",

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

export type MicrophoneLabelState = "ready" | "recording" | "processing" | "error";

export function translateMicLabel(locale: Locale, state: MicrophoneLabelState): string {
    return translate(locale, `mic.label.${state}` as MessageKey);
}

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

export function detectEnvironmentLocale(): Locale {
    if (typeof navigator === "undefined") {
        return "en";
    }
    return detectLocale(navigator.language);
}

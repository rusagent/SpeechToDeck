"""Stable backend error codes and typed exceptions.

Error codes cross the Decky boundary as stable strings. Frontend UI text is
mapped from codes only; exception messages never travel to the frontend
(frontend logic must never parse arbitrary exception strings).
"""

from __future__ import annotations

from enum import StrEnum

PROTOCOL_VERSION = 1


class ErrorCode(StrEnum):
    """Stable error codes, including the dedicated transcript errors.

    Only codes the backend can produce are declared here. Frontend-only codes
    (STEAM_KEYBOARD_*, PASTE_*, CLIPBOARD_*, KEYBOARD_CONTEXT_CHANGED) belong
    to the frontend lane.
    """

    MICROPHONE_UNAVAILABLE = "MICROPHONE_UNAVAILABLE"
    RUNTIME_START_FAILED = "RUNTIME_START_FAILED"
    RUNTIME_CRASHED = "RUNTIME_CRASHED"
    RUNTIME_UNAVAILABLE = "RUNTIME_UNAVAILABLE"
    RECORDING_START_FAILED = "RECORDING_START_FAILED"
    RECORDING_STOP_FAILED = "RECORDING_STOP_FAILED"
    TRANSCRIPTION_FAILED = "TRANSCRIPTION_FAILED"
    TRANSCRIPTION_TIMEOUT = "TRANSCRIPTION_TIMEOUT"
    MODEL_NOT_INSTALLED = "MODEL_NOT_INSTALLED"
    MODEL_DOWNLOAD_FAILED = "MODEL_DOWNLOAD_FAILED"
    MODEL_DOWNLOAD_CANCELLED = "MODEL_DOWNLOAD_CANCELLED"
    MODEL_CHECKSUM_FAILED = "MODEL_CHECKSUM_FAILED"
    SESSION_CONFLICT = "SESSION_CONFLICT"
    STALE_SESSION = "STALE_SESSION"
    EMPTY_TRANSCRIPT = "EMPTY_TRANSCRIPT"
    INVALID_TRANSCRIPT = "INVALID_TRANSCRIPT"
    TRANSCRIPT_TOO_LARGE = "TRANSCRIPT_TOO_LARGE"
    INVALID_SESSION_ID = "INVALID_SESSION_ID"
    SETTINGS_INVALID = "SETTINGS_INVALID"
    MANIFEST_INVALID = "MANIFEST_INVALID"
    INTERNAL_ERROR = "INTERNAL_ERROR"


class SpeechError(Exception):
    """Base class for every backend failure carrying a stable code."""

    def __init__(
        self,
        code: ErrorCode,
        message: str,
        *,
        detail: str | None = None,
        session_id: str | None = None,
    ) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.detail = detail
        self.session_id = session_id

    def payload(self) -> dict[str, object]:
        """Versioned event/callable payload for this error.

        Never includes transcript text or audio bytes (privacy).
        """
        payload: dict[str, object] = {
            "protocolVersion": PROTOCOL_VERSION,
            "code": str(self.code),
        }
        if self.session_id is not None:
            payload["sessionId"] = self.session_id
        if self.detail is not None:
            payload["detail"] = self.detail
        return payload


class CodedSpeechError(SpeechError):
    """Subclass boilerplate removal: fixes the error code of a family."""

    def __init__(
        self,
        message: str,
        *,
        detail: str | None = None,
        session_id: str | None = None,
    ) -> None:
        super().__init__(self._code(), message, detail=detail, session_id=session_id)

    def _code(self) -> ErrorCode:  # pragma: no cover - overridden
        raise NotImplementedError


class MicrophoneUnavailableError(CodedSpeechError):
    def _code(self) -> ErrorCode:
        return ErrorCode.MICROPHONE_UNAVAILABLE


class RuntimeStartError(CodedSpeechError):
    """The pinned native runtime could not be started."""

    def _code(self) -> ErrorCode:
        return ErrorCode.RUNTIME_START_FAILED


class RuntimeCrashedError(CodedSpeechError):
    def _code(self) -> ErrorCode:
        return ErrorCode.RUNTIME_CRASHED


class RuntimeUnavailableError(CodedSpeechError):
    def _code(self) -> ErrorCode:
        return ErrorCode.RUNTIME_UNAVAILABLE


class RecordingStartError(CodedSpeechError):
    def _code(self) -> ErrorCode:
        return ErrorCode.RECORDING_START_FAILED


class RecordingStopError(CodedSpeechError):
    def _code(self) -> ErrorCode:
        return ErrorCode.RECORDING_STOP_FAILED


class TranscriptionFailedError(CodedSpeechError):
    def _code(self) -> ErrorCode:
        return ErrorCode.TRANSCRIPTION_FAILED


class TranscriptionTimeoutError(CodedSpeechError):
    def _code(self) -> ErrorCode:
        return ErrorCode.TRANSCRIPTION_TIMEOUT


class ModelNotInstalledError(CodedSpeechError):
    def _code(self) -> ErrorCode:
        return ErrorCode.MODEL_NOT_INSTALLED


class ModelDownloadFailedError(CodedSpeechError):
    def _code(self) -> ErrorCode:
        return ErrorCode.MODEL_DOWNLOAD_FAILED


class ModelDownloadCancelledError(CodedSpeechError):
    """User-initiated cancel of the in-flight download.

    Deliberately NOT a failure: the stable code keeps the journal (and the
    frontend error mapping) from reading a routine cancel as a network
    failure — on device, every second tap on the conflated Download/Cancel
    button logged `MODEL_DOWNLOAD_FAILED`.
    """

    def _code(self) -> ErrorCode:
        return ErrorCode.MODEL_DOWNLOAD_CANCELLED


class TransientModelDownloadError(ModelDownloadFailedError):
    """Transport-class download failure (URLError/timeout/connection reset).

    Same stable code (``MODEL_DOWNLOAD_FAILED``); the subclass marks the
    failure class the startup path may retry with its bounded automatic
    ladder. Checksum mismatches, cancellations and HTTP status failures stay
    plain ``ModelDownloadFailedError`` and are never retried.
    """


class ModelChecksumFailedError(CodedSpeechError):
    def _code(self) -> ErrorCode:
        return ErrorCode.MODEL_CHECKSUM_FAILED


class SessionConflictError(CodedSpeechError):
    def _code(self) -> ErrorCode:
        return ErrorCode.SESSION_CONFLICT


class StaleSessionError(CodedSpeechError):
    def _code(self) -> ErrorCode:
        return ErrorCode.STALE_SESSION


class EmptyTranscriptError(CodedSpeechError):
    """Dedicated transcript error. Empty speech is not a runtime error."""

    def _code(self) -> ErrorCode:
        return ErrorCode.EMPTY_TRANSCRIPT


class InvalidTranscriptError(CodedSpeechError):
    def _code(self) -> ErrorCode:
        return ErrorCode.INVALID_TRANSCRIPT


class TranscriptTooLargeError(CodedSpeechError):
    def _code(self) -> ErrorCode:
        return ErrorCode.TRANSCRIPT_TOO_LARGE


class InvalidSessionIdError(CodedSpeechError):
    def _code(self) -> ErrorCode:
        return ErrorCode.INVALID_SESSION_ID


class SettingsInvalidError(CodedSpeechError):
    def _code(self) -> ErrorCode:
        return ErrorCode.SETTINGS_INVALID


class ManifestInvalidError(CodedSpeechError):
    def _code(self) -> ErrorCode:
        return ErrorCode.MANIFEST_INVALID


class InternalError(CodedSpeechError):
    def _code(self) -> ErrorCode:
        return ErrorCode.INTERNAL_ERROR

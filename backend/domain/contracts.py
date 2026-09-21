from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol, runtime_checkable

from backend.domain.errors import PROTOCOL_VERSION, SpeechError

ComputeBackend = Literal["auto", "vulkan", "cpu"]

PROTOCOL_VERSION_V1: int = PROTOCOL_VERSION

EVENT_SPEECH_STATUS = "speech_status"
EVENT_TRANSCRIPT_READY = "transcript_ready"
EVENT_SPEECH_ERROR = "speech_error"
EVENT_MODEL_DOWNLOAD_PROGRESS = "model_download_progress"
EVENT_MODEL_DOWNLOAD_COMPLETE = "model_download_complete"
EVENT_RUNTIME_STATUS = "runtime_status"
EVENT_SETUP_PROGRESS = "setup_progress"
EVENT_RECORDING_LEVEL = "recording_level"

DEFAULT_MAX_RECORDING_SECONDS = 86400


@dataclass(frozen=True)
class Settings:
    schema_version: int
    enabled: bool
    compute_backend: ComputeBackend
    model_id: str
    language: str

    def to_payload(self) -> dict[str, object]:
        return {
            "schemaVersion": self.schema_version,
            "enabled": self.enabled,
            "computeBackend": self.compute_backend,
            "modelId": self.model_id,
            "language": self.language,
        }


DEFAULT_SETTINGS = Settings(
    schema_version=1,
    enabled=True,
    compute_backend="auto",
    model_id="base",
    language="system",
)


@dataclass(frozen=True)
class ModelInfo:
    id: str
    engine: str
    multilingual: bool
    filename: str
    download_url: str
    sha256: str
    size_bytes: int | None
    languages: tuple[str, ...] | None = None
    description: str | None = None


@dataclass(frozen=True)
class TranscriptResult:
    text: str
    backend: str | None = None
    audio_duration_ms: float | None = None
    transcription_duration_ms: float | None = None


@runtime_checkable
class SpeechRuntime(Protocol):
    async def start(self) -> None: ...

    async def stop(self) -> None: ...

    async def start_recording(self) -> None: ...

    async def stop_recording(self) -> None: ...

    async def cancel_recording(self) -> None: ...


@runtime_checkable
class ModelRepository(Protocol):
    async def list_models(self) -> list[ModelInfo]: ...

    async def ensure_model(self, model_id: str) -> None: ...


@runtime_checkable
class EventPublisher(Protocol):
    async def publish(self, event_name: str, payload: dict[str, object]) -> None: ...


@runtime_checkable
class TranscriptSink(Protocol):
    async def on_transcript(self, result: TranscriptResult) -> None: ...

    async def on_transcript_error(self, error: SpeechError) -> None: ...


ClipboardStatus = Literal["ok", "failed", "skipped"]


@runtime_checkable
class ClipboardWriter(Protocol):
    async def write_text(self, text: str) -> ClipboardStatus: ...

    def is_available(self) -> bool: ...

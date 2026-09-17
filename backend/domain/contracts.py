"""Domain contracts (spec §32): structural Protocols, no inheritance hierarchy.

These are the ports application code depends on. Concrete adapters live in
`backend/infrastructure/**` and are wired in `backend/composition.py`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol, runtime_checkable

from backend.domain.errors import PROTOCOL_VERSION, SpeechError

ComputeBackend = Literal["auto", "vulkan", "cpu"]
OutputMode = Literal["direct-insert", "clipboard-only"]

# §67: every cross-boundary payload carries protocolVersion.
PROTOCOL_VERSION_V1: int = PROTOCOL_VERSION

# §30 backend events.
EVENT_SPEECH_STATUS = "speech_status"
EVENT_TRANSCRIPT_READY = "transcript_ready"
EVENT_SPEECH_ERROR = "speech_error"
EVENT_MODEL_DOWNLOAD_PROGRESS = "model_download_progress"
EVENT_MODEL_DOWNLOAD_COMPLETE = "model_download_complete"
EVENT_RUNTIME_STATUS = "runtime_status"
# §82 startup path progress (frozen frontend contract, see
# backend/application/setup_progress.py).
EVENT_SETUP_PROGRESS = "setup_progress"

# §44/§54 defaults.
DEFAULT_MAX_RECORDING_SECONDS = 60


@dataclass(frozen=True)
class Settings:
    """Plugin settings snapshot (wire shape in spec §54)."""

    schema_version: int
    enabled: bool
    compute_backend: ComputeBackend
    model_id: str
    language: str
    max_recording_seconds: int
    vad_enabled: bool
    output_mode: OutputMode

    def to_payload(self) -> dict[str, object]:
        """Wire (camelCase) representation per §54."""
        return {
            "schemaVersion": self.schema_version,
            "enabled": self.enabled,
            "computeBackend": self.compute_backend,
            "modelId": self.model_id,
            "language": self.language,
            "maxRecordingSeconds": self.max_recording_seconds,
            "vadEnabled": self.vad_enabled,
            "outputMode": self.output_mode,
        }


DEFAULT_SETTINGS = Settings(
    schema_version=1,
    enabled=True,
    compute_backend="auto",
    model_id="base",
    language="system",
    max_recording_seconds=DEFAULT_MAX_RECORDING_SECONDS,
    vad_enabled=True,
    output_mode="direct-insert",
)


@dataclass(frozen=True)
class ModelInfo:
    """One curated model from the committed manifest (spec §50)."""

    id: str
    engine: str
    multilingual: bool
    filename: str
    download_url: str
    sha256: str
    size_bytes: int | None


@dataclass(frozen=True)
class TranscriptResult:
    """Final one-shot transcript delivered by the native runtime (§21, §42)."""

    text: str
    backend: str | None = None
    audio_duration_ms: float | None = None
    transcription_duration_ms: float | None = None


@runtime_checkable
class SpeechRuntime(Protocol):
    """Native runtime port (spec §32). Exact protocol shape from canon."""

    async def start(self) -> None: ...

    async def stop(self) -> None: ...

    async def start_recording(self) -> None: ...

    async def stop_recording(self) -> None: ...

    async def cancel_recording(self) -> None: ...


@runtime_checkable
class SettingsRepository(Protocol):
    async def load(self) -> Settings: ...

    async def save(self, settings: Settings) -> None: ...


@runtime_checkable
class ModelRepository(Protocol):
    async def list_models(self) -> list[ModelInfo]: ...

    async def ensure_model(self, model_id: str) -> None: ...


@runtime_checkable
class EventPublisher(Protocol):
    async def publish(self, event_name: str, payload: dict[str, object]) -> None: ...


@runtime_checkable
class TranscriptSink(Protocol):
    """Consumer of final native transcription outcomes (§42).

    The real runtime adapter calls this exactly once per completed (or failed)
    transcription. The application service implements it; composition wires
    the adapter to the service.
    """

    async def on_transcript(self, result: TranscriptResult) -> None: ...

    async def on_transcript_error(self, error: SpeechError) -> None: ...

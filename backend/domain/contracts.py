"""Domain contracts: structural Protocols, no inheritance hierarchy.

These are the ports application code depends on. Concrete adapters live in
`backend/infrastructure/**` and are wired in `backend/composition.py`.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Literal, Protocol, runtime_checkable

from backend.domain.errors import PROTOCOL_VERSION, SpeechError

ComputeBackend = Literal["auto", "vulkan", "cpu"]
OutputMode = Literal["direct-insert", "clipboard-only"]

# Every cross-boundary payload carries protocolVersion.
PROTOCOL_VERSION_V1: int = PROTOCOL_VERSION

# Backend event names published to the frontend.
EVENT_SPEECH_STATUS = "speech_status"
EVENT_TRANSCRIPT_READY = "transcript_ready"
EVENT_SPEECH_ERROR = "speech_error"
EVENT_MODEL_DOWNLOAD_PROGRESS = "model_download_progress"
EVENT_MODEL_DOWNLOAD_COMPLETE = "model_download_complete"
EVENT_RUNTIME_STATUS = "runtime_status"
# Startup path progress events (frozen frontend contract, see
# backend/application/setup_progress.py).
EVENT_SETUP_PROGRESS = "setup_progress"
# Live audio-level vectors coalesced from the daemon's audio.sock broadcast
# while a recording session is active. Pure presentation feedback — never
# part of the dictation control flow; older frontends ignore it.
EVENT_RECORDING_LEVEL = "recording_level"

# Recording-length bound for the daemon. The maximum-recording-duration and
# VAD settings were removed from the settings document; the daemon still
# needs both, so the supervisor emits this shipped cap and VAD enabled as
# fixed constants (daemon_supervisor.daemon_config_toml) and the
# transcription watchdog budgets from it.
# The cap is a 24 h runaway-recording VALVE, not a UX limit — recording is
# practically unlimited. Upstream has no true unlimited mode:
# `max_duration_secs = 0` auto-stops within ~100 ms (NOT unlimited,
# daemon.rs:3463), so the largest honest bound is a value no dictation ever
# reaches. Multi-hour recordings are bounded instead by the transcription
# watchdogs, which scale with the recorded duration (speech_service /
# voxtype_client). VAD stays fixed OFF (the silero model is not bundled).
DEFAULT_MAX_RECORDING_SECONDS = 86400


@dataclass(frozen=True)
class Settings:
    """Plugin settings snapshot (the wire shape of the settings document).

    `language` is the language for MULTILINGUAL models ("system" sentinel →
    upstream "auto", explicit tags pass through); it is IGNORED for
    single-language models, whose declared language is forced in the daemon
    config regardless of this value.

    `maxRecordingSeconds` and `vadEnabled` are no longer part of the
    settings document. The settings repository still tolerates both keys on
    load — existing device files carry them — and never writes them back.
    """

    schema_version: int
    enabled: bool
    compute_backend: ComputeBackend
    model_id: str
    language: str
    output_mode: OutputMode

    def to_payload(self) -> dict[str, object]:
        """Wire (camelCase) representation of the settings."""
        return {
            "schemaVersion": self.schema_version,
            "enabled": self.enabled,
            "computeBackend": self.compute_backend,
            "modelId": self.model_id,
            "language": self.language,
            "outputMode": self.output_mode,
        }


DEFAULT_SETTINGS = Settings(
    schema_version=1,
    enabled=True,
    compute_backend="auto",
    model_id="base",
    language="system",
    output_mode="direct-insert",
)


@dataclass(frozen=True)
class ModelInfo:
    """One curated model from the committed manifest.

    `languages` / `description` are the curated-catalog fields: `languages`
    lists the language codes a specialized model was built for (None for
    multilingual general models); `description` is one short English
    sentence for the picker.
    """

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
    """Final one-shot transcript delivered by the native runtime."""

    text: str
    backend: str | None = None
    audio_duration_ms: float | None = None
    transcription_duration_ms: float | None = None


@runtime_checkable
class SpeechRuntime(Protocol):
    """Native runtime port: daemon lifecycle and recording control."""

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
    """Consumer of final native transcription outcomes.

    The real runtime adapter calls this exactly once per completed (or failed)
    transcription. The application service implements it; composition wires
    the adapter to the service.
    """

    async def on_transcript(self, result: TranscriptResult) -> None: ...

    async def on_transcript_error(self, error: SpeechError) -> None: ...


# Outcome of the system-clipboard write that follows a successful
# transcription: "ok" (written), "failed" (attempted, not written),
# "skipped" (not attempted — no writer wired or no usable binary).
ClipboardStatus = Literal["ok", "failed", "skipped"]


@runtime_checkable
class ClipboardWriter(Protocol):
    """System-clipboard writer for finished transcripts.

    Best-effort by contract: implementations map every expected failure mode
    to a `ClipboardStatus` instead of raising, because a clipboard failure
    must never fail the transcription itself (the transcript is still
    delivered and shown for manual copy).
    """

    async def write_text(self, text: str) -> ClipboardStatus: ...

    def is_available(self) -> bool:
        """Read-only diagnostics probe: can this writer attempt a copy?"""
        ...

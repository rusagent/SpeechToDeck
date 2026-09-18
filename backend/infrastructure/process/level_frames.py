"""Parser for the voxtype v1.0.1 audio-level socket frames.

Upstream wire contract, verified directly at the v1.0.1 tag
(`src/audio/levels.rs` — module doc, `AudioFrame`, `to_bytes`/`from_bytes`,
`FRAME_BYTES`): while a recording session is active the daemon buckets the
live sample stream into 10 ms windows (100 Hz) and broadcasts one 16-byte
frame per window over the unix socket ``$XDG_RUNTIME_DIR/voxtype/audio.sock``:

.. code-block:: text

    #[repr(C)] struct AudioFrame { seq: u32, min: f32, max: f32, peak_dbfs: f32 }

Fields are serialised explicitly per field with **native byte order**
(``to_ne_bytes``) and no padding; daemon and consumers run on the same host,
so native order is the wire order here too (x86_64 → little-endian).
``min``/``max`` are the window's sample extrema in ``-1.0..=1.0``;
``peak_dbfs`` is the window peak in dBFS, clamped to ``-120.0`` for silence
(never below) and never above ``0.0`` while samples stay in ``[-1.0, 1.0]``.
This is an amplitude envelope, NOT an FFT: the visualization built on it is a
real live level meter, and product copy must not call it a spectrum.

Parsing is defensive by design: the socket is a lossy best-effort broadcast
shared with other subscribers, so any 16-byte read that fails the sanity
validation (truncation, corruption, wrong byte order, a foreign protocol) is
dropped and counted instead of rendered — the visualization shows ONLY real
received frames. The sanity ranges are tight enough that byte-swapped frames
are rejected (floats become non-finite or absurd) instead of silently drawn.
"""

from __future__ import annotations

import math
import struct
from dataclasses import dataclass

# "=" = native byte order, standard sizes, no alignment padding: exactly the
# upstream per-field to_ne_bytes layout (4 + 4 + 4 + 4 = 16 bytes).
FRAME_STRUCT = struct.Struct("=Ifff")

#: Wire size of one frame; equals upstream ``FRAME_BYTES`` (16).
FRAME_BYTES = FRAME_STRUCT.size

#: Upstream silence clamp for ``peak_dbfs`` (levels.rs: "clamped to -120.0").
PEAK_DBFS_FLOOR = -120.0

# Float-rounding slack for the documented ranges (sample extrema in
# [-1.0, 1.0]; dBFS of those samples within [PEAK_DBFS_FLOOR, 0.0]).
_RANGE_EPS = 1e-3


@dataclass(frozen=True)
class AudioLevelFrame:
    """One parsed 10 ms audio-level window."""

    seq: int
    minimum: float
    maximum: float
    peak_dbfs: float


def parse_frame(data: bytes | bytearray | memoryview) -> AudioLevelFrame | None:
    """Parse one 16-byte frame; ``None`` when it fails the wire contract."""
    if len(data) != FRAME_BYTES:
        return None
    seq, minimum, maximum, peak_dbfs = FRAME_STRUCT.unpack(data)
    if not (math.isfinite(minimum) and math.isfinite(maximum) and math.isfinite(peak_dbfs)):
        return None
    if not (-1.0 - _RANGE_EPS <= minimum <= maximum <= 1.0 + _RANGE_EPS):
        return None
    if not (PEAK_DBFS_FLOOR - _RANGE_EPS <= peak_dbfs <= _RANGE_EPS):
        return None
    return AudioLevelFrame(seq=seq, minimum=minimum, maximum=maximum, peak_dbfs=peak_dbfs)


def parse_stream(data: bytes) -> tuple[list[AudioLevelFrame], int]:
    """Parse concatenated frames; returns ``(frames, dropped_bytes)``.

    Every complete 16-byte window is validated independently; invalid windows
    are dropped (not rendered) and their bytes counted. A trailing partial
    frame (mid-stream reconnect artifact) is dropped as well.
    """
    frames: list[AudioLevelFrame] = []
    dropped = 0
    for offset in range(0, len(data), FRAME_BYTES):
        chunk = data[offset : offset + FRAME_BYTES]
        frame = parse_frame(chunk)
        if frame is None:
            dropped += len(chunk)
        else:
            frames.append(frame)
    return frames, dropped

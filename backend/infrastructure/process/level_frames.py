from __future__ import annotations

import math
import struct
from dataclasses import dataclass

FRAME_STRUCT = struct.Struct("=Ifff")

FRAME_BYTES = FRAME_STRUCT.size

PEAK_DBFS_FLOOR = -120.0

_RANGE_EPS = 1e-3


@dataclass(frozen=True)
class AudioLevelFrame:
    seq: int
    minimum: float
    maximum: float
    peak_dbfs: float


def parse_frame(data: bytes | bytearray | memoryview) -> AudioLevelFrame | None:
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

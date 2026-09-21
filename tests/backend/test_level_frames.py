from __future__ import annotations

import math
import struct
from pathlib import Path

from backend.infrastructure.process.level_frames import (
    FRAME_BYTES,
    AudioLevelFrame,
    parse_frame,
    parse_stream,
)

FIXTURES = Path(__file__).resolve().parents[1] / "fixtures" / "levels"

LE_EXPECTED: list[tuple[int, float, float, float]] = [
    (0, 0.0, 0.0, -120.0),
    (1, -0.25, 0.5, struct.unpack("=f", struct.pack("=f", -6.0206))[0]),
    (2, -0.5, 0.75, -2.5),
    (
        3,
        struct.unpack("=f", struct.pack("=f", -0.9))[0],
        struct.unpack("=f", struct.pack("=f", 0.9))[0],
        struct.unpack("=f", struct.pack("=f", -0.9151))[0],
    ),
    (4, -1.0, 1.0, 0.0),
    (
        5,
        struct.unpack("=f", struct.pack("=f", -0.1))[0],
        struct.unpack("=f", struct.pack("=f", 0.2))[0],
        struct.unpack("=f", struct.pack("=f", -13.9794))[0],
    ),
    (6, 0.0, 0.0, -120.0),
    (
        4294967290,
        struct.unpack("=f", struct.pack("=f", -0.3))[0],
        struct.unpack("=f", struct.pack("=f", 0.3))[0],
        struct.unpack("=f", struct.pack("=f", -10.4576))[0],
    ),
]


def test_frame_bytes_match_the_cited_struct() -> None:
    assert FRAME_BYTES == 16
    assert struct.calcsize("=Ifff") == FRAME_BYTES


def test_parses_the_recorded_little_endian_stream_exactly() -> None:
    raw = (FIXTURES / "frame_stream_le.bin").read_bytes()
    frames, dropped = parse_stream(raw)
    assert dropped == 0
    assert len(frames) == len(LE_EXPECTED)
    for frame, expected in zip(frames, LE_EXPECTED, strict=True):
        assert isinstance(frame, AudioLevelFrame)
        assert (frame.seq, frame.minimum, frame.maximum, frame.peak_dbfs) == expected


def test_rejects_the_byte_swapped_stream_instead_of_rendering_it() -> None:

    raw = (FIXTURES / "frame_stream_be.bin").read_bytes()
    frames, dropped = parse_stream(raw)
    assert dropped == 80
    assert len(frames) < len(LE_EXPECTED)
    recorded_levels = {(f[1], f[2], f[3]) for f in LE_EXPECTED}
    for frame in frames:
        assert (frame.minimum, frame.maximum, frame.peak_dbfs) not in recorded_levels
        assert abs(frame.minimum) < 1e-5 and abs(frame.maximum) < 1e-5
        assert frame.peak_dbfs > -1.0


def test_rejects_truncated_and_oversized_reads() -> None:
    assert parse_frame(b"") is None
    assert parse_frame(b"\x00" * (FRAME_BYTES - 1)) is None
    assert parse_frame(b"\x00" * (FRAME_BYTES + 1)) is None
    raw = (FIXTURES / "frame_stream_le.bin").read_bytes()
    frames, dropped = parse_stream(raw + raw[:7])
    assert len(frames) == len(LE_EXPECTED)
    assert dropped == 7


def test_rejects_out_of_range_and_non_finite_fields() -> None:
    good = struct.pack("=Ifff", 7, -0.5, 0.5, -3.0)
    assert parse_frame(good) is not None
    assert parse_frame(struct.pack("=Ifff", 7, 0.5, -0.5, -3.0)) is None
    assert parse_frame(struct.pack("=Ifff", 7, -1.5, 0.5, -3.0)) is None
    assert parse_frame(struct.pack("=Ifff", 7, -0.5, 0.5, 6.0)) is None
    assert parse_frame(struct.pack("=Ifff", 7, -0.5, 0.5, -999.0)) is None
    nan = struct.unpack("=f", struct.pack("=I", 0x7FC00000))[0]
    assert math.isnan(nan)
    assert parse_frame(struct.pack("=Ifff", 7, nan, 0.5, -3.0)) is None
    assert parse_frame(struct.pack("=Ifff", 7, -0.5, 0.5, math.inf)) is None


def test_parse_stream_drops_invalid_windows_and_keeps_valid_neighbours() -> None:
    good = struct.pack("=Ifff", 1, -0.25, 0.25, -6.0)
    bad = struct.pack("=Ifff", 2, 9.0, 9.0, 0.0)
    frames, dropped = parse_stream(good + bad + good)
    assert [f.seq for f in frames] == [1, 1]
    assert dropped == FRAME_BYTES

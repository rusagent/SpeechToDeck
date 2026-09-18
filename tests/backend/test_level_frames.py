"""Level-frame parser tests against recorded byte fixtures (§61 source data).

Oracle: the committed fixtures under ``tests/fixtures/levels/`` are recorded
byte streams of the cited wire struct (voxtype v1.0.1 ``src/audio/levels.rs``,
``#[repr(C)] AudioFrame { seq: u32, min: f32, max: f32, peak_dbfs: f32 }``,
per-field native byte order, 16 bytes). The little-endian stream is the real
Deck order (x86_64); the byte-swapped stream is the wrong-byte-order case and
must be REJECTED by the sanity validation, never rendered.
"""

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

# f32-normalized expectations for tests/fixtures/levels/frame_stream_le.bin
# (the wire carries float32; these are the exact values after f32 rounding,
# printed by the fixture generator).
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
    # The cited struct is 4 + 4 + 4 + 4 = 16 bytes, native order, no padding.
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
    """Wrong byte order must not survive as the recorded signal.

    The wire order is native (levels.rs to_ne_bytes); the parser deliberately
    has NO byte-order fallback. Swapped frames either fail the sanity
    validation (dropped, counted) or — for byte-symmetric silence windows
    (0x00000000 is identical in both orders) — degenerate to flat ~zero
    denormals. Both outcomes mean: a byte-swapped stream can never render as
    the real recording; the strip shows only real frames.
    """
    raw = (FIXTURES / "frame_stream_be.bin").read_bytes()
    frames, dropped = parse_stream(raw)
    assert dropped == 80  # 5 of 8 windows rejected outright
    assert len(frames) < len(LE_EXPECTED)
    # None of the surviving swapped frames reproduces any recorded level.
    recorded_levels = {(f[1], f[2], f[3]) for f in LE_EXPECTED}
    for frame in frames:
        assert (frame.minimum, frame.maximum, frame.peak_dbfs) not in recorded_levels
        assert abs(frame.minimum) < 1e-5 and abs(frame.maximum) < 1e-5
        assert frame.peak_dbfs > -1.0  # degenerate ~0 dBFS, not the signal


def test_rejects_truncated_and_oversized_reads() -> None:
    assert parse_frame(b"") is None
    assert parse_frame(b"\x00" * (FRAME_BYTES - 1)) is None
    assert parse_frame(b"\x00" * (FRAME_BYTES + 1)) is None
    raw = (FIXTURES / "frame_stream_le.bin").read_bytes()
    frames, dropped = parse_stream(raw + raw[:7])  # trailing partial frame
    assert len(frames) == len(LE_EXPECTED)
    assert dropped == 7


def test_rejects_out_of_range_and_non_finite_fields() -> None:
    good = struct.pack("=Ifff", 7, -0.5, 0.5, -3.0)
    assert parse_frame(good) is not None
    # min > max (corruption / wrong field order).
    assert parse_frame(struct.pack("=Ifff", 7, 0.5, -0.5, -3.0)) is None
    # Sample extrema outside [-1, 1].
    assert parse_frame(struct.pack("=Ifff", 7, -1.5, 0.5, -3.0)) is None
    # dBFS above 0 (impossible while samples are within [-1, 1]).
    assert parse_frame(struct.pack("=Ifff", 7, -0.5, 0.5, 6.0)) is None
    # dBFS below the documented -120.0 clamp.
    assert parse_frame(struct.pack("=Ifff", 7, -0.5, 0.5, -999.0)) is None
    # NaN/inf from garbage bytes.
    nan = struct.unpack("=f", struct.pack("=I", 0x7FC00000))[0]
    assert math.isnan(nan)
    assert parse_frame(struct.pack("=Ifff", 7, nan, 0.5, -3.0)) is None
    assert parse_frame(struct.pack("=Ifff", 7, -0.5, 0.5, math.inf)) is None


def test_parse_stream_drops_invalid_windows_and_keeps_valid_neighbours() -> None:
    good = struct.pack("=Ifff", 1, -0.25, 0.25, -6.0)
    bad = struct.pack("=Ifff", 2, 9.0, 9.0, 0.0)  # out of range
    frames, dropped = parse_stream(good + bad + good)
    assert [f.seq for f in frames] == [1, 1]
    assert dropped == FRAME_BYTES

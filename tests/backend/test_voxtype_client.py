from __future__ import annotations

import asyncio

import pytest
from backend.domain.errors import (
    RecordingStartError,
    TranscriptionFailedError,
)
from backend.infrastructure.process.runtime_variant import RuntimeVariantResolver
from backend.infrastructure.process.voxtype_client import VoxtypeClient
from conftest import (
    SinkCollector,
    build_fixture_binary,
    make_paths,
    make_resolver,
    spawn_fixture_daemon,
    stop_process_group,
    write_pinned_runtime_manifest,
    write_test_daemon_config,
)


async def make_ready_client(
    paths: object,
    *,
    backend: str = "cpu",
    **client_kwargs: object,
) -> tuple[VoxtypeClient, RuntimeVariantResolver]:
    write_pinned_runtime_manifest(paths.plugin_root, digest="ab" * 32)
    resolver = make_resolver(paths)
    config_path = write_test_daemon_config(paths)
    await resolver.resolve(backend, config_path=config_path)
    client = VoxtypeClient(paths, resolver, **client_kwargs)
    return client, resolver


def test_record_roundtrip_reads_output_exactly_once(tmp_path: object) -> None:
    async def scenario() -> None:
        paths = make_paths(tmp_path)
        binary = build_fixture_binary(paths.plugin_root)
        proc = await spawn_fixture_daemon(paths, binary)
        sink = SinkCollector()
        client, _resolver = await make_ready_client(
            paths, backend="cpu", final_transcript_timeout=3.0
        )
        client.transcript_sink = sink
        try:
            paths.output_file.write_text("STALE PREVIOUS TRANSCRIPT", encoding="utf-8")
            paths.output_sidecar_file.write_text("stale\n", encoding="utf-8")

            await client.start_recording()
            assert not paths.output_file.exists()
            assert not paths.output_sidecar_file.exists()

            await client.stop_recording()
            assert await sink.wait_delivery(3.0)

            assert len(sink.results) == 1
            result = sink.results[0]
            assert result.text == "hello world"
            assert result.backend == "cpu"
            assert result.transcription_duration_ms is not None
            assert not paths.output_file.exists()
            assert not paths.output_sidecar_file.exists()
            assert sink.errors == []
        finally:
            await client.stop()
            await stop_process_group(proc)

    asyncio.run(scenario())


def test_trailing_newline_strip_is_exactly_one(tmp_path: object) -> None:
    async def scenario() -> None:
        paths = make_paths(tmp_path)
        binary = build_fixture_binary(
            paths.plugin_root, extra_daemon_args=["--transcript-text", "line one\n\n"]
        )
        proc = await spawn_fixture_daemon(paths, binary)
        sink = SinkCollector()
        client, _ = await make_ready_client(paths, final_transcript_timeout=3.0)
        client.transcript_sink = sink
        try:
            await client.start_recording()
            await client.stop_recording()
            assert await sink.wait_delivery(3.0)
            assert sink.results[0].text == "line one\n"
        finally:
            await client.stop()
            await stop_process_group(proc)

    asyncio.run(scenario())


def test_start_acknowledgement_timeout(tmp_path: object) -> None:
    async def scenario() -> None:
        paths = make_paths(tmp_path)
        binary = build_fixture_binary(paths.plugin_root, extra_record_args=["--ack-sleep", "3"])
        proc = await spawn_fixture_daemon(paths, binary)
        sink = SinkCollector()
        client, _ = await make_ready_client(paths, ack_timeout=0.3)
        client.transcript_sink = sink
        try:
            with pytest.raises(RecordingStartError) as excinfo:
                await client.start_recording()
            assert "acknowledge" in excinfo.value.message
            assert sink.results == []
        finally:
            await client.stop()
            await stop_process_group(proc)

    asyncio.run(scenario())


def test_start_fails_without_daemon(tmp_path: object) -> None:
    async def scenario() -> None:
        paths = make_paths(tmp_path)
        build_fixture_binary(paths.plugin_root)
        sink = SinkCollector()
        client, _ = await make_ready_client(paths, ack_timeout=0.5)
        client.transcript_sink = sink
        try:
            with pytest.raises(RecordingStartError):
                await client.start_recording()
            assert sink.results == []
        finally:
            await client.stop()

    asyncio.run(scenario())


def test_control_fails_closed_before_variant_resolution(tmp_path: object) -> None:
    async def scenario() -> None:
        paths = make_paths(tmp_path)
        build_fixture_binary(paths.plugin_root)
        client = VoxtypeClient(paths, make_resolver(paths))
        client.transcript_sink = SinkCollector()
        with pytest.raises(RecordingStartError):
            await client.start_recording()

    asyncio.run(scenario())


def test_stop_timeout_scales_with_recorded_duration(tmp_path: object) -> None:
    from backend.infrastructure.process.voxtype_client import final_wait_budget

    assert final_wait_budget(0.0, 120.0) == 120.0
    assert final_wait_budget(600.0, 120.0) == 1200.0

    async def scenario() -> None:
        paths = make_paths(tmp_path)
        binary = build_fixture_binary(paths.plugin_root)
        proc = await spawn_fixture_daemon(paths, binary)
        sink = SinkCollector()
        clock = {"now": 100.0}
        client, _ = await make_ready_client(paths, backend="cpu", clock=lambda: clock["now"])
        client.transcript_sink = sink
        recorded_stop_argv: list[list[str]] = []
        real_exec = asyncio.create_subprocess_exec

        async def spy(*argv: object, **kwargs: object) -> object:
            args = [str(a) for a in argv]
            if "stop" in args:
                recorded_stop_argv.append(args)
            return await real_exec(*argv, **kwargs)

        import backend.infrastructure.process.voxtype_client as voxtype_client_module

        original = voxtype_client_module.asyncio.create_subprocess_exec
        voxtype_client_module.asyncio.create_subprocess_exec = spy
        try:
            await client.start_recording()
            clock["now"] += 600.0
            await client.stop_recording()
            assert await sink.wait_delivery(3.0)
            assert sink.results[0].text == "hello world"
            assert len(recorded_stop_argv) == 1
            timeout_value = recorded_stop_argv[0][recorded_stop_argv[0].index("--timeout") + 1]
            assert timeout_value == "1200"
        finally:
            voxtype_client_module.asyncio.create_subprocess_exec = original
            await client.stop()
            await stop_process_group(proc)

    asyncio.run(scenario())


def test_stop_times_out_via_upstream_exit_code(tmp_path: object) -> None:
    async def scenario() -> None:
        paths = make_paths(tmp_path)
        binary = build_fixture_binary(paths.plugin_root, extra_daemon_args=["--hang-transcription"])
        proc = await spawn_fixture_daemon(paths, binary)
        sink = SinkCollector()
        client, _ = await make_ready_client(paths, final_transcript_timeout=0.4)
        client.transcript_sink = sink
        try:
            await client.start_recording()
            await client.stop_recording()
            assert await sink.wait_delivery(5.0)
            assert len(sink.errors) == 1
            assert str(sink.errors[0].code) == "TRANSCRIPTION_TIMEOUT"
            assert sink.results == []
        finally:
            await client.stop()
            await stop_process_group(proc)

    asyncio.run(scenario())


def test_empty_speech_outcome_is_delivered_as_empty_result(tmp_path: object) -> None:

    async def scenario() -> None:
        paths = make_paths(tmp_path)
        binary = build_fixture_binary(
            paths.plugin_root, extra_daemon_args=["--empty-transcription"]
        )
        proc = await spawn_fixture_daemon(paths, binary)
        sink = SinkCollector()
        client, _ = await make_ready_client(paths, final_transcript_timeout=3.0)
        client.transcript_sink = sink
        try:
            await client.start_recording()
            await client.stop_recording()
            assert await sink.wait_delivery(3.0)
            assert len(sink.results) == 1
            assert sink.results[0].text == ""
            assert sink.errors == []
            assert not paths.output_file.exists()
        finally:
            await client.stop()
            await stop_process_group(proc)

    asyncio.run(scenario())


def test_failed_transcription_maps_to_transcription_failed(tmp_path: object) -> None:
    async def scenario() -> None:
        paths = make_paths(tmp_path)
        binary = build_fixture_binary(
            paths.plugin_root, extra_daemon_args=["--error-transcription"]
        )
        proc = await spawn_fixture_daemon(paths, binary)
        sink = SinkCollector()
        client, _ = await make_ready_client(paths, final_transcript_timeout=3.0)
        client.transcript_sink = sink
        try:
            await client.start_recording()
            await client.stop_recording()
            assert await sink.wait_delivery(3.0)
            assert len(sink.errors) == 1
            assert str(sink.errors[0].code) == "TRANSCRIPTION_FAILED"
            assert sink.results == []
        finally:
            await client.stop()
            await stop_process_group(proc)

    asyncio.run(scenario())


def test_cancel_discards_pending_result(tmp_path: object) -> None:
    async def scenario() -> None:
        paths = make_paths(tmp_path)
        binary = build_fixture_binary(
            paths.plugin_root, extra_daemon_args=["--transcribe-delay", "1.5"]
        )
        proc = await spawn_fixture_daemon(paths, binary)
        sink = SinkCollector()
        client, _ = await make_ready_client(paths, final_transcript_timeout=3.0)
        client.transcript_sink = sink
        try:
            await client.start_recording()
            await client.cancel_recording()
            await asyncio.sleep(0.3)
            assert sink.results == [] and sink.errors == []
        finally:
            await client.stop()
            await stop_process_group(proc)

    asyncio.run(scenario())


def test_stop_fails_when_daemon_died_mid_recording(tmp_path: object) -> None:

    async def scenario() -> None:
        paths = make_paths(tmp_path)
        binary = build_fixture_binary(paths.plugin_root)
        proc = await spawn_fixture_daemon(paths, binary)
        sink = SinkCollector()
        client, _ = await make_ready_client(paths, final_transcript_timeout=2.0)
        client.transcript_sink = sink
        try:
            await client.start_recording()
            proc.kill()
            await proc.wait()
            await asyncio.sleep(0.05)
            await client.stop_recording()
            assert await sink.wait_delivery(5.0)
            assert sink.results == []
            assert len(sink.errors) == 1
            assert isinstance(sink.errors[0], TranscriptionFailedError)
        finally:
            await client.stop()

    asyncio.run(scenario())

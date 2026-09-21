from __future__ import annotations

import time
from collections.abc import Callable

from backend.domain.contracts import EVENT_SETUP_PROGRESS, PROTOCOL_VERSION_V1, EventPublisher

STEP_RUNTIME_VERIFY = "runtime.verify"
STEP_MODEL_ENSURE = "model.ensure"
STEP_DAEMON_START = "daemon.start"
STEP_MODEL_WARMUP = "model.warmup"
STEP_READY = "ready"
STEP_FAILED = "failed"

LABEL_RUNTIME_VERIFY = "setup.step.runtimeVerify"
LABEL_MODEL_ENSURE = "setup.step.modelEnsure"
LABEL_DAEMON_START = "setup.step.daemonStart"
LABEL_MODEL_WARMUP = "setup.step.modelWarmup"
LABEL_READY = "setup.state.ready"
LABEL_FAILED = "setup.state.failed"

DETAIL_CHECKSUM = "setup.detail.checksum"
DETAIL_DOWNLOADING = "setup.detail.downloading"
DETAIL_VERIFYING = "setup.detail.verifying"
DETAIL_SPAWNING = "setup.detail.spawning"
DETAIL_WARMUP = "setup.detail.warmup"

TOTAL_STEPS = 4

PROGRESS_MIN_PERCENT_DELTA = 1
PROGRESS_MIN_INTERVAL_S = 0.25

_STEPS: tuple[tuple[str, str], ...] = (
    (STEP_RUNTIME_VERIFY, LABEL_RUNTIME_VERIFY),
    (STEP_MODEL_ENSURE, LABEL_MODEL_ENSURE),
    (STEP_DAEMON_START, LABEL_DAEMON_START),
    (STEP_MODEL_WARMUP, LABEL_MODEL_WARMUP),
)


class SetupProgressReporter:
    def __init__(
        self, publisher: EventPublisher, *, clock: Callable[[], float] = time.monotonic
    ) -> None:
        self._publisher = publisher
        self._clock = clock
        self._active = False
        self._step_index = 0
        self._percent = 0
        self._last_emit_time = 0.0

    async def begin_run(self) -> None:
        self._active = True
        self._step_index = 0
        self._percent = 0
        self._last_emit_time = self._clock()

    @property
    def failing_step_index(self) -> int:

        return self._step_index

    async def step(
        self,
        step_index: int,
        *,
        percent: int,
        indeterminate: bool = False,
        detail_key: str | None = None,
    ) -> None:
        self._step_index = step_index
        self._percent = percent
        await self._emit(percent, indeterminate=indeterminate, detail_key=detail_key)

    async def download_progress(self, model_id: str, received: int, total: int | None) -> None:
        del model_id
        if not self._active or self._step_index != 1:
            return
        percent = received * 100 // total if total is not None and total > 0 else self._percent
        now = self._clock()
        due = percent - self._percent >= PROGRESS_MIN_PERCENT_DELTA or (
            now - self._last_emit_time >= PROGRESS_MIN_INTERVAL_S
        )
        if not due:
            return
        self._percent = percent
        await self._emit(percent, indeterminate=False, detail_key=DETAIL_DOWNLOADING)

    async def ready(self) -> None:
        self._active = False
        await self._publish(
            step=STEP_READY,
            label_key=LABEL_READY,
            step_index=TOTAL_STEPS,
            percent=100,
            indeterminate=False,
        )

    async def fail(self, code: str) -> None:
        was_active = self._active
        self._active = False
        if not was_active:
            return
        await self._publish(
            step=STEP_FAILED,
            label_key=LABEL_FAILED,
            step_index=self._step_index,
            percent=self._percent,
            indeterminate=False,
            error={"code": code},
        )

    async def _emit(self, percent: int, *, indeterminate: bool, detail_key: str | None) -> None:
        step, label_key = _STEPS[self._step_index]
        await self._publish(
            step=step,
            label_key=label_key,
            step_index=self._step_index,
            percent=percent,
            indeterminate=indeterminate,
            detail_key=detail_key,
        )
        self._last_emit_time = self._clock()

    async def _publish(
        self,
        *,
        step: str,
        label_key: str,
        step_index: int,
        percent: int,
        indeterminate: bool,
        detail_key: str | None = None,
        error: dict[str, object] | None = None,
    ) -> None:
        payload: dict[str, object] = {
            "protocolVersion": PROTOCOL_VERSION_V1,
            "step": step,
            "labelKey": label_key,
            "stepIndex": step_index,
            "totalSteps": TOTAL_STEPS,
            "percent": percent,
            "indeterminate": indeterminate,
        }
        if detail_key is not None:
            payload["detailKey"] = detail_key
        if error is not None:
            payload["error"] = error
        await self._publisher.publish(EVENT_SETUP_PROGRESS, payload)

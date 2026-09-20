"""Setup-progress event stream for the startup path (`setup_progress`).

Frozen frontend contract (v1): JSON payloads over the existing EventPublisher
port, emitted only while the startup path runs — never from get_status and
never with transcript or audio content. Steps in startup order:

    0 runtime.verify  "setup.step.runtimeVerify"   real percent (0 → 100)
    1 model.ensure    "setup.step.modelEnsure"     real percent (digest
                                                   verify or chunked download)
    2 daemon.start    "setup.step.daemonStart"     indeterminate
    3 model.warmup    "setup.step.modelWarmup"     indeterminate

Terminal: step "ready" (`setup.state.ready`, stepIndex 4, percent 100) or
step "failed" (`setup.state.failed`) at the step where startup failed, with
a stable error code. Progress ticks are throttled exactly like the
download feed: emit on a percent delta ≥ 1 or ≥250 ms elapsed.
"""

from __future__ import annotations

import time
from collections.abc import Callable

from backend.domain.contracts import EVENT_SETUP_PROGRESS, PROTOCOL_VERSION_V1, EventPublisher

# Step ids and label keys are part of the frozen frontend contract.
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

# Steps 0-3 plus the terminal step index (4).
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
    """Emits the throttled `setup_progress` stream for one startup run.

    Inert until `begin_run()`: the download progress feed is wired at
    composition time, but events may only flow while the startup path runs.
    A failed step leaves the reporter at the failing step; `fail()` then
    emits the terminal `failed` event with the current step and percent.
    """

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
        """Start a fresh startup stream (the lifecycle lock serializes runs)."""
        self._active = True
        self._step_index = 0
        self._percent = 0
        self._last_emit_time = self._clock()

    @property
    def failing_step_index(self) -> int:
        """Index of the step the run failed (or would fail) at.

        Valid after `fail()`: the reporter stays at the failing step, so the
        composition root can store the failure position for the
        `get_status` report (frontend setup-panel hydration).
        """
        return self._step_index

    async def step(
        self,
        step_index: int,
        *,
        percent: int,
        indeterminate: bool = False,
        detail_key: str | None = None,
    ) -> None:
        """Emit a forced step transition (never throttled)."""
        self._step_index = step_index
        self._percent = percent
        await self._emit(percent, indeterminate=indeterminate, detail_key=detail_key)

    async def download_progress(self, model_id: str, received: int, total: int | None) -> None:
        """Consume the model download feed (throttled, step 1 only; no
        content — ids and byte counts only)."""
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
        """Terminal ready state (stepIndex 4, percent 100, determinate)."""
        self._active = False
        await self._publish(
            step=STEP_READY,
            label_key=LABEL_READY,
            step_index=TOTAL_STEPS,
            percent=100,
            indeterminate=False,
        )

    async def fail(self, code: str) -> None:
        """Terminal failed state at the step where startup failed."""
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

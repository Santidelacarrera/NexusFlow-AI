"""Motor de ejecución: DAG por capas en paralelo, reintentos, rutas alternativas y compensación (saga).

Garantías (probadas en tests/):
- Un workflow inválido (ciclos, dependencias rotas, tareas no registradas) se rechaza antes de ejecutar nada.
- Cada transición se persiste ANTES de continuar y deja un evento append-only con `request_id` y `tenant_id`.
- Un fallo transitorio se reintenta con backoff acotado; un fallo definitivo activa la ruta alternativa si existe.
- Si el run no puede completarse, se compensan los pasos con efectos en orden inverso de finalización.
- Un proceso que muere a mitad se reanuda con `recover()`: los pasos completados no se repiten
  (checkpoint) y los efectos externos son idempotentes gracias a la clave `run_id:step_id`.

Límite conocido: un run lo conduce UN proceso a la vez (no hay lease entre réplicas; ver docs/ORCHESTRATOR.md).
"""
from __future__ import annotations

import asyncio
import json
import logging
import random
import uuid
from typing import Any, Awaitable, Callable

from . import dag
from .context import FlowContext, bind, unbind
from .errors import DefinitionError, PermanentError, RetryableError, StepError
from .models import (
    ACTIVE_RUN,
    DONE_STEP,
    CompensationStatus,
    RetryPolicy,
    RunEvent,
    RunRecord,
    RunStatus,
    StepDef,
    StepFailure,
    StepRecord,
    StepStatus,
    WorkflowDef,
    utcnow,
)
from .redact import redact, redact_text
from .registry import StepInput, TaskRegistry
from .store import StateStore

log = logging.getLogger("nexusflow.engine")


class UnknownWorkflow(KeyError):
    pass


class TooManyActiveRuns(Exception):
    pass


class RunNotFound(KeyError):
    pass


class WorkflowEngine:
    def __init__(
        self,
        store: StateStore,
        registry: TaskRegistry,
        definitions: list[WorkflowDef],
        *,
        sleep: Callable[[float], Awaitable[None]] = asyncio.sleep,
        jitter: Callable[[], float] = random.random,
        max_parallel_steps: int = 8,
        max_active_runs_per_tenant: int = 20,
        compensation_attempts: int = 3,
        max_output_bytes: int = 256 * 1024,
    ) -> None:
        self.store, self.registry = store, registry
        self._sleep, self._jitter = sleep, jitter
        self._max_parallel = max_parallel_steps
        self._max_active = max_active_runs_per_tenant
        self._comp_attempts = compensation_attempts
        self._max_output = max_output_bytes
        self._defs: dict[str, WorkflowDef] = {}
        self._order: dict[str, list[str]] = {}
        for d in definitions:
            if d.name in self._defs:
                raise DefinitionError(f"workflow duplicado: {d.name}")
            self._order[d.name] = dag.validate(d, registry.names())
            self._defs[d.name] = d
        self._live: dict[str, asyncio.Task] = {}
        self._live_runs: dict[str, RunRecord] = {}
        self._cancel_events: dict[str, asyncio.Event] = {}
        self._locks: dict[str, asyncio.Lock] = {}
        self._stopping = False

    # ------------------------------------------------------------------ API pública
    def workflows(self) -> list[WorkflowDef]:
        return list(self._defs.values())

    async def start(
        self,
        workflow: str,
        *,
        tenant_id: str,
        request_id: str,
        run_input: dict[str, Any],
        idempotency_key: str | None = None,
    ) -> tuple[RunRecord, bool]:
        """Crea el run y lo programa. Devuelve (run, creado). Con la misma Idempotency-Key no duplica."""
        defn = self._defs.get(workflow)
        if defn is None:
            raise UnknownWorkflow(workflow)
        if await self.store.count_active(tenant_id) >= self._max_active:
            raise TooManyActiveRuns(tenant_id)
        run = RunRecord(
            run_id=uuid.uuid4().hex,
            tenant_id=tenant_id,
            request_id=request_id,
            workflow=defn.name,
            version=defn.version,
            input=run_input,
            idempotency_key=idempotency_key,
            steps={s.id: StepRecord(step_id=s.id) for s in defn.steps},
        )
        run, created = await self.store.create_run(run)
        if created:
            await self._emit(run, "run.created", data={"workflow": defn.name, "version": defn.version})
            self._spawn(run)
        return run, created

    async def get_run(self, tenant_id: str, run_id: str) -> RunRecord | None:
        live = self._live_runs.get(run_id)
        if live is not None and live.tenant_id == tenant_id:
            return live.model_copy(deep=True)
        return await self.store.get_run(tenant_id, run_id)

    async def cancel(self, tenant_id: str, run_id: str) -> RunRecord:
        """Cancelación cooperativa: detiene los pasos en vuelo y compensa lo ya hecho. Idempotente."""
        run = self._live_runs.get(run_id)
        if run is None or run.tenant_id != tenant_id:
            run = await self.store.get_run(tenant_id, run_id)
        if run is None:
            raise RunNotFound(run_id)
        if run.status not in ACTIVE_RUN:
            return run
        if not run.cancel_requested:
            run.cancel_requested = True
            await self._persist(run)
            await self._emit(run, "run.cancel_requested")
        if run_id in self._live:
            self._cancel_events[run_id].set()
        else:  # huérfano (proceso previo murió): lo conduce este proceso
            self._spawn(run)
        return run

    async def recover(self) -> int:
        """Al arrancar: reanuda los runs que un proceso anterior dejó a medias."""
        n = 0
        for run in await self.store.list_active():
            if run.run_id not in self._live:
                run.resume_count += 1
                self._spawn(run)
                n += 1
        return n

    async def wait(self, run_id: str) -> None:
        task = self._live.get(run_id)
        if task:
            await asyncio.shield(task)

    async def shutdown(self) -> None:
        """Interrumpe los runs en vuelo SIN marcarlos como fallidos: `recover()` los reanudará."""
        self._stopping = True
        tasks = list(self._live.values())
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)

    # ------------------------------------------------------------------ conducción del run
    def _spawn(self, run: RunRecord) -> None:
        self._live_runs[run.run_id] = run
        self._cancel_events[run.run_id] = asyncio.Event()
        task = asyncio.create_task(self._drive(run), name=f"run:{run.run_id}")
        self._live[run.run_id] = task

        def done(t: asyncio.Task, rid: str = run.run_id) -> None:
            self._live.pop(rid, None)
            self._live_runs.pop(rid, None)
            self._cancel_events.pop(rid, None)
            self._locks.pop(rid, None)

        task.add_done_callback(done)

    async def _drive(self, run: RunRecord) -> None:
        ctx = FlowContext(run.request_id, run.tenant_id, run.run_id)
        token = bind(ctx)
        try:
            await self._execute(run, ctx)
        except asyncio.CancelledError:
            raise  # shutdown: el estado persistido es el último checkpoint
        except Exception:  # bug del motor: no dejar el run colgado en RUNNING
            log.exception("error interno del motor", extra=ctx.log_fields())
            run.status = RunStatus.FAILED
            run.error = StepFailure(kind="internal", message="error interno del motor")
            await self._persist(run)
            await self._emit(run, "run.failed", data={"error": "internal"})
        finally:
            unbind(token)

    async def _execute(self, run: RunRecord, ctx: FlowContext) -> None:
        defn = self._defs.get(run.workflow)
        if defn is None or defn.version != run.version:
            run.status, run.error = RunStatus.FAILED, StepFailure(kind="definition", message="versión de workflow no disponible")
            await self._persist(run)
            await self._emit(run, "run.failed", data={"error": "definition"})
            return
        cancel_ev = self._cancel_events[run.run_id]
        if run.cancel_requested:
            cancel_ev.set()

        if run.status != RunStatus.COMPENSATING:
            for rec in run.steps.values():
                if rec.status == StepStatus.RUNNING:  # quedó a medias: se reintenta, el efecto es idempotente
                    rec.status, rec.attempts = StepStatus.PENDING, 0
            resumed = run.resume_count > 0
            run.status = RunStatus.RUNNING
            await self._persist(run)
            await self._emit(run, "run.resumed" if resumed else "run.started", data={"resume_count": run.resume_count})
            outcome = await self._run_steps(run, defn, ctx, cancel_ev)
            if outcome == "completed":
                run.output = {leaf: run.steps[leaf].output for leaf in dag.leaves(defn)}
                run.status = RunStatus.COMPLETED
                await self._persist(run)
                await self._emit(run, "run.completed", data={"steps": len(run.steps)})
                return
            run.status = RunStatus.COMPENSATING
            await self._persist(run)

        # Fallo o cancelación: compensar y fijar el estado terminal.
        cancelled = run.cancel_requested and run.error is None
        await self._emit(run, "run.compensating", data={"reason": "cancelled" if cancelled else "failed"})
        compensated, all_ok = await self._compensate(run, defn, ctx)
        if not all_ok:
            run.status, kind = RunStatus.COMPENSATION_FAILED, "run.compensation_failed"
        elif cancelled:
            run.status, kind = RunStatus.CANCELLED, "run.cancelled"
        elif compensated:
            run.status, kind = RunStatus.COMPENSATED, "run.compensated"
        else:
            run.status, kind = RunStatus.FAILED, "run.failed"
        await self._persist(run)
        await self._emit(run, kind, data={"error": run.error.model_dump() if run.error else None})

    async def _run_steps(self, run: RunRecord, defn: WorkflowDef, ctx: FlowContext, cancel_ev: asyncio.Event) -> str:
        steps = {s.id: s for s in defn.steps}
        order = self._order[defn.name]
        sem = asyncio.Semaphore(self._max_parallel)
        running: dict[asyncio.Task, str] = {}
        launched: set[str] = set()
        cancel_waiter = asyncio.create_task(cancel_ev.wait())
        try:
            while True:
                stopping = run.error is not None or cancel_ev.is_set()
                if not stopping:
                    for sid in order:
                        rec = run.steps[sid]
                        if (
                            rec.status == StepStatus.PENDING
                            and sid not in launched
                            and all(run.steps[d].status in DONE_STEP for d in steps[sid].depends_on)
                        ):
                            launched.add(sid)
                            t = asyncio.create_task(self._exec_step(run, steps, steps[sid], ctx, sem), name=f"step:{sid}")
                            running[t] = sid
                if not running:
                    break
                done, _ = await asyncio.wait({*running, cancel_waiter}, return_when=asyncio.FIRST_COMPLETED)
                if cancel_waiter in done and run.error is None:
                    for t in running:
                        t.cancel()
                for t in done - {cancel_waiter}:
                    running.pop(t)
                    try:
                        failure = t.result()
                    except asyncio.CancelledError:
                        continue
                    if failure is not None and run.error is None:
                        run.error = failure
                        for other in running:
                            other.cancel()  # un paso falló definitivamente: no se lanza ni sigue nada más
                if cancel_waiter in done and not running:
                    break
        except asyncio.CancelledError:  # apagado: no dejar pasos huérfanos ejecutándose
            for t in running:
                t.cancel()
            await asyncio.gather(*running, return_exceptions=True)
            raise
        finally:
            cancel_waiter.cancel()
        if run.error is not None:
            return "failed"
        if cancel_ev.is_set():
            return "cancelled"
        regular = [s for s in defn.steps if not s.fallback_only]
        return "completed" if all(run.steps[s.id].status in DONE_STEP for s in regular) else "failed"

    # ------------------------------------------------------------------ pasos
    async def _exec_step(
        self, run: RunRecord, steps: dict[str, StepDef], step: StepDef, ctx: FlowContext, sem: asyncio.Semaphore
    ) -> StepFailure | None:
        rec = run.steps[step.id]
        async with sem:
            rec.status, rec.started_at = StepStatus.RUNNING, utcnow()
            await self._persist(run)
            inputs = {d: run.steps[d].output for d in step.depends_on}
            try:
                ok, res = await self._call(run, step, ctx, inputs)
                if ok:
                    await self._finish(run, rec, StepStatus.COMPLETED, output=res)
                    await self._emit(run, "step.completed", step.id, {"attempts": rec.attempts})
                    return None
                failure: StepFailure = res
                await self._emit(run, "step.failed", step.id, {"error": failure.model_dump(), "attempts": rec.attempts})
                if step.fallback:
                    fb = steps[step.fallback]
                    frec = run.steps[fb.id]
                    frec.status, frec.started_at = StepStatus.RUNNING, utcnow()
                    await self._persist(run)
                    await self._emit(run, "step.fallback", step.id, {"fallback": fb.id, "reason": failure.model_dump()})
                    ok2, res2 = await self._call(run, fb, ctx, inputs, failure_info=failure.model_dump())
                    if ok2:
                        await self._finish(run, frec, StepStatus.COMPLETED, output=res2)
                        await self._emit(run, "step.completed", fb.id, {"attempts": frec.attempts, "fallback_of": step.id})
                        rec.used_fallback, rec.error = fb.id, failure
                        await self._finish(run, rec, StepStatus.FALLBACK, output=res2, keep_error=True)
                        await self._emit(run, "step.completed", step.id, {"via_fallback": fb.id})
                        return None
                    await self._finish(run, frec, StepStatus.FAILED, error=res2)
                    failure = res2
                await self._finish(run, rec, StepStatus.FAILED, error=failure)
                return failure
            except asyncio.CancelledError:
                if not self._stopping:  # apagado del proceso: se deja el último checkpoint para reanudar
                    await self._finish(run, rec, StepStatus.CANCELLED)
                    await self._emit(run, "step.cancelled", step.id)
                raise

    async def _call(
        self,
        run: RunRecord,
        step: StepDef,
        ctx: FlowContext,
        inputs: dict[str, Any],
        failure_info: dict[str, Any] | None = None,
    ) -> tuple[bool, Any]:
        rec = run.steps[step.id]
        fn = self.registry.get(step.task)
        policy = step.retry
        for attempt in range(1, policy.max_attempts + 1):
            rec.attempts = attempt
            await self._persist(run)
            await self._emit(run, "step.started", step.id, {"attempt": attempt, "task": step.task})
            si = StepInput(
                ctx=ctx.for_step(step.id),
                step_id=step.id,
                attempt=attempt,
                params=step.params,
                inputs=inputs,
                run_input=run.input,
                idempotency_key=f"{run.run_id}:{step.id}",
                failure=failure_info,
            )
            try:
                async with asyncio.timeout(step.timeout_s):
                    out = await fn(si)
                return True, self._normalize(out)
            except asyncio.CancelledError:
                raise
            except TimeoutError:
                err: StepError = RetryableError(f"timeout tras {step.timeout_s}s")
            except StepError as e:
                err = e
            except Exception as e:  # excepción no tipificada: no se reintenta a ciegas
                err = PermanentError(f"{type(e).__name__}: {e}")
            failure = StepFailure(
                kind=err.kind, message=redact_text(str(err)), retryable=err.retryable, details=redact(err.details)
            )
            if err.retryable and attempt < policy.max_attempts:
                delay = self._delay(policy, attempt, err)
                await self._emit(
                    run, "step.retry", step.id, {"attempt": attempt, "next_in_s": round(delay, 3), "error": failure.model_dump()}
                )
                await self._sleep(delay)
                continue
            return False, failure
        raise AssertionError("inalcanzable")

    def _delay(self, policy: RetryPolicy, attempt: int, err: StepError) -> float:
        delay = min(policy.backoff_max_s, policy.backoff_base_s * (2 ** (attempt - 1)))
        delay *= 0.5 + self._jitter() / 2
        retry_after = getattr(err, "retry_after_s", None)
        if retry_after:
            delay = max(delay, min(retry_after, policy.backoff_max_s))
        return delay

    def _normalize(self, out: Any) -> Any:
        try:
            text = json.dumps(out)
        except (TypeError, ValueError) as e:
            raise PermanentError(f"la salida del paso no es JSON serializable: {e}") from e
        if len(text.encode()) > self._max_output:
            raise PermanentError("la salida del paso supera el tamaño máximo permitido")
        return json.loads(text)

    async def _finish(
        self,
        run: RunRecord,
        rec: StepRecord,
        status: StepStatus,
        *,
        output: Any = None,
        error: StepFailure | None = None,
        keep_error: bool = False,
    ) -> None:
        run.seq_counter += 1
        rec.status, rec.finished_at, rec.completed_seq = status, utcnow(), run.seq_counter
        if output is not None or status in DONE_STEP:
            rec.output = output
        if error is not None:
            rec.error = error
        elif not keep_error and status == StepStatus.COMPLETED:
            rec.error = None
        await self._persist(run)

    # ------------------------------------------------------------------ compensación (saga)
    def _needs_compensation(self, rec: StepRecord, step: StepDef) -> bool:
        """Pasos con efectos confirmados (COMPLETED) o de resultado desconocido (cancelados / fallo transitorio)."""
        if not step.compensate or rec.attempts == 0 or rec.compensation == CompensationStatus.DONE:
            return False
        if rec.status == StepStatus.COMPLETED:
            return True
        if rec.status == StepStatus.CANCELLED:
            return True  # estaba en vuelo: puede haber efecto parcial
        # FAILED/FALLBACK: solo si el fallo fue transitorio (p. ej. timeout tras enviar la petición)
        return rec.error is not None and rec.error.retryable

    async def _compensate(self, run: RunRecord, defn: WorkflowDef, ctx: FlowContext) -> tuple[bool, bool]:
        """Devuelve (se_compensó_algo, todo_correcto). Orden inverso de finalización; continúa pese a fallos."""
        steps = {s.id: s for s in defn.steps}
        targets = [r for r in run.steps.values() if self._needs_compensation(r, steps[r.step_id])]
        targets.sort(key=lambda r: r.completed_seq or 0, reverse=True)
        all_ok, did = True, False
        for rec in targets:
            step = steps[rec.step_id]
            did = True
            ok = await self._compensate_step(run, step, rec, ctx)
            all_ok = all_ok and ok
        # los que ya estaban compensados (reanudación) cuentan como trabajo hecho
        did = did or any(r.compensation == CompensationStatus.DONE for r in run.steps.values())
        all_ok = all_ok and not any(r.compensation == CompensationStatus.FAILED for r in run.steps.values() if r not in targets)
        return did, all_ok

    async def _compensate_step(self, run: RunRecord, step: StepDef, rec: StepRecord, ctx: FlowContext) -> bool:
        fn = self.registry.get(step.compensate)  # type: ignore[arg-type]
        policy = RetryPolicy(max_attempts=self._comp_attempts, backoff_base_s=step.retry.backoff_base_s, backoff_max_s=step.retry.backoff_max_s)
        await self._emit(run, "compensation.started", step.id, {"task": step.compensate})
        last = "desconocido"
        for attempt in range(1, policy.max_attempts + 1):
            si = StepInput(
                ctx=ctx.for_step(step.id),
                step_id=step.id,
                attempt=attempt,
                params=step.params,
                inputs={"output": rec.output},
                run_input=run.input,
                idempotency_key=f"{run.run_id}:{step.id}:compensate",
            )
            try:
                async with asyncio.timeout(step.timeout_s):
                    await fn(si)
                rec.compensation = CompensationStatus.DONE
                await self._persist(run)
                await self._emit(run, "compensation.completed", step.id, {"attempt": attempt})
                return True
            except asyncio.CancelledError:
                raise
            except Exception as e:
                last = redact_text(f"{type(e).__name__}: {e}")
                if attempt < policy.max_attempts:
                    await self._sleep(self._delay(policy, attempt, RetryableError(last)))
        rec.compensation = CompensationStatus.FAILED
        await self._persist(run)
        await self._emit(run, "compensation.failed", step.id, {"error": last})
        return False

    # ------------------------------------------------------------------ persistencia y auditoría
    async def _persist(self, run: RunRecord) -> None:
        lock = self._locks.setdefault(run.run_id, asyncio.Lock())
        async with lock:
            run.updated_at = utcnow()
            await self.store.save_run(run)

    async def _emit(self, run: RunRecord, type_: str, step_id: str | None = None, data: dict[str, Any] | None = None) -> None:
        event = RunEvent(
            run_id=run.run_id,
            tenant_id=run.tenant_id,
            request_id=run.request_id,
            type=type_,
            step_id=step_id,
            data=redact(data or {}),
        )
        event = await self.store.append_event(event)
        log.info(
            type_,
            extra={"request_id": run.request_id, "tenant_id": run.tenant_id, "run_id": run.run_id, "step_id": step_id, "seq": event.seq},
        )

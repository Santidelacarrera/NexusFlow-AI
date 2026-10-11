import asyncio

import pytest

from nexusflow_engine import dag
from nexusflow_engine.engine import TooManyActiveRuns, WorkflowEngine
from nexusflow_engine.errors import DefinitionError, PermanentError, RetryableError
from nexusflow_engine.models import RetryPolicy, RunStatus, StepDef, StepStatus, WorkflowDef
from nexusflow_engine.rag_workflow import definition
from nexusflow_engine.registry import TaskRegistry
from nexusflow_engine.store import InMemoryStore, SqliteStore

from .fakes import DRAFT

pytestmark = pytest.mark.anyio
T, R = "tenant-a", "req-0001"
REPLAY = "replay-guard-alpha"  # constante: un literal junto a «key=» lo marcaría gitleaks como credencial


async def run_rag(engine, question="¿Plazo de devolución?", docs=None, **kw):
    run, _ = await engine.start(
        "rag_validated_query", tenant_id=T, request_id=R, run_input={"question": question, "documents": docs or [{"name": "politica.pdf"}]}, **kw
    )
    await engine.wait(run.run_id)
    return await engine.get_run(T, run.run_id)


def types(events):
    return [e.type for e in events]


# ------------------------------------------------------------------ validación estática
def sd(id, deps=(), **kw):
    return StepDef(id=id, task="t", depends_on=list(deps), **kw)


def test_dag_rejects_cycles_missing_deps_and_bad_fallbacks():
    with pytest.raises(DefinitionError, match="ciclo"):
        dag.validate(WorkflowDef(name="w", steps=[sd("a", ["b"]), sd("b", ["a"])]))
    with pytest.raises(DefinitionError, match="no existe"):
        dag.validate(WorkflowDef(name="w", steps=[sd("a", ["zz"])]))
    with pytest.raises(DefinitionError, match="sí mismo"):
        dag.validate(WorkflowDef(name="w", steps=[sd("a", ["a"])]))
    with pytest.raises(DefinitionError, match="fallback_only"):
        dag.validate(WorkflowDef(name="w", steps=[sd("a", fallback="b"), sd("b")]))
    with pytest.raises(DefinitionError, match="ninguno|ningún"):
        dag.validate(WorkflowDef(name="w", steps=[sd("a"), sd("b", fallback_only=True)]))
    with pytest.raises(DefinitionError, match="no puede depender del paso fallback_only"):
        dag.validate(WorkflowDef(name="w", steps=[sd("a", fallback="b"), sd("b", fallback_only=True), sd("c", ["b"])]))
    with pytest.raises(DefinitionError, match="no registrada"):
        dag.validate(WorkflowDef(name="w", steps=[sd("a")]), task_names={"otra"})


def test_engine_refuses_to_start_with_unregistered_task():
    with pytest.raises(DefinitionError):
        WorkflowEngine(InMemoryStore(), TaskRegistry(), [definition()])


# ------------------------------------------------------------------ camino feliz y trazabilidad
async def test_happy_path_and_trace_propagation(make_engine):
    engine, fakes = make_engine()
    run = await run_rag(engine)
    assert run.status == RunStatus.COMPLETED
    assert run.output["respond"] == {"status": "answered", "answer": DRAFT, "citations": ["p1"], "delivery_id": "D-1"}
    assert all(s.status == StepStatus.COMPLETED for s in run.steps.values() if s.step_id not in {"retrieve_lexical", "escalate_human"})

    events = await engine.store.list_events(T, run.run_id)
    assert [e.seq for e in events] == list(range(1, len(events) + 1))
    assert {(e.request_id, e.tenant_id, e.run_id) for e in events} == {(R, T, run.run_id)}
    assert types(events)[0] == "run.created" and types(events)[-1] == "run.completed"

    # Cada servicio aguas abajo recibe la misma traza + clave de idempotencia estable por paso.
    for svc, op, step in [(fakes.parser, "parse", "ingest"), (fakes.rag, "retrieve", "retrieve"), (fakes.consensus, "validate", "consensus"), (fakes.delivery, "send", "respond")]:
        h = svc.ops(op)[0].headers
        assert h["X-Request-Id"] == R and h["X-Tenant-Id"] == T and h["X-Run-Id"] == run.run_id and h["X-Step-Id"] == step
        assert h["Idempotency-Key"] == f"{run.run_id}:{step}"


async def test_steps_run_in_dependency_order(make_engine):
    engine, _ = make_engine()
    run = await run_rag(engine)
    started = [e.step_id for e in await engine.store.list_events(T, run.run_id) if e.type == "step.started"]
    assert started == ["ingest", "retrieve", "consensus", "respond"]


# ------------------------------------------------------------------ reintentos y rutas alternativas
async def test_transient_503_is_retried_with_exponential_backoff(make_engine, sleeps):
    engine, fakes = make_engine()
    fakes.rag.script = [RetryableError("503"), RetryableError("503")]
    run = await run_rag(engine)
    assert run.status == RunStatus.COMPLETED
    assert run.steps["retrieve"].attempts == 3 and run.steps["retrieve"].status == StepStatus.COMPLETED
    retries = [e for e in await engine.store.list_events(T, run.run_id) if e.type == "step.retry"]
    assert len(retries) == 2
    assert sleeps == [0.5, 1.0]  # base 0.5 · 2^(n-1), con jitter fijado a 1.0


async def test_retry_after_header_is_respected(make_engine, sleeps):
    engine, fakes = make_engine()
    fakes.rag.script = [RetryableError("429", retry_after_s=4)]
    await run_rag(engine)
    assert sleeps == [4]


async def test_persistent_rag_503_falls_back_to_lexical_route(make_engine):
    engine, fakes = make_engine()
    fakes.rag.script = [RetryableError("503")] * 4  # agota los 4 intentos del paso principal
    run = await run_rag(engine)
    assert run.status == RunStatus.COMPLETED
    assert run.steps["retrieve"].status == StepStatus.FALLBACK and run.steps["retrieve"].used_fallback == "retrieve_lexical"
    assert run.steps["retrieve"].output["mode"] == "lexical"
    assert [c.args["mode"] for c in fakes.rag.ops("retrieve")] == ["hybrid"] * 4 + ["lexical"]
    assert run.output["respond"]["status"] == "answered"


async def test_committee_rejection_escalates_and_never_leaks_the_unvalidated_draft(make_engine):
    engine, fakes = make_engine()
    fakes.consensus.script = [{"verdict": "rejected", "score": 0.2, "reasons": ["cita inexistente"]}]
    run = await run_rag(engine)
    assert run.status == RunStatus.COMPLETED
    assert run.steps["consensus"].status == StepStatus.FALLBACK and run.steps["consensus"].error.kind == "rejected"
    assert run.steps["consensus"].attempts == 1  # un rechazo no es transitorio: no se reintenta
    assert fakes.escalation.ops("open")[0].args["reasons"] == ["cita inexistente"]
    assert run.output["respond"] == {"status": "pending_human_review", "ticket_id": "T-1", "delivery_id": "D-1"}
    sent = fakes.delivery.ops("send")[0].args
    assert "answer" not in sent and DRAFT not in str(sent)  # fail-closed


async def test_committee_outage_also_fails_closed_to_human_review(make_engine):
    engine, fakes = make_engine()
    fakes.consensus.script = [RetryableError("503"), RetryableError("503")]
    run = await run_rag(engine)
    assert run.steps["consensus"].status == StepStatus.FALLBACK and run.steps["consensus"].attempts == 2
    assert run.output["respond"]["status"] == "pending_human_review"


async def test_permanent_error_is_not_retried(make_engine):
    engine, fakes = make_engine()
    fakes.rag.script = [PermanentError("400")]
    fakes.rag.default = lambda op, a: (_ for _ in ()).throw(PermanentError("400"))  # el fallback también falla
    run = await run_rag(engine)
    assert run.steps["retrieve"].attempts == 1
    assert run.status == RunStatus.COMPENSATED


# ------------------------------------------------------------------ saga: compensación
async def test_terminal_failure_compensates_completed_work(make_engine):
    engine, fakes = make_engine()
    fakes.rag.default = lambda op, a: (_ for _ in ()).throw(RetryableError("503"))  # ni la ruta léxica responde
    run = await run_rag(engine)
    assert run.status == RunStatus.COMPENSATED
    assert run.error.kind == "retryable"
    assert fakes.parser.ops("unstage")[0].args == ["doc-1"]
    assert fakes.delivery.calls == []  # nada llegó al cliente
    assert run.steps["ingest"].compensation == "DONE"
    assert run.steps["consensus"].status == StepStatus.PENDING  # nunca se ejecutó
    ev = types(await engine.store.list_events(T, run.run_id))
    assert ev[-4:] == ["run.compensating", "compensation.started", "compensation.completed", "run.compensated"]


async def test_compensation_runs_in_reverse_completion_order_and_closes_escalation(make_engine):
    engine, fakes = make_engine()
    fakes.consensus.script = [{"verdict": "rejected", "reasons": ["x"]}]
    fakes.delivery.default = lambda op, a: (_ for _ in ()).throw(PermanentError("destino rechaza"))
    run = await run_rag(engine)
    assert run.status == RunStatus.COMPENSATED
    comp = [e.step_id for e in await engine.store.list_events(T, run.run_id) if e.type == "compensation.completed"]
    assert comp == ["escalate_human", "ingest"]
    assert fakes.escalation.ops("close")[0].args == "T-1"


async def test_failed_compensation_is_retried_then_reported_without_blocking_the_rest(make_engine):
    engine, fakes = make_engine()
    fakes.rag.default = lambda op, a: (_ for _ in ()).throw(PermanentError("boom"))
    fakes.parser.script = [{"document_ids": ["doc-1"]}] + [RuntimeError("storage caído")] * 3
    run = await run_rag(engine)
    assert run.status == RunStatus.COMPENSATION_FAILED  # requiere intervención humana
    assert len(fakes.parser.ops("unstage")) == 3 and run.steps["ingest"].compensation == "FAILED"
    assert "run.compensation_failed" in types(await engine.store.list_events(T, run.run_id))


async def test_failure_without_side_effects_is_plain_failed():
    reg = TaskRegistry()

    async def boom(si):
        raise PermanentError("nope")

    reg.register("boom", boom)
    engine = WorkflowEngine(InMemoryStore(), reg, [WorkflowDef(name="w", steps=[StepDef(id="a", task="boom")])])
    run, _ = await engine.start("w", tenant_id=T, request_id=R, run_input={})
    await engine.wait(run.run_id)
    assert (await engine.get_run(T, run.run_id)).status == RunStatus.FAILED


async def test_secrets_never_reach_events():
    reg = TaskRegistry()

    async def leak(si):
        raise PermanentError("fallo con Bearer abcdefghijklmnop1234", details={"api_key": "sk-secret", "reasons": ["ok"]})

    reg.register("leak", leak)
    engine = WorkflowEngine(InMemoryStore(), reg, [WorkflowDef(name="w", steps=[StepDef(id="a", task="leak")])])
    run, _ = await engine.start("w", tenant_id=T, request_id=R, run_input={})
    await engine.wait(run.run_id)
    dump = " ".join(e.model_dump_json() for e in await engine.store.list_events(T, run.run_id))
    assert "abcdefghijklmnop1234" not in dump and "sk-secret" not in dump and "[REDACTED]" in dump


# ------------------------------------------------------------------ tiempo, paralelismo, cancelación
def custom_engine(steps, tasks, store=None, **kw):
    reg = TaskRegistry()
    for name, fn in tasks.items():
        reg.register(name, fn)
    return WorkflowEngine(store or InMemoryStore(), reg, [WorkflowDef(name="w", steps=steps)], **kw)


async def test_step_timeout_is_retried_then_fails():
    calls = []

    async def slow(si):
        calls.append(si.attempt)
        await asyncio.sleep(5)

    async def sleep0(_):
        await asyncio.sleep(0)

    engine = custom_engine(
        [StepDef(id="a", task="slow", timeout_s=0.05, retry=RetryPolicy(max_attempts=2, backoff_base_s=0))], {"slow": slow}, sleep=sleep0
    )
    run, _ = await engine.start("w", tenant_id=T, request_id=R, run_input={})
    await engine.wait(run.run_id)
    run = await engine.get_run(T, run.run_id)
    assert calls == [1, 2] and run.status == RunStatus.FAILED and "timeout" in run.error.message


async def test_independent_steps_run_in_parallel():
    gate = asyncio.Event()
    started = []

    async def task(si):
        started.append(si.step_id)
        if len(started) == 2:
            gate.set()
        await asyncio.wait_for(gate.wait(), 2)  # solo avanza si el otro paso arrancó a la vez
        return si.step_id

    async def join(si):
        return sorted(si.inputs)

    engine = custom_engine(
        [StepDef(id="a", task="t"), StepDef(id="b", task="t"), StepDef(id="c", task="join", depends_on=["a", "b"])],
        {"t": task, "join": join},
    )
    run, _ = await engine.start("w", tenant_id=T, request_id=R, run_input={})
    await engine.wait(run.run_id)
    run = await engine.get_run(T, run.run_id)
    assert run.status == RunStatus.COMPLETED and run.output == {"c": ["a", "b"]}


async def test_cancel_stops_in_flight_step_and_compensates_completed_ones():
    undone, entered = [], asyncio.Event()

    async def make(si):
        return {"id": "created"}

    async def undo(si):
        undone.append(si.inputs["output"])

    async def hang(si):
        entered.set()
        await asyncio.sleep(30)

    engine = custom_engine(
        [StepDef(id="a", task="make", compensate="undo"), StepDef(id="b", task="hang", depends_on=["a"])],
        {"make": make, "undo": undo, "hang": hang},
    )
    run, _ = await engine.start("w", tenant_id=T, request_id=R, run_input={})
    await asyncio.wait_for(entered.wait(), 2)
    await engine.cancel(T, run.run_id)
    await engine.cancel(T, run.run_id)  # idempotente
    await engine.wait(run.run_id)
    run = await engine.get_run(T, run.run_id)
    assert run.status == RunStatus.CANCELLED and run.steps["b"].status == StepStatus.CANCELLED
    assert undone == [{"id": "created"}]
    ev = types(await engine.store.list_events(T, run.run_id))
    assert ev.count("run.cancel_requested") == 1 and ev[-1] == "run.cancelled"


# ------------------------------------------------------------------ idempotencia y límites
async def test_start_is_idempotent_per_tenant(make_engine):
    engine, fakes = make_engine()
    r1, c1 = await engine.start("rag_validated_query", tenant_id=T, request_id=R, run_input={"question": "q"}, idempotency_key=REPLAY)
    r2, c2 = await engine.start("rag_validated_query", tenant_id=T, request_id="otro-req", run_input={"question": "q"}, idempotency_key=REPLAY)
    other, c3 = await engine.start("rag_validated_query", tenant_id="tenant-b", request_id=R, run_input={"question": "q"}, idempotency_key=REPLAY)
    assert (c1, c2, c3) == (True, False, True) and r1.run_id == r2.run_id != other.run_id
    await engine.wait(r1.run_id)
    await engine.wait(other.run_id)
    assert len(fakes.delivery.calls) == 2  # una ejecución por tenant, no tres


async def test_per_tenant_active_run_limit(make_engine):
    engine, _ = make_engine(max_active_runs_per_tenant=1)
    run, _ = await engine.start("rag_validated_query", tenant_id=T, request_id=R, run_input={"question": "q"})
    with pytest.raises(TooManyActiveRuns):
        await engine.start("rag_validated_query", tenant_id=T, request_id=R, run_input={"question": "q"})
    await engine.start("rag_validated_query", tenant_id="tenant-b", request_id=R, run_input={"question": "q"})  # otro tenant, otro cupo
    await engine.wait(run.run_id)


# ------------------------------------------------------------------ reinicio del proceso
async def test_run_survives_restart_and_resumes_without_repeating_completed_steps(tmp_path):
    calls: dict[str, int] = {}
    keys: list[str] = []
    entered, release = asyncio.Event(), asyncio.Event()

    async def first(si):
        calls["a"] = calls.get("a", 0) + 1
        return {"v": 1}

    async def second(si):
        calls["b"] = calls.get("b", 0) + 1
        keys.append(si.idempotency_key)
        if calls["b"] == 1:
            entered.set()
            await release.wait()  # el proceso muere aquí
        return {"v": si.inputs["a"]["v"] + 1}

    steps = [StepDef(id="a", task="first"), StepDef(id="b", task="second", depends_on=["a"])]
    db = str(tmp_path / "orch.db")
    e1 = custom_engine(steps, {"first": first, "second": second}, store=SqliteStore(db))
    run, _ = await e1.start("w", tenant_id=T, request_id=R, run_input={})
    await asyncio.wait_for(entered.wait(), 2)
    await e1.shutdown()  # SIGTERM / caída: el último checkpoint queda en disco

    store2 = SqliteStore(db)  # «proceso nuevo»
    persisted = await store2.get_run(T, run.run_id)
    assert persisted.status == RunStatus.RUNNING and persisted.steps["a"].status == StepStatus.COMPLETED
    assert persisted.steps["b"].status == StepStatus.RUNNING

    e2 = custom_engine(steps, {"first": first, "second": second}, store=store2)
    assert await e2.recover() == 1
    await e2.wait(run.run_id)
    done = await e2.get_run(T, run.run_id)
    assert done.status == RunStatus.COMPLETED and done.output == {"b": {"v": 2}} and done.resume_count == 1
    assert calls == {"a": 1, "b": 2}  # `a` no se repitió (checkpoint); `b` se reintentó
    assert keys == [f"{run.run_id}:b"] * 2  # misma clave: el servicio externo puede deduplicar
    ev = types(await store2.list_events(T, run.run_id))
    assert "run.resumed" in ev and ev[-1] == "run.completed"

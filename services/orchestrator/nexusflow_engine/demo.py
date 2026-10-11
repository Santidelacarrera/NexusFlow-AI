"""Demostración sin infraestructura: `python -m nexusflow_engine.demo`.

Ejecuta el workflow `rag_validated_query` contra servicios simulados en cuatro escenarios y muestra el rastro de
auditoría (cada línea lleva request_id y tenant_id).
"""
from __future__ import annotations

import asyncio
from typing import Any

from .engine import WorkflowEngine
from .errors import RetryableError
from .rag_workflow import Services, build_registry, definition
from .store import InMemoryStore

DRAFT = "El plazo de devolución es de 30 días [p1]."


class Sim:
    """Servicios simulados. `plan` encola comportamientos por operación: excepción → se lanza; dict → se devuelve."""

    def __init__(self, plan: dict[str, list]):
        self.plan = {k: list(v) for k, v in plan.items()}

    def _next(self, op: str, default: Any) -> Any:
        item = self.plan.get(op, []).pop(0) if self.plan.get(op) else default
        if isinstance(item, Exception):
            raise item
        return item

    async def parse(self, si, documents):
        return self._next("parse", {"document_ids": ["doc-1"]})

    async def unstage(self, si, ids):
        print(f"      · unstage({ids}) con Idempotency-Key={si.idempotency_key}")

    async def retrieve(self, si, question, document_ids, mode):
        return self._next("retrieve", {"passages": [{"id": "p1"}], "draft_answer": DRAFT, "citations": ["p1"]})

    async def validate(self, si, question, draft_answer, passages):
        return self._next("validate", {"verdict": "approved", "score": 0.93, "answer": draft_answer})

    async def open(self, si, question, draft_answer, reasons):
        return {"ticket_id": "T-42"}

    async def close(self, si, ticket_id):
        print(f"      · cierra escalación {ticket_id}")

    async def send(self, si, payload):
        return self._next("send", {"delivery_id": "D-1"})


async def scenario(title: str, plan: dict[str, list]) -> None:
    print(f"\n=== {title}")

    async def fast_sleep(_: float) -> None:
        await asyncio.sleep(0)

    sim = Sim(plan)
    engine = WorkflowEngine(
        InMemoryStore(),
        build_registry(Services(parser=sim, rag=sim, consensus=sim, escalation=sim, delivery=sim)),
        [definition()],
        sleep=fast_sleep,
    )
    run, _ = await engine.start(
        "rag_validated_query",
        tenant_id="acme",
        request_id="req-demo-001",
        run_input={"question": "¿Plazo de devolución?", "documents": [{"name": "politica.pdf"}]},
    )
    await engine.wait(run.run_id)
    run = await engine.get_run("acme", run.run_id)
    for e in await engine.store.list_events("acme", run.run_id):
        step = f" [{e.step_id}]" if e.step_id else ""
        extra = {k: v for k, v in e.data.items() if k in {"attempt", "fallback", "next_in_s", "reason"}}
        print(f"  #{e.seq:02d} {e.request_id}/{e.tenant_id} {e.type}{step} {extra or ''}")
    print(f"  → {run.status}  salida: {run.output}")


async def main() -> None:
    await scenario("1. Camino feliz", {})
    await scenario("2. El RAG devuelve 503 dos veces: reintento con backoff", {"retrieve": [RetryableError("503"), RetryableError("503")]})
    await scenario(
        "3. El comité rechaza el borrador: ruta alternativa a revisión humana (fail-closed)",
        {"validate": [{"verdict": "rejected", "score": 0.2, "reasons": ["cita inexistente"]}]},
    )
    await scenario(
        "4. Entrega imposible tras escalar: compensación saga en orden inverso",
        {"validate": [{"verdict": "rejected", "reasons": ["x"]}], "send": [RuntimeError("destino caído")]},
    )


if __name__ == "__main__":
    asyncio.run(main())

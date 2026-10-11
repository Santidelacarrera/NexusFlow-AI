"""Workflow de ejemplo: consulta RAG validada por un comité de agentes.

    ingest ──► retrieve ──► consensus ──► respond
                 │ 503 persistente   │ rechazo / comité caído
                 ▼                   ▼
          retrieve_lexical      escalate_human        (rutas alternativas; su salida sustituye a la del paso)

Invariante de seguridad (fail-closed): al cliente nunca llega un borrador que el comité no haya aprobado.
Saga: `ingest` se deshace (`unstage`) y la escalación abierta se cierra si el run no puede completarse.
"""
from __future__ import annotations

from dataclasses import dataclass
from typing import Any, Protocol

from .errors import PermanentError, RejectedError
from .models import RetryPolicy, StepDef, WorkflowDef
from .registry import StepInput, TaskRegistry

WORKFLOW_NAME = "rag_validated_query"


class DocumentParser(Protocol):
    async def parse(self, si: StepInput, documents: list[dict[str, Any]]) -> dict[str, Any]: ...
    async def unstage(self, si: StepInput, document_ids: list[str]) -> None: ...


class ContextRag(Protocol):
    async def retrieve(self, si: StepInput, question: str, document_ids: list[str], mode: str) -> dict[str, Any]: ...


class Consensus(Protocol):
    async def validate(self, si: StepInput, question: str, draft_answer: str, passages: list[dict[str, Any]]) -> dict[str, Any]: ...


class Escalation(Protocol):
    async def open(self, si: StepInput, question: str, draft_answer: str, reasons: list[str]) -> dict[str, Any]: ...
    async def close(self, si: StepInput, ticket_id: str) -> None: ...


class Delivery(Protocol):
    async def send(self, si: StepInput, payload: dict[str, Any]) -> dict[str, Any]: ...


@dataclass
class Services:
    parser: DocumentParser
    rag: ContextRag
    consensus: Consensus
    escalation: Escalation
    delivery: Delivery


def definition() -> WorkflowDef:
    return WorkflowDef(
        name=WORKFLOW_NAME,
        version=1,
        steps=[
            StepDef(
                id="ingest",
                task="ingest.parse",
                compensate="ingest.unstage",
                retry=RetryPolicy(max_attempts=3, backoff_base_s=0.5),
                timeout_s=60,
            ),
            StepDef(
                id="retrieve",
                task="rag.retrieve",
                depends_on=["ingest"],
                retry=RetryPolicy(max_attempts=4, backoff_base_s=0.5, backoff_max_s=8),
                timeout_s=20,
                fallback="retrieve_lexical",
            ),
            StepDef(
                id="retrieve_lexical",
                task="rag.retrieve",
                params={"mode": "lexical"},
                fallback_only=True,
                retry=RetryPolicy(max_attempts=2, backoff_base_s=0.5),
                timeout_s=20,
            ),
            StepDef(
                id="consensus",
                task="consensus.validate",
                depends_on=["retrieve"],
                retry=RetryPolicy(max_attempts=2, backoff_base_s=1),
                timeout_s=45,
                fallback="escalate_human",
            ),
            StepDef(
                id="escalate_human",
                task="human.escalate",
                compensate="human.close_escalation",
                fallback_only=True,
                retry=RetryPolicy(max_attempts=3, backoff_base_s=0.5),
                timeout_s=15,
            ),
            StepDef(
                id="respond",
                task="respond.client",
                depends_on=["consensus"],
                retry=RetryPolicy(max_attempts=3, backoff_base_s=0.5),
                timeout_s=15,
            ),
        ],
    )


def build_registry(svc: Services) -> TaskRegistry:
    reg = TaskRegistry()

    @reg.task("ingest.parse")
    async def ingest_parse(si: StepInput) -> dict[str, Any]:
        docs = si.run_input.get("documents") or []
        if not docs:
            return {"document_ids": []}
        return await svc.parser.parse(si, docs)

    @reg.task("ingest.unstage")
    async def ingest_unstage(si: StepInput) -> None:
        ids = (si.inputs.get("output") or {}).get("document_ids") or []
        if ids:  # compensación idempotente: sin salida previa no hay nada que deshacer
            await svc.parser.unstage(si, ids)

    @reg.task("rag.retrieve")
    async def rag_retrieve(si: StepInput) -> dict[str, Any]:
        ids = si.inputs.get("ingest", {}).get("document_ids", [])
        mode = si.params.get("mode", "hybrid")
        out = await svc.rag.retrieve(si, si.run_input["question"], ids, mode)
        if not isinstance(out.get("draft_answer"), str) or not isinstance(out.get("passages"), list):
            raise PermanentError("respuesta del RAG sin draft_answer/passages")
        return {**out, "mode": mode}

    @reg.task("consensus.validate")
    async def consensus_validate(si: StepInput) -> dict[str, Any]:
        draft = si.inputs["retrieve"]
        verdict = await svc.consensus.validate(si, si.run_input["question"], draft["draft_answer"], draft["passages"])
        if verdict.get("verdict") != "approved":
            raise RejectedError(
                "el comité de agentes rechazó el borrador",
                details={"reasons": verdict.get("reasons", []), "score": verdict.get("score")},
            )
        return {
            "status": "approved",
            "answer": verdict.get("answer", draft["draft_answer"]),
            "score": verdict.get("score"),
            "citations": draft.get("citations", []),
            "retrieval_mode": draft.get("mode"),
        }

    @reg.task("human.escalate")
    async def human_escalate(si: StepInput) -> dict[str, Any]:
        draft = si.inputs["retrieve"]
        failure = si.failure or {}
        reasons = failure.get("details", {}).get("reasons") or [failure.get("message", "validación no disponible")]
        ticket = await svc.escalation.open(si, si.run_input["question"], draft["draft_answer"], [str(r) for r in reasons])
        return {"status": "pending_human_review", "ticket_id": ticket["ticket_id"], "reason": failure.get("kind")}

    @reg.task("human.close_escalation")
    async def human_close(si: StepInput) -> None:
        ticket_id = (si.inputs.get("output") or {}).get("ticket_id")
        if ticket_id:
            await svc.escalation.close(si, ticket_id)

    @reg.task("respond.client")
    async def respond_client(si: StepInput) -> dict[str, Any]:
        verdict = si.inputs["consensus"]
        if verdict.get("status") == "approved":
            result = {"status": "answered", "answer": verdict["answer"], "citations": verdict.get("citations", [])}
        else:  # ruta alternativa: nunca se envía el borrador sin validar
            result = {"status": "pending_human_review", "ticket_id": verdict.get("ticket_id")}
        delivery = await svc.delivery.send(si, result)
        return {**result, "delivery_id": delivery.get("delivery_id")}

    return reg

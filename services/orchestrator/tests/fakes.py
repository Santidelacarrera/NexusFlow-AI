"""Servicios simulados y programables: registran cada llamada (con las cabeceras de traza) y fallan a demanda."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Callable

DRAFT = "El plazo de devolución es de 30 días [p1]."


@dataclass
class Call:
    op: str
    headers: dict[str, str]
    attempt: int
    args: Any


@dataclass
class Scripted:
    """Cola de comportamientos: una excepción se lanza; cualquier otro valor se devuelve."""

    default: Callable[[str, Any], Any]
    script: list = field(default_factory=list)
    calls: list[Call] = field(default_factory=list)

    def next(self, op: str, si, args) -> Any:
        self.calls.append(Call(op, si.headers(), si.attempt, args))
        item = self.script.pop(0) if self.script else self.default(op, args)
        if isinstance(item, Exception):
            raise item
        return item

    def ops(self, op: str) -> list[Call]:
        return [c for c in self.calls if c.op == op]


class FakeParser(Scripted):
    async def parse(self, si, documents):
        return self.next("parse", si, documents)

    async def unstage(self, si, document_ids):
        return self.next("unstage", si, document_ids)


class FakeRag(Scripted):
    async def retrieve(self, si, question, document_ids, mode):
        return self.next("retrieve", si, {"question": question, "document_ids": document_ids, "mode": mode})


class FakeConsensus(Scripted):
    async def validate(self, si, question, draft_answer, passages):
        return self.next("validate", si, {"draft_answer": draft_answer})


class FakeEscalation(Scripted):
    async def open(self, si, question, draft_answer, reasons):
        return self.next("open", si, {"reasons": reasons})

    async def close(self, si, ticket_id):
        return self.next("close", si, ticket_id)


class FakeDelivery(Scripted):
    async def send(self, si, payload):
        return self.next("send", si, payload)


def _defaults(op: str, args: Any) -> Any:
    return {
        "parse": {"document_ids": ["doc-1"], "chunks": 3},
        "unstage": None,
        "retrieve": {"passages": [{"id": "p1", "text": "30 días", "score": 0.9}], "draft_answer": DRAFT, "citations": ["p1"]},
        "validate": {"verdict": "approved", "score": 0.93, "answer": DRAFT},
        "open": {"ticket_id": "T-1"},
        "close": None,
        "send": {"delivery_id": "D-1"},
    }[op]


class FakeServices:
    def __init__(self) -> None:
        self.parser, self.rag, self.consensus = FakeParser(_defaults), FakeRag(_defaults), FakeConsensus(_defaults)
        self.escalation, self.delivery = FakeEscalation(_defaults), FakeDelivery(_defaults)

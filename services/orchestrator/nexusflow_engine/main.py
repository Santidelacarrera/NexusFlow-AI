"""Arranque: `uvicorn nexusflow_engine.main:app`. Toda la configuración llega por entorno."""
from __future__ import annotations

import json
import logging
import os

from .api import create_app
from .clients import (
    HttpConsensus,
    HttpContextRag,
    HttpDelivery,
    HttpDocumentParser,
    HttpEscalation,
    ServiceClient,
)
from .engine import WorkflowEngine
from .rag_workflow import Services, build_registry, definition
from .store import SqliteStore


class JsonFormatter(logging.Formatter):
    FIELDS = ("request_id", "tenant_id", "run_id", "step_id", "seq")

    def format(self, record: logging.LogRecord) -> str:
        doc = {"ts": self.formatTime(record), "level": record.levelname, "msg": record.getMessage(), "logger": record.name}
        doc.update({k: getattr(record, k) for k in self.FIELDS if hasattr(record, k)})
        if record.exc_info:
            doc["exc"] = self.formatException(record.exc_info)
        return json.dumps(doc, ensure_ascii=False)


def _require(name: str) -> str:
    value = os.environ.get(name, "")
    if not value:
        raise RuntimeError(f"Falta la variable de entorno {name}")
    return value


def build_app():
    handler = logging.StreamHandler()
    handler.setFormatter(JsonFormatter())
    logging.getLogger("nexusflow").addHandler(handler)
    logging.getLogger("nexusflow").setLevel(logging.INFO)

    svc_token = os.environ.get("DOWNSTREAM_TOKEN") or None
    mk = lambda var: ServiceClient(_require(var), token=svc_token)  # noqa: E731
    rag, consensus, parser, escalation = mk("CONTEXT_RAG_URL"), mk("CONSENSUS_URL"), mk("DOCUMENT_PARSER_URL"), mk("ESCALATION_URL")
    delivery = mk("DELIVERY_URL")
    services = Services(
        parser=HttpDocumentParser(parser),
        rag=HttpContextRag(rag),
        consensus=HttpConsensus(consensus),
        escalation=HttpEscalation(escalation),
        delivery=HttpDelivery(delivery),
    )
    engine = WorkflowEngine(
        SqliteStore(os.environ.get("ORCHESTRATOR_DB", "/data/orchestrator.db")),
        build_registry(services),
        [definition()],
        max_active_runs_per_tenant=int(os.environ.get("MAX_ACTIVE_RUNS_PER_TENANT", "20")),
    )
    return create_app(engine, token=_require("ORCHESTRATOR_TOKEN"))


app = build_app()

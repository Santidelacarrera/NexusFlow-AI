"""Contexto de trazabilidad: `X-Request-Id` + `tenant_id` viajan en cada transición, log y llamada saliente."""
from __future__ import annotations

import re
import uuid
from contextvars import ContextVar, Token
from dataclasses import dataclass, replace

REQUEST_ID_HEADER = "X-Request-Id"
TENANT_HEADER = "X-Tenant-Id"
RUN_ID_HEADER = "X-Run-Id"
STEP_ID_HEADER = "X-Step-Id"
IDEMPOTENCY_HEADER = "Idempotency-Key"

# Solo caracteres seguros: los ids acaban en logs y cabeceras (evita inyección de líneas).
_SAFE_ID = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$")


def new_request_id() -> str:
    return uuid.uuid4().hex


def sanitize_request_id(value: str | None) -> str:
    """Respeta el id entrante si es seguro; si no, genera uno nuevo."""
    return value if value and _SAFE_ID.match(value) else new_request_id()


def validate_tenant(value: str | None) -> str:
    if not value or not _SAFE_ID.match(value):
        raise ValueError("tenant_id ausente o con formato no válido")
    return value


@dataclass(frozen=True)
class FlowContext:
    request_id: str
    tenant_id: str
    run_id: str | None = None
    step_id: str | None = None

    def for_step(self, step_id: str) -> "FlowContext":
        return replace(self, step_id=step_id)

    def headers(self, idempotency_key: str | None = None) -> dict[str, str]:
        """Cabeceras para propagar la traza a servicios aguas abajo."""
        out = {REQUEST_ID_HEADER: self.request_id, TENANT_HEADER: self.tenant_id}
        if self.run_id:
            out[RUN_ID_HEADER] = self.run_id
        if self.step_id:
            out[STEP_ID_HEADER] = self.step_id
        if idempotency_key:
            out[IDEMPOTENCY_HEADER] = idempotency_key
        return out

    def log_fields(self) -> dict[str, str | None]:
        return {
            "request_id": self.request_id,
            "tenant_id": self.tenant_id,
            "run_id": self.run_id,
            "step_id": self.step_id,
        }


_current: ContextVar[FlowContext | None] = ContextVar("nexusflow_flow_context", default=None)


def bind(ctx: FlowContext) -> Token:
    return _current.set(ctx)


def unbind(token: Token) -> None:
    _current.reset(token)


def current() -> FlowContext | None:
    return _current.get()

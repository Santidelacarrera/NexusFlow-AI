"""Modelos de definición (datos puros, serializables) y de estado persistido."""
from __future__ import annotations

from datetime import datetime, timezone
from enum import StrEnum
from typing import Any

from pydantic import BaseModel, ConfigDict, Field

ID_PATTERN = r"^[a-z][a-z0-9_]{0,63}$"


def utcnow() -> datetime:
    return datetime.now(timezone.utc)


class RetryPolicy(BaseModel):
    model_config = ConfigDict(extra="forbid")
    max_attempts: int = Field(1, ge=1, le=10)
    backoff_base_s: float = Field(0.5, ge=0, le=60)
    backoff_max_s: float = Field(30, ge=0, le=600)


class StepDef(BaseModel):
    model_config = ConfigDict(extra="forbid")
    id: str = Field(pattern=ID_PATTERN)
    task: str = Field(min_length=1, max_length=100)
    depends_on: list[str] = Field(default_factory=list, max_length=50)
    params: dict[str, Any] = Field(default_factory=dict)
    retry: RetryPolicy = Field(default_factory=RetryPolicy)
    timeout_s: float = Field(30, gt=0, le=600)
    # Tarea que deshace los efectos de este paso (saga). Debe ser idempotente.
    compensate: str | None = None
    # Paso alternativo: si éste falla definitivamente, se ejecuta y su salida lo sustituye.
    fallback: str | None = Field(default=None, pattern=ID_PATTERN)
    # Los pasos fallback_only solo se alcanzan vía `fallback`, nunca por dependencias.
    fallback_only: bool = False


class WorkflowDef(BaseModel):
    model_config = ConfigDict(extra="forbid")
    name: str = Field(pattern=ID_PATTERN)
    version: int = Field(1, ge=1)
    steps: list[StepDef] = Field(min_length=1, max_length=200)


class StepStatus(StrEnum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    COMPLETED = "COMPLETED"
    FALLBACK = "FALLBACK"  # falló, pero lo sustituyó su ruta alternativa
    FAILED = "FAILED"
    CANCELLED = "CANCELLED"


class CompensationStatus(StrEnum):
    DONE = "DONE"
    FAILED = "FAILED"


class RunStatus(StrEnum):
    PENDING = "PENDING"
    RUNNING = "RUNNING"
    COMPENSATING = "COMPENSATING"
    COMPLETED = "COMPLETED"
    FAILED = "FAILED"  # falló y no había nada que compensar
    COMPENSATED = "COMPENSATED"  # falló y se deshicieron los efectos
    COMPENSATION_FAILED = "COMPENSATION_FAILED"  # requiere intervención humana
    CANCELLED = "CANCELLED"


ACTIVE_RUN = {RunStatus.PENDING, RunStatus.RUNNING, RunStatus.COMPENSATING}
DONE_STEP = {StepStatus.COMPLETED, StepStatus.FALLBACK}


class StepFailure(BaseModel):
    kind: str
    message: str
    retryable: bool = False
    details: dict[str, Any] = Field(default_factory=dict)  # p. ej. motivos del rechazo del comité


class StepRecord(BaseModel):
    step_id: str
    status: StepStatus = StepStatus.PENDING
    attempts: int = 0
    output: Any = None
    error: StepFailure | None = None
    used_fallback: str | None = None
    started_at: datetime | None = None
    finished_at: datetime | None = None
    completed_seq: int | None = None  # orden de finalización: la compensación va en orden inverso
    compensation: CompensationStatus | None = None


class RunRecord(BaseModel):
    run_id: str
    tenant_id: str
    request_id: str
    workflow: str
    version: int
    status: RunStatus = RunStatus.PENDING
    input: dict[str, Any] = Field(default_factory=dict)
    steps: dict[str, StepRecord] = Field(default_factory=dict)
    output: dict[str, Any] | None = None
    error: StepFailure | None = None
    idempotency_key: str | None = None
    cancel_requested: bool = False
    resume_count: int = 0
    seq_counter: int = 0
    created_at: datetime = Field(default_factory=utcnow)
    updated_at: datetime = Field(default_factory=utcnow)


class RunEvent(BaseModel):
    """Entrada append-only del rastro de auditoría. Todas llevan `request_id` y `tenant_id`."""

    seq: int = 0
    ts: datetime = Field(default_factory=utcnow)
    run_id: str
    tenant_id: str
    request_id: str
    type: str
    step_id: str | None = None
    data: dict[str, Any] = Field(default_factory=dict)

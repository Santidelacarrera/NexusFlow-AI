"""Taxonomía de errores: decide si un paso se reintenta, escala a una ruta alternativa o compensa."""
from __future__ import annotations


class WorkflowError(Exception):
    """Base de todos los errores del motor."""


class DefinitionError(WorkflowError):
    """La definición del workflow no es válida (se detecta antes de ejecutar nada)."""


class StepError(WorkflowError):
    retryable = False
    kind = "permanent"

    def __init__(self, message: str, *, details: dict | None = None):
        super().__init__(message)
        self.details = details or {}


class RetryableError(StepError):
    """Fallo transitorio (503, timeout, 429): se reintenta con backoff."""

    retryable = True
    kind = "retryable"

    def __init__(self, message: str, *, retry_after_s: float | None = None, details: dict | None = None):
        super().__init__(message, details=details)
        self.retry_after_s = retry_after_s


class PermanentError(StepError):
    """Fallo que no mejora reintentando (4xx, datos inválidos)."""


class RejectedError(PermanentError):
    """El comité de agentes rechazó el borrador: no es un fallo técnico, es una decisión de negocio."""

    kind = "rejected"


class RunCancelled(WorkflowError):
    pass

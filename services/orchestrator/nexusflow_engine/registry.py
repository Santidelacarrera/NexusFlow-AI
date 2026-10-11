"""Registro de tareas: el workflow referencia tareas por nombre; el código las implementa."""
from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Awaitable, Callable

from .context import FlowContext


@dataclass(frozen=True)
class StepInput:
    ctx: FlowContext
    step_id: str
    attempt: int
    params: dict[str, Any]
    inputs: dict[str, Any]  # salida de cada dependencia, por id de paso
    run_input: dict[str, Any]
    idempotency_key: str  # estable entre reintentos y reanudaciones: `run_id:step_id`
    failure: dict[str, Any] | None = None  # solo en pasos fallback: por qué falló el original
    extra: dict[str, Any] = field(default_factory=dict)

    def headers(self) -> dict[str, str]:
        return self.ctx.headers(self.idempotency_key)


TaskFn = Callable[[StepInput], Awaitable[Any]]


class TaskRegistry:
    def __init__(self) -> None:
        self._tasks: dict[str, TaskFn] = {}

    def register(self, name: str, fn: TaskFn) -> None:
        if name in self._tasks:
            raise ValueError(f"tarea duplicada: {name}")
        self._tasks[name] = fn

    def task(self, name: str) -> Callable[[TaskFn], TaskFn]:
        def deco(fn: TaskFn) -> TaskFn:
            self.register(name, fn)
            return fn

        return deco

    def get(self, name: str) -> TaskFn:
        return self._tasks[name]

    def names(self) -> set[str]:
        return set(self._tasks)

"""Validación estática del workflow: se rechaza antes de ejecutar cualquier paso."""
from __future__ import annotations

from collections import defaultdict, deque

from .errors import DefinitionError
from .models import WorkflowDef


def validate(defn: WorkflowDef, task_names: set[str] | None = None) -> list[str]:
    """Valida y devuelve un orden topológico de los pasos regulares (excluye fallback_only)."""
    steps = {s.id: s for s in defn.steps}
    if len(steps) != len(defn.steps):
        raise DefinitionError("ids de paso duplicados")

    fallback_targets: dict[str, str] = {}
    for s in defn.steps:
        for dep in s.depends_on:
            if dep not in steps:
                raise DefinitionError(f"{s.id}: depende de «{dep}», que no existe")
            if dep == s.id:
                raise DefinitionError(f"{s.id}: no puede depender de sí mismo")
            if steps[dep].fallback_only:
                raise DefinitionError(f"{s.id}: no puede depender del paso fallback_only «{dep}»")
        if s.fallback:
            fb = steps.get(s.fallback)
            if fb is None:
                raise DefinitionError(f"{s.id}: fallback «{s.fallback}» no existe")
            if not fb.fallback_only:
                raise DefinitionError(f"{s.id}: el fallback «{fb.id}» debe declararse fallback_only")
            if fb.depends_on or fb.fallback:
                raise DefinitionError(f"{fb.id}: un paso fallback no puede tener dependencias ni su propio fallback")
            if s.fallback_only:
                raise DefinitionError(f"{s.id}: un paso fallback no puede encadenar otro fallback")
            if s.fallback in fallback_targets:
                raise DefinitionError(f"{s.fallback}: es fallback de dos pasos a la vez")
            fallback_targets[s.fallback] = s.id
    for s in defn.steps:
        if s.fallback_only and s.id not in fallback_targets:
            raise DefinitionError(f"{s.id}: paso fallback_only que ningún paso referencia")

    if task_names is not None:
        for s in defn.steps:
            for name in filter(None, (s.task, s.compensate)):
                if name not in task_names:
                    raise DefinitionError(f"{s.id}: tarea «{name}» no registrada")

    regular = [s for s in defn.steps if not s.fallback_only]
    if not regular:
        raise DefinitionError("el workflow no tiene pasos regulares")
    indeg = {s.id: len(s.depends_on) for s in regular}
    children: dict[str, list[str]] = defaultdict(list)
    for s in regular:
        for dep in s.depends_on:
            children[dep].append(s.id)
    queue = deque(sorted(i for i, d in indeg.items() if d == 0))
    order: list[str] = []
    while queue:
        node = queue.popleft()
        order.append(node)
        for child in sorted(children[node]):
            indeg[child] -= 1
            if indeg[child] == 0:
                queue.append(child)
    if len(order) != len(regular):
        cyc = sorted(i for i, d in indeg.items() if d > 0)
        raise DefinitionError(f"ciclo detectado entre: {', '.join(cyc)}")
    return order


def leaves(defn: WorkflowDef) -> list[str]:
    """Pasos regulares de los que nadie depende: su salida es la del workflow."""
    needed = {dep for s in defn.steps for dep in s.depends_on}
    return [s.id for s in defn.steps if not s.fallback_only and s.id not in needed]

"""Evita que credenciales lleguen a eventos, logs o mensajes de error."""
from __future__ import annotations

import re
from typing import Any

_SENSITIVE_KEY = re.compile(r"(token|secret|password|passwd|authorization|api[-_]?key|credential|cookie)", re.I)
_BEARER = re.compile(r"(?i)\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}")
_MAX_DEPTH = 6
_MAX_STR = 2000


def redact_text(text: str) -> str:
    return _BEARER.sub(r"\1 [REDACTED]", text)[:_MAX_STR]


def redact(value: Any, depth: int = 0) -> Any:
    if depth > _MAX_DEPTH:
        return "[TRUNCATED]"
    if isinstance(value, dict):
        return {
            str(k): "[REDACTED]" if _SENSITIVE_KEY.search(str(k)) else redact(v, depth + 1)
            for k, v in value.items()
        }
    if isinstance(value, (list, tuple)):
        return [redact(v, depth + 1) for v in value[:100]]
    if isinstance(value, str):
        return redact_text(value)
    return value

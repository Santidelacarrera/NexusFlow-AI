"""Adaptadores HTTP a los servicios del ecosistema. Propagan `X-Request-Id` / `X-Tenant-Id` / `Idempotency-Key`.

Los contratos de endpoint (`/v1/parse`, `/v1/retrieve`, `/v1/consensus`…) son una SUPOSICIÓN documentada en
docs/ORCHESTRATOR.md: se ajustan en un único sitio (este fichero) cuando se conozcan los reales.
"""
from __future__ import annotations

from typing import Any

import httpx

from .errors import PermanentError, RetryableError
from .registry import StepInput

_RETRYABLE_STATUS = {408, 425, 429, 500, 502, 503, 504}


class ServiceClient:
    def __init__(self, base_url: str, *, token: str | None = None, http: httpx.AsyncClient | None = None, timeout_s: float = 20):
        self._base = base_url.rstrip("/")
        self._token = token
        self._http = http or httpx.AsyncClient(timeout=timeout_s, follow_redirects=False)

    async def aclose(self) -> None:
        await self._http.aclose()

    async def post(self, path: str, si: StepInput, payload: dict[str, Any]) -> dict[str, Any]:
        headers = si.headers()
        if self._token:
            headers["Authorization"] = f"Bearer {self._token}"
        try:
            resp = await self._http.post(self._base + path, json=payload, headers=headers)
        except httpx.TimeoutException as e:
            raise RetryableError(f"timeout llamando a {path}") from e
        except httpx.TransportError as e:
            raise RetryableError(f"error de red llamando a {path}: {type(e).__name__}") from e
        if resp.status_code in _RETRYABLE_STATUS:
            retry_after = resp.headers.get("Retry-After", "")
            raise RetryableError(
                f"{path} respondió {resp.status_code}",
                retry_after_s=float(retry_after) if retry_after.isdigit() else None,
            )
        if resp.status_code >= 400:
            # El cuerpo del error no se reenvía: podría contener datos del tenant.
            raise PermanentError(f"{path} respondió {resp.status_code}")
        try:
            data = resp.json()
        except ValueError as e:
            raise PermanentError(f"{path} devolvió JSON no válido") from e
        if not isinstance(data, dict):
            raise PermanentError(f"{path} devolvió un cuerpo inesperado")
        return data


class HttpDocumentParser:
    def __init__(self, client: ServiceClient):
        self._c = client

    async def parse(self, si: StepInput, documents: list[dict[str, Any]]) -> dict[str, Any]:
        return await self._c.post("/v1/parse", si, {"documents": documents})

    async def unstage(self, si: StepInput, document_ids: list[str]) -> None:
        await self._c.post("/v1/documents/unstage", si, {"document_ids": document_ids})


class HttpContextRag:
    def __init__(self, client: ServiceClient):
        self._c = client

    async def retrieve(self, si: StepInput, question: str, document_ids: list[str], mode: str) -> dict[str, Any]:
        return await self._c.post("/v1/retrieve", si, {"question": question, "document_ids": document_ids, "mode": mode})


class HttpConsensus:
    def __init__(self, client: ServiceClient):
        self._c = client

    async def validate(self, si: StepInput, question: str, draft_answer: str, passages: list[dict[str, Any]]) -> dict[str, Any]:
        return await self._c.post(
            "/v1/consensus", si, {"question": question, "draft_answer": draft_answer, "passages": passages}
        )


class HttpEscalation:
    def __init__(self, client: ServiceClient):
        self._c = client

    async def open(self, si: StepInput, question: str, draft_answer: str, reasons: list[str]) -> dict[str, Any]:
        return await self._c.post("/v1/escalations", si, {"question": question, "draft_answer": draft_answer, "reasons": reasons})

    async def close(self, si: StepInput, ticket_id: str) -> None:
        await self._c.post("/v1/escalations/close", si, {"ticket_id": ticket_id, "reason": "run compensado"})


class HttpDelivery:
    def __init__(self, client: ServiceClient):
        self._c = client

    async def send(self, si: StepInput, payload: dict[str, Any]) -> dict[str, Any]:
        return await self._c.post("/v1/responses", si, payload)

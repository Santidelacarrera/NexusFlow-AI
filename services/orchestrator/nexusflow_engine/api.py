"""API HTTP del orquestador. Cada petición lleva `X-Request-Id` (se genera si falta) y `X-Tenant-Id`.

Seguridad: token de servicio (el orquestador es interno, lo llama el gateway que ya autenticó al usuario y fija
`X-Tenant-Id`); aislamiento por tenant en toda lectura (un run ajeno responde 404, no 403, para no revelar su existencia).
"""

import asyncio
import json
import re
import secrets
from contextlib import asynccontextmanager
from typing import Annotated, Any

from fastapi import Depends, FastAPI, Header, HTTPException, Query, Request, Response
from fastapi.responses import JSONResponse, StreamingResponse

from .context import (
    IDEMPOTENCY_HEADER,
    REQUEST_ID_HEADER,
    TENANT_HEADER,
    FlowContext,
    sanitize_request_id,
    validate_tenant,
)
from .engine import RunNotFound, TooManyActiveRuns, UnknownWorkflow, WorkflowEngine
from .models import ACTIVE_RUN, RunRecord, RunStatus
from .redact import redact

MAX_BODY_BYTES = 256 * 1024
_IDEM = re.compile(r"^[A-Za-z0-9._:-]{8,128}$")
_RUN_ID = r"^[a-f0-9]{32}$"


def create_app(engine: WorkflowEngine, *, token: str, stream_poll_s: float = 0.2, stream_max_s: float = 300) -> FastAPI:
    if len(token) < 32:
        raise RuntimeError("ORCHESTRATOR_TOKEN debe tener al menos 32 caracteres")

    @asynccontextmanager
    async def lifespan(_: FastAPI):
        await engine.recover()  # reanuda lo que un proceso anterior dejó a medias
        yield
        await engine.shutdown()

    app = FastAPI(title="NexusFlow Orchestrator", docs_url=None, redoc_url=None, openapi_url=None, lifespan=lifespan)

    @app.middleware("http")
    async def trace(request: Request, call_next):
        request.state.request_id = sanitize_request_id(request.headers.get(REQUEST_ID_HEADER))
        response = await call_next(request)
        response.headers[REQUEST_ID_HEADER] = request.state.request_id
        return response

    @app.exception_handler(HTTPException)
    async def http_error(request: Request, exc: HTTPException):
        return JSONResponse(
            {"detail": exc.detail, "request_id": request.state.request_id}, status_code=exc.status_code, headers=exc.headers
        )

    def flow_context(
        request: Request,
        authorization: Annotated[str | None, Header()] = None,
        x_tenant_id: Annotated[str | None, Header(alias=TENANT_HEADER)] = None,
    ) -> FlowContext:
        if not authorization or not secrets.compare_digest(authorization, f"Bearer {token}"):
            raise HTTPException(401, "No autorizado", headers={"WWW-Authenticate": "Bearer"})
        try:
            tenant = validate_tenant(x_tenant_id)
        except ValueError as e:
            raise HTTPException(400, str(e)) from e
        return FlowContext(request_id=request.state.request_id, tenant_id=tenant)

    Ctx = Annotated[FlowContext, Depends(flow_context)]

    def view(run: RunRecord) -> dict[str, Any]:
        doc = run.model_dump(mode="json", exclude={"idempotency_key", "seq_counter"})
        doc["input"] = redact(doc["input"])
        return doc

    async def own_run(ctx: FlowContext, run_id: str) -> RunRecord:
        if not re.match(_RUN_ID, run_id):
            raise HTTPException(404, "Run no encontrado")
        run = await engine.get_run(ctx.tenant_id, run_id)
        if run is None:
            raise HTTPException(404, "Run no encontrado")
        return run

    @app.get("/healthz")
    async def healthz():
        return {"status": "ok"}

    @app.get("/v1/workflows")
    async def workflows(_: Ctx):
        return [{"name": d.name, "version": d.version, "steps": [s.id for s in d.steps]} for d in engine.workflows()]

    @app.post("/v1/workflows/{name}/runs", status_code=202)
    async def start_run(
        name: str,
        request: Request,
        response: Response,
        ctx: Ctx,
        idempotency_key: Annotated[str | None, Header(alias=IDEMPOTENCY_HEADER)] = None,
    ):
        raw = await request.body()
        if len(raw) > MAX_BODY_BYTES:
            raise HTTPException(413, "Cuerpo demasiado grande")
        try:
            body = json.loads(raw or b"{}")
        except ValueError as e:
            raise HTTPException(422, "JSON no válido") from e
        run_input = body.get("input") if isinstance(body, dict) else None
        if not isinstance(run_input, dict):
            raise HTTPException(422, "Se esperaba {\"input\": {...}}")
        if idempotency_key is not None and not _IDEM.match(idempotency_key):
            raise HTTPException(400, "Idempotency-Key no válida")
        try:
            run, created = await engine.start(
                name, tenant_id=ctx.tenant_id, request_id=ctx.request_id, run_input=run_input, idempotency_key=idempotency_key
            )
        except UnknownWorkflow:
            raise HTTPException(404, "Workflow no encontrado") from None
        except TooManyActiveRuns:
            raise HTTPException(429, "Demasiados runs activos para este tenant", headers={"Retry-After": "5"}) from None
        if not created:
            response.status_code = 200  # repetición idempotente: devuelve el run original
        return {"run_id": run.run_id, "status": run.status, "request_id": run.request_id, "created": created}

    @app.get("/v1/runs")
    async def list_runs(ctx: Ctx, status: RunStatus | None = None, limit: Annotated[int, Query(ge=1, le=100)] = 50):
        runs = await engine.store.list_runs(ctx.tenant_id, status, limit)
        return [
            {"run_id": r.run_id, "workflow": r.workflow, "status": r.status, "request_id": r.request_id, "created_at": r.created_at}
            for r in runs
        ]

    @app.get("/v1/runs/{run_id}")
    async def get_run(run_id: str, ctx: Ctx):
        return view(await own_run(ctx, run_id))

    @app.get("/v1/runs/{run_id}/events")
    async def events(run_id: str, ctx: Ctx, after: Annotated[int, Query(ge=0)] = 0):
        await own_run(ctx, run_id)
        return [e.model_dump(mode="json") for e in await engine.store.list_events(ctx.tenant_id, run_id, after)]

    @app.get("/v1/runs/{run_id}/stream")
    async def stream(run_id: str, ctx: Ctx, after: Annotated[int, Query(ge=0)] = 0):
        """Server-Sent Events con la auditoría en tiempo real; termina cuando el run es terminal."""
        await own_run(ctx, run_id)

        async def gen():
            seq, waited = after, 0.0
            while waited <= stream_max_s:
                batch = await engine.store.list_events(ctx.tenant_id, run_id, seq)
                for ev in batch:
                    seq = ev.seq
                    yield f"id: {ev.seq}\nevent: {ev.type}\ndata: {ev.model_dump_json()}\n\n"
                if not batch:
                    run = await engine.get_run(ctx.tenant_id, run_id)
                    if run is None or run.status not in ACTIVE_RUN:
                        return
                    await asyncio.sleep(stream_poll_s)
                    waited += stream_poll_s

        return StreamingResponse(gen(), media_type="text/event-stream", headers={"Cache-Control": "no-store"})

    @app.post("/v1/runs/{run_id}/cancel", status_code=202)
    async def cancel(run_id: str, ctx: Ctx):
        await own_run(ctx, run_id)
        try:
            run = await engine.cancel(ctx.tenant_id, run_id)
        except RunNotFound:
            raise HTTPException(404, "Run no encontrado") from None
        return {"run_id": run.run_id, "status": run.status, "cancel_requested": run.cancel_requested}

    return app

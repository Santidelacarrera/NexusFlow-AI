import os
import secrets
from datetime import datetime
from typing import Annotated

from fastapi import Depends, FastAPI, Header, HTTPException
from pydantic import BaseModel, Field
from starlette.concurrency import run_in_threadpool

from model import score, train

TOKEN = os.environ.get("ML_SERVICE_TOKEN", "")
if len(TOKEN) < 32:
    raise RuntimeError("ML_SERVICE_TOKEN debe tener al menos 32 caracteres")

app = FastAPI(title="NexusFlow Predictive", docs_url=None, redoc_url=None, openapi_url=None)


@app.middleware("http")
async def limit_body(request, call_next):
    from starlette.responses import JSONResponse
    size = 0
    chunks = []
    async for chunk in request.stream():
        size += len(chunk)
        if size > 12 * 1024 * 1024:
            return JSONResponse({"detail": "Cuerpo demasiado grande"}, status_code=413)
        chunks.append(chunk)
    request._body = b"".join(chunks)
    return await call_next(request)


def authorize(authorization: Annotated[str | None, Header()] = None):
    if not authorization or not secrets.compare_digest(authorization, f"Bearer {TOKEN}"):
        raise HTTPException(401, "No autorizado")


class Customer(BaseModel):
    customerId: str = Field(min_length=1, max_length=100)
    recencyDays: float = Field(ge=0, le=20000, allow_inf_nan=False)
    frequency: int = Field(ge=1, le=1000000)
    monetary: float = Field(ge=0, le=1e14, allow_inf_nan=False)


class ScoreBody(BaseModel):
    orgId: str = Field(min_length=1, max_length=100)
    customers: list[Customer] = Field(min_length=1, max_length=10000)


class Transaction(BaseModel):
    customerId: str = Field(min_length=1, max_length=100)
    amount: float = Field(gt=0, le=100000000, allow_inf_nan=False)
    occurredAt: datetime


class TrainBody(BaseModel):
    orgId: str = Field(min_length=1, max_length=100)
    asOf: datetime
    transactions: list[Transaction] = Field(min_length=1, max_length=100000)


@app.get("/health")
def health():
    return {"status": "ok"}


@app.post("/score", dependencies=[Depends(authorize)])
async def score_route(body: ScoreBody):
    return await run_in_threadpool(score, body.orgId, [c.model_dump() for c in body.customers])


@app.post("/train", dependencies=[Depends(authorize)])
async def train_route(body: TrainBody):
    try:
        return await run_in_threadpool(train, body.orgId, [t.model_dump(mode="json") for t in body.transactions], body.asOf.isoformat())
    except ValueError as error:
        raise HTTPException(422, str(error)) from error

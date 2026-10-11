import asyncio
import json

import httpx
import pytest

from nexusflow_engine.api import create_app

pytestmark = pytest.mark.anyio
TOKEN = "t" * 40
AUTH = {"Authorization": f"Bearer {TOKEN}"}
A = {**AUTH, "X-Tenant-Id": "tenant-a"}
B = {**AUTH, "X-Tenant-Id": "tenant-b"}
BODY = {"input": {"question": "¿Plazo de devolución?", "documents": [{"name": "politica.pdf"}]}}


@pytest.fixture
async def env(make_engine):
    engine, fakes = make_engine()
    app = create_app(engine, token=TOKEN, stream_poll_s=0.01)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://orch") as client:
        yield client, engine, fakes


async def start(client, engine, headers=A, body=BODY, **extra):
    r = await client.post("/v1/workflows/rag_validated_query/runs", json=body, headers={**headers, **extra})
    assert r.status_code in (200, 202), r.text
    await engine.wait(r.json()["run_id"])
    return r


async def test_requires_service_token_and_valid_tenant(env):
    client, _, _ = env
    assert (await client.get("/v1/runs", headers={"X-Tenant-Id": "tenant-a"})).status_code == 401
    assert (await client.get("/v1/runs", headers={"Authorization": "Bearer " + "x" * 40, "X-Tenant-Id": "tenant-a"})).status_code == 401
    assert (await client.get("/v1/runs", headers=AUTH)).status_code == 400
    assert (await client.get("/v1/runs", headers={**AUTH, "X-Tenant-Id": "../etc/passwd"})).status_code == 400
    assert (await client.get("/healthz")).status_code == 200


async def test_request_id_is_echoed_generated_and_sanitized(env):
    client, engine, _ = env
    r = await start(client, engine, headers={**A, "X-Request-Id": "req-abc-123"})
    assert r.headers["X-Request-Id"] == "req-abc-123" and r.json()["request_id"] == "req-abc-123"
    generated = (await client.get("/v1/runs", headers=A)).headers["X-Request-Id"]
    assert len(generated) == 32
    hostile = (await client.get("/v1/runs", headers={**A, "X-Request-Id": "a b;<script>"})).headers["X-Request-Id"]
    assert hostile != "a b;<script>" and len(hostile) == 32  # no se refleja un id no seguro (inyección en logs)
    err = await client.get("/v1/runs/" + "0" * 32, headers={**A, "X-Request-Id": "req-err-1"})
    assert err.status_code == 404 and err.json()["request_id"] == "req-err-1"


async def test_full_run_through_http_with_audit_trail(env):
    client, engine, fakes = env
    r = await start(client, engine, headers={**A, "X-Request-Id": "req-e2e-1"})
    assert r.status_code == 202
    run_id = r.json()["run_id"]
    run = (await client.get(f"/v1/runs/{run_id}", headers=A)).json()
    assert run["status"] == "COMPLETED" and run["output"]["respond"]["status"] == "answered"
    events = (await client.get(f"/v1/runs/{run_id}/events", headers=A)).json()
    assert {(e["request_id"], e["tenant_id"]) for e in events} == {("req-e2e-1", "tenant-a")}
    tail = (await client.get(f"/v1/runs/{run_id}/events?after={events[-3]['seq']}", headers=A)).json()
    assert [e["seq"] for e in tail] == [events[-2]["seq"], events[-1]["seq"]]
    assert fakes.rag.ops("retrieve")[0].headers["X-Request-Id"] == "req-e2e-1"  # la traza llegó al servicio aguas abajo


async def test_tenant_isolation_returns_404_not_403(env):
    client, engine, _ = env
    run_id = (await start(client, engine, headers=A)).json()["run_id"]
    for method, path in [("GET", f"/v1/runs/{run_id}"), ("GET", f"/v1/runs/{run_id}/events"), ("GET", f"/v1/runs/{run_id}/stream"), ("POST", f"/v1/runs/{run_id}/cancel")]:
        r = await client.request(method, path, headers=B)
        assert r.status_code == 404, (method, path)
    assert (await client.get("/v1/runs", headers=B)).json() == []
    assert len((await client.get("/v1/runs", headers=A)).json()) == 1
    assert (await client.get(f"/v1/runs/{run_id}", headers=A)).json()["status"] == "COMPLETED"  # el ajeno no lo tocó


async def test_idempotency_key_replays_the_same_run(env):
    client, engine, fakes = env
    r1 = await start(client, engine, **{"Idempotency-Key": "order-2026-0001"})
    r2 = await client.post("/v1/workflows/rag_validated_query/runs", json=BODY, headers={**A, "Idempotency-Key": "order-2026-0001"})
    assert r1.status_code == 202 and r2.status_code == 200
    assert r2.json()["run_id"] == r1.json()["run_id"] and r2.json()["created"] is False
    assert len(fakes.delivery.calls) == 1
    bad = await client.post("/v1/workflows/rag_validated_query/runs", json=BODY, headers={**A, "Idempotency-Key": "x"})
    assert bad.status_code == 400


async def test_input_validation_and_unknown_workflow(env):
    client, _, _ = env
    assert (await client.post("/v1/workflows/nope/runs", json=BODY, headers=A)).status_code == 404
    assert (await client.post("/v1/workflows/rag_validated_query/runs", json={"input": "no-objeto"}, headers=A)).status_code == 422
    assert (await client.post("/v1/workflows/rag_validated_query/runs", content=b"{no json", headers=A)).status_code == 422
    big = {"input": {"question": "x" * (300 * 1024)}}
    assert (await client.post("/v1/workflows/rag_validated_query/runs", json=big, headers=A)).status_code == 413
    assert (await client.get("/v1/runs/not-a-run-id", headers=A)).status_code == 404


async def test_credentials_in_run_input_are_redacted_in_responses(env):
    client, engine, _ = env
    r = await start(client, engine, body={"input": {"question": "q", "api_key": "sk-live-123", "nested": {"password": "hunter2"}}})
    run = (await client.get(f"/v1/runs/{r.json()['run_id']}", headers=A)).json()
    assert "sk-live-123" not in json.dumps(run) and "hunter2" not in json.dumps(run)


async def test_active_run_limit_returns_429(make_engine):
    engine, fakes = make_engine(max_active_runs_per_tenant=1)
    gate = asyncio.Event()

    async def blocked(si, question, document_ids, mode):  # el primer run sigue activo mientras llega el segundo
        await gate.wait()
        return fakes.rag.default("retrieve", None)

    fakes.rag.retrieve = blocked
    app = create_app(engine, token=TOKEN)
    async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app), base_url="http://orch") as client:
        first = await client.post("/v1/workflows/rag_validated_query/runs", json=BODY, headers=A)
        second = await client.post("/v1/workflows/rag_validated_query/runs", json=BODY, headers=A)
        other = await client.post("/v1/workflows/rag_validated_query/runs", json=BODY, headers=B)
        assert (first.status_code, second.status_code, other.status_code) == (202, 429, 202)
        assert second.headers["Retry-After"] == "5"
        gate.set()
        await engine.wait(first.json()["run_id"])
        await engine.wait(other.json()["run_id"])


async def test_sse_stream_delivers_the_audit_trail_until_the_run_ends(env):
    client, engine, _ = env
    r = await client.post("/v1/workflows/rag_validated_query/runs", json=BODY, headers={**A, "X-Request-Id": "req-sse-1"})
    run_id = r.json()["run_id"]
    resp = await client.get(f"/v1/runs/{run_id}/stream", headers=A)  # termina solo cuando el run es terminal
    assert resp.headers["content-type"].startswith("text/event-stream")
    names = [l.removeprefix("event: ") for l in resp.text.splitlines() if l.startswith("event: ")]
    assert names[0] == "run.created" and names[-1] == "run.completed"
    payloads = [json.loads(l.removeprefix("data: ")) for l in resp.text.splitlines() if l.startswith("data: ")]
    assert {p["request_id"] for p in payloads} == {"req-sse-1"}


async def test_cancel_endpoint_on_finished_run_is_a_noop(env):
    client, engine, _ = env
    run_id = (await start(client, engine)).json()["run_id"]
    r = await client.post(f"/v1/runs/{run_id}/cancel", headers=A)
    assert r.status_code == 202 and r.json()["status"] == "COMPLETED"

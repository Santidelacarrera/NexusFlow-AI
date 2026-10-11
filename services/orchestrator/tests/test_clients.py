import httpx
import pytest

from nexusflow_engine.clients import HttpConsensus, ServiceClient
from nexusflow_engine.context import FlowContext
from nexusflow_engine.errors import PermanentError, RetryableError
from nexusflow_engine.registry import StepInput

pytestmark = pytest.mark.anyio


def si():
    ctx = FlowContext("req-77", "tenant-a", "run-1", "consensus")
    return StepInput(ctx=ctx, step_id="consensus", attempt=1, params={}, inputs={}, run_input={}, idempotency_key="run-1:consensus")


def client(handler):
    return ServiceClient("http://svc", token="svc-token-123456", http=httpx.AsyncClient(transport=httpx.MockTransport(handler)))


async def test_propagates_trace_headers_and_service_token():
    seen = {}

    def handler(request):
        seen.update(request.headers)
        return httpx.Response(200, json={"verdict": "approved"})

    out = await HttpConsensus(client(handler)).validate(si(), "q", "borrador", [])
    assert out == {"verdict": "approved"}
    assert seen["x-request-id"] == "req-77" and seen["x-tenant-id"] == "tenant-a"
    assert seen["x-run-id"] == "run-1" and seen["x-step-id"] == "consensus" and seen["idempotency-key"] == "run-1:consensus"
    assert seen["authorization"] == "Bearer svc-token-123456"


@pytest.mark.parametrize("status", [429, 500, 502, 503, 504])
async def test_transient_statuses_are_retryable_and_honor_retry_after(status):
    c = client(lambda r: httpx.Response(status, headers={"Retry-After": "2"}, text="detalle interno con datos del tenant"))
    with pytest.raises(RetryableError) as e:
        await c.post("/v1/x", si(), {})
    assert e.value.retry_after_s == 2 and "datos del tenant" not in str(e.value)


@pytest.mark.parametrize("status", [400, 401, 403, 404, 422])
async def test_client_errors_are_permanent(status):
    with pytest.raises(PermanentError) as e:
        await client(lambda r: httpx.Response(status, text="secreto")).post("/v1/x", si(), {})
    assert not isinstance(e.value, RetryableError) and "secreto" not in str(e.value)


async def test_network_failures_and_garbage_bodies():
    def timeout(request):
        raise httpx.ReadTimeout("lento", request=request)

    def refused(request):
        raise httpx.ConnectError("rechazado", request=request)

    for h in (timeout, refused):
        with pytest.raises(RetryableError):
            await client(h).post("/v1/x", si(), {})
    with pytest.raises(PermanentError):
        await client(lambda r: httpx.Response(200, text="no es json")).post("/v1/x", si(), {})
    with pytest.raises(PermanentError):
        await client(lambda r: httpx.Response(200, json=[1, 2])).post("/v1/x", si(), {})

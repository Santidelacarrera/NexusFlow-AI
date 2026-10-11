import asyncio

import pytest

from nexusflow_engine.engine import WorkflowEngine
from nexusflow_engine.rag_workflow import Services, build_registry, definition
from nexusflow_engine.store import InMemoryStore

from .fakes import FakeServices


@pytest.fixture
def anyio_backend():
    return "asyncio"


@pytest.fixture
def sleeps():
    return []


@pytest.fixture
def make_engine(sleeps):
    """Motor con el workflow RAG y servicios simulados; el backoff no espera de verdad pero se registra."""

    async def fake_sleep(seconds: float) -> None:
        sleeps.append(seconds)
        await asyncio.sleep(0)

    def factory(store=None, **kw):
        fakes = FakeServices()
        services = Services(parser=fakes.parser, rag=fakes.rag, consensus=fakes.consensus, escalation=fakes.escalation, delivery=fakes.delivery)
        engine = WorkflowEngine(
            store or InMemoryStore(), build_registry(services), [definition()], sleep=fake_sleep, jitter=lambda: 1.0, **kw
        )
        return engine, fakes

    return factory

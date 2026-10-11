"""Puerto de persistencia (`StateStore`) y dos implementaciones.

- `InMemoryStore`: pruebas y desarrollo.
- `SqliteStore`: un único fichero; el estado sobrevive a reinicios del proceso.

El esquema es deliberadamente simple (documento JSON por run + eventos append-only) para poder portarlo
a PostgreSQL con la misma forma que usa el motor TypeScript. Aislamiento: toda lectura exige `tenant_id`.
"""
from __future__ import annotations

import asyncio
import sqlite3
import threading
from typing import Protocol

from .models import ACTIVE_RUN, RunEvent, RunRecord, RunStatus


class StateStore(Protocol):
    async def create_run(self, run: RunRecord) -> tuple[RunRecord, bool]: ...
    async def get_run(self, tenant_id: str, run_id: str) -> RunRecord | None: ...
    async def save_run(self, run: RunRecord) -> None: ...
    async def append_event(self, event: RunEvent) -> RunEvent: ...
    async def list_events(self, tenant_id: str, run_id: str, after: int = 0, limit: int = 500) -> list[RunEvent]: ...
    async def list_runs(self, tenant_id: str, status: RunStatus | None = None, limit: int = 50) -> list[RunRecord]: ...
    async def count_active(self, tenant_id: str) -> int: ...
    async def list_active(self) -> list[RunRecord]: ...


class InMemoryStore:
    def __init__(self) -> None:
        self._runs: dict[tuple[str, str], str] = {}
        self._idem: dict[tuple[str, str], str] = {}
        self._events: dict[tuple[str, str], list[str]] = {}
        self._lock = asyncio.Lock()

    async def create_run(self, run: RunRecord) -> tuple[RunRecord, bool]:
        async with self._lock:
            if run.idempotency_key:
                existing = self._idem.get((run.tenant_id, run.idempotency_key))
                if existing:
                    return RunRecord.model_validate_json(self._runs[(run.tenant_id, existing)]), False
                self._idem[(run.tenant_id, run.idempotency_key)] = run.run_id
            self._runs[(run.tenant_id, run.run_id)] = run.model_dump_json()
            self._events[(run.tenant_id, run.run_id)] = []
            return run.model_copy(deep=True), True

    async def get_run(self, tenant_id: str, run_id: str) -> RunRecord | None:
        doc = self._runs.get((tenant_id, run_id))
        return RunRecord.model_validate_json(doc) if doc else None

    async def save_run(self, run: RunRecord) -> None:
        async with self._lock:
            self._runs[(run.tenant_id, run.run_id)] = run.model_dump_json()

    async def append_event(self, event: RunEvent) -> RunEvent:
        async with self._lock:
            log = self._events.setdefault((event.tenant_id, event.run_id), [])
            event = event.model_copy(update={"seq": len(log) + 1})
            log.append(event.model_dump_json())
            return event

    async def list_events(self, tenant_id: str, run_id: str, after: int = 0, limit: int = 500) -> list[RunEvent]:
        log = self._events.get((tenant_id, run_id), [])
        return [RunEvent.model_validate_json(e) for e in log[after : after + limit]]

    async def list_runs(self, tenant_id: str, status: RunStatus | None = None, limit: int = 50) -> list[RunRecord]:
        runs = [RunRecord.model_validate_json(d) for (t, _), d in self._runs.items() if t == tenant_id]
        if status:
            runs = [r for r in runs if r.status == status]
        return sorted(runs, key=lambda r: r.created_at, reverse=True)[:limit]

    async def count_active(self, tenant_id: str) -> int:
        return sum(1 for r in await self.list_runs(tenant_id, limit=10_000) if r.status in ACTIVE_RUN)

    async def list_active(self) -> list[RunRecord]:
        runs = [RunRecord.model_validate_json(d) for d in self._runs.values()]
        return [r for r in runs if r.status in ACTIVE_RUN]


class SqliteStore:
    _SCHEMA = """
    CREATE TABLE IF NOT EXISTS runs (
        tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, status TEXT NOT NULL, idem_key TEXT,
        created_at TEXT NOT NULL, doc TEXT NOT NULL,
        PRIMARY KEY (tenant_id, run_id)
    );
    CREATE UNIQUE INDEX IF NOT EXISTS runs_idem ON runs (tenant_id, idem_key) WHERE idem_key IS NOT NULL;
    CREATE INDEX IF NOT EXISTS runs_status ON runs (status);
    CREATE TABLE IF NOT EXISTS events (
        tenant_id TEXT NOT NULL, run_id TEXT NOT NULL, seq INTEGER NOT NULL, doc TEXT NOT NULL,
        PRIMARY KEY (tenant_id, run_id, seq)
    );
    """

    def __init__(self, path: str) -> None:
        self._db = sqlite3.connect(path, check_same_thread=False, isolation_level=None)
        self._db.execute("PRAGMA journal_mode=WAL")
        self._db.executescript(self._SCHEMA)
        self._lock = threading.Lock()

    def close(self) -> None:
        self._db.close()

    def _run(self, fn):
        def locked():
            with self._lock:
                return fn(self._db)

        return asyncio.to_thread(locked)

    async def create_run(self, run: RunRecord) -> tuple[RunRecord, bool]:
        doc = run.model_dump_json()

        def op(db: sqlite3.Connection):
            if run.idempotency_key:
                row = db.execute(
                    "SELECT doc FROM runs WHERE tenant_id=? AND idem_key=?", (run.tenant_id, run.idempotency_key)
                ).fetchone()
                if row:
                    return RunRecord.model_validate_json(row[0]), False
            db.execute(
                "INSERT INTO runs VALUES (?,?,?,?,?,?)",
                (run.tenant_id, run.run_id, run.status, run.idempotency_key, run.created_at.isoformat(), doc),
            )
            return run, True

        return await self._run(op)

    async def get_run(self, tenant_id: str, run_id: str) -> RunRecord | None:
        row = await self._run(
            lambda db: db.execute("SELECT doc FROM runs WHERE tenant_id=? AND run_id=?", (tenant_id, run_id)).fetchone()
        )
        return RunRecord.model_validate_json(row[0]) if row else None

    async def save_run(self, run: RunRecord) -> None:
        doc = run.model_dump_json()  # se serializa aquí: el hilo no debe leer un objeto que el bucle sigue mutando
        await self._run(
            lambda db: db.execute(
                "UPDATE runs SET status=?, doc=? WHERE tenant_id=? AND run_id=?",
                (run.status, doc, run.tenant_id, run.run_id),
            )
        )

    async def append_event(self, event: RunEvent) -> RunEvent:
        def op(db: sqlite3.Connection):
            seq = db.execute(
                "SELECT COALESCE(MAX(seq),0)+1 FROM events WHERE tenant_id=? AND run_id=?", (event.tenant_id, event.run_id)
            ).fetchone()[0]
            ev = event.model_copy(update={"seq": seq})
            db.execute("INSERT INTO events VALUES (?,?,?,?)", (ev.tenant_id, ev.run_id, seq, ev.model_dump_json()))
            return ev

        return await self._run(op)

    async def list_events(self, tenant_id: str, run_id: str, after: int = 0, limit: int = 500) -> list[RunEvent]:
        rows = await self._run(
            lambda db: db.execute(
                "SELECT doc FROM events WHERE tenant_id=? AND run_id=? AND seq>? ORDER BY seq LIMIT ?",
                (tenant_id, run_id, after, limit),
            ).fetchall()
        )
        return [RunEvent.model_validate_json(r[0]) for r in rows]

    async def list_runs(self, tenant_id: str, status: RunStatus | None = None, limit: int = 50) -> list[RunRecord]:
        sql = "SELECT doc FROM runs WHERE tenant_id=?" + (" AND status=?" if status else "")
        args = (tenant_id, status) if status else (tenant_id,)
        rows = await self._run(lambda db: db.execute(sql + " ORDER BY created_at DESC LIMIT ?", (*args, limit)).fetchall())
        return [RunRecord.model_validate_json(r[0]) for r in rows]

    async def count_active(self, tenant_id: str) -> int:
        marks = ",".join("?" * len(ACTIVE_RUN))
        row = await self._run(
            lambda db: db.execute(
                f"SELECT COUNT(*) FROM runs WHERE tenant_id=? AND status IN ({marks})", (tenant_id, *ACTIVE_RUN)
            ).fetchone()
        )
        return row[0]

    async def list_active(self) -> list[RunRecord]:
        marks = ",".join("?" * len(ACTIVE_RUN))
        rows = await self._run(
            lambda db: db.execute(f"SELECT doc FROM runs WHERE status IN ({marks})", tuple(ACTIVE_RUN)).fetchall()
        )
        return [RunRecord.model_validate_json(r[0]) for r in rows]

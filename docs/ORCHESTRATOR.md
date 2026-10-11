# Orquestador de workflows (Python / FastAPI)

Servicio `services/orchestrator` (paquete `nexusflow_engine`): ejecuta workflows empresariales de extremo a extremo
como **DAG de pasos** con **reintentos, rutas alternativas, compensación (saga) y trazabilidad por petición**.
Complementa al motor de automatizaciones de la API (`docs/WORKFLOW_ENGINE.md`, TypeScript): aquel orquesta las
automatizaciones del editor visual; éste orquesta las llamadas entre microservicios de «Segundo Cerebro».

```
cliente ──► API FastAPI ──► WorkflowEngine ──► tareas (registro) ──► servicios (HTTP)
 X-Request-Id   │  token + tenant     │  DAG por capas, reintentos,        ContextRAG, Consenso,
 X-Tenant-Id    │                     │  fallback, saga, cancelación       parser, escalación, entrega
                ▼                     ▼
            SSE / eventos        StateStore (SQLite | memoria | puerto para PostgreSQL)
```

## Estructura de módulos

| Módulo | Responsabilidad |
|---|---|
| `context.py` · `FlowContext` | `request_id` + `tenant_id` (+ `run_id`, `step_id`) en un `ContextVar`; `headers()` los propaga aguas abajo. Sanea ids entrantes. |
| `models.py` | Definición (`WorkflowDef`, `StepDef`, `RetryPolicy`) y estado (`RunRecord`, `StepRecord`, `RunEvent`). Datos puros serializables. |
| `dag.py` · `validate()` | Rechaza ciclos, dependencias rotas, fallbacks mal formados y tareas no registradas **antes de ejecutar**. |
| `registry.py` · `TaskRegistry`, `StepInput` | El workflow referencia tareas por nombre; el código las implementa. `StepInput` lleva ctx, entradas, intento y clave de idempotencia. |
| `errors.py` | `RetryableError` (503/timeout/429) · `PermanentError` · `RejectedError` (decisión del comité, no es fallo técnico). |
| `engine.py` · `WorkflowEngine` | Ejecución por capas en paralelo, reintentos con backoff, fallback, compensación, cancelación, reanudación. |
| `store.py` · `StateStore` | Puerto de persistencia + `InMemoryStore` y `SqliteStore` (sobrevive a reinicios). Toda lectura exige `tenant_id`. |
| `api.py` · `create_app()` | Rutas HTTP, autenticación de servicio, aislamiento por tenant, SSE. |
| `clients.py` | Adaptadores HTTP (mapean 429/5xx → reintento, 4xx → permanente; no reenvían cuerpos de error). |
| `rag_workflow.py` | Workflow de ejemplo, sus tareas y los puertos (`Protocol`) de los servicios. |
| `redact.py` | Elimina credenciales de eventos, errores y respuestas. |
| `demo.py` | `python -m nexusflow_engine.demo`: cuatro escenarios con su rastro de auditoría. |

## Rutas

Todas exigen `Authorization: Bearer <ORCHESTRATOR_TOKEN>` y `X-Tenant-Id`. `X-Request-Id` es opcional (se genera si falta o no es seguro) y se devuelve siempre.

| Ruta | Descripción |
|---|---|
| `POST /v1/workflows/{name}/runs` | Cuerpo `{"input": {...}}`. **202** + `run_id`; con `Idempotency-Key` repetida devuelve **200** y el mismo run. **429** si el tenant supera sus runs activos. |
| `GET /v1/runs` · `GET /v1/runs/{id}` | Listado (filtro `status`) y detalle con estado por paso, intentos, errores y salida. |
| `GET /v1/runs/{id}/events?after=N` | Auditoría append-only (`seq` creciente) con `request_id` y `tenant_id` en cada evento. |
| `GET /v1/runs/{id}/stream` | La misma auditoría en **tiempo real** (Server-Sent Events); termina cuando el run es terminal. |
| `POST /v1/runs/{id}/cancel` | Cancelación cooperativa + compensación. Idempotente. |
| `GET /v1/workflows` · `GET /healthz` | Catálogo y salud. |

Un run de otro tenant responde **404** (no 403): no se revela su existencia.

## Semántica

**Estados del run:** `PENDING → RUNNING → COMPLETED`, o `→ COMPENSATING → FAILED | COMPENSATED | COMPENSATION_FAILED | CANCELLED`.
`FAILED` = falló y no había nada que deshacer · `COMPENSATED` = falló y se deshicieron los efectos · `COMPENSATION_FAILED` = **requiere intervención humana**.

**Estados del paso:** `PENDING → RUNNING → COMPLETED | FALLBACK | FAILED | CANCELLED`.

**Reintentos.** Solo los `RetryableError` se reintentan: `base · 2^(n-1)` acotado por `backoff_max_s`, con jitter, respetando `Retry-After`. Cada intento tiene `timeout_s` (`asyncio.timeout`); un timeout cuenta como transitorio. Una excepción no tipificada es permanente (no se reintenta a ciegas).

**Rutas alternativas.** `StepDef.fallback` apunta a un paso `fallback_only`. Si el principal falla definitivamente (reintentos agotados o error permanente), se ejecuta el alternativo con las mismas entradas más `failure` (tipo, mensaje, `details`); **su salida sustituye a la del paso** (estado `FALLBACK`) y el DAG sigue. Sin fallback —o si éste también falla— el run pasa a compensar.

**Compensación (saga).** `StepDef.compensate` nombra la tarea que deshace el paso. Se ejecuta en **orden inverso de finalización**, con 3 intentos, y continúa aunque una falle. Se compensan los pasos con efecto confirmado (`COMPLETED`) o de resultado desconocido (cancelados en vuelo o con fallo transitorio, p. ej. timeout tras enviar la petición); no los rechazos permanentes. Las compensaciones **deben ser idempotentes** y tolerar «no hay nada que deshacer».

**Idempotencia.** Cada paso recibe `Idempotency-Key = run_id:paso` (y `…:compensate`), estable entre reintentos y reanudaciones: el servicio externo puede deduplicar. El inicio del run también es idempotente por `(tenant, Idempotency-Key)`.

**Reanudación.** Cada transición se persiste antes de continuar. `recover()` (se invoca al arrancar) reanuda los runs que un proceso anterior dejó a medias: los pasos `COMPLETED` **no se repiten** (checkpoint) y el que estaba en vuelo se reintenta con la misma clave. Un apagado ordenado (`shutdown()`) no marca nada como cancelado.

## Trazabilidad

`X-Request-Id` (generado o saneado: `[A-Za-z0-9._:-]{1,128}`, nunca se refleja un valor hostil) y `tenant_id` se fijan al recibir la petición y viajan en: cada **evento** de auditoría, cada **línea de log** (JSON), las **cabeceras de las llamadas salientes** (`X-Request-Id`, `X-Tenant-Id`, `X-Run-Id`, `X-Step-Id`, `Idempotency-Key`) y los **errores HTTP**. Eventos: `run.created/started/resumed/cancel_requested/compensating/completed/failed/compensated/compensation_failed/cancelled`, `step.started/retry/failed/fallback/completed/cancelled`, `compensation.started/completed/failed`.

## Ejemplo: consulta RAG validada por agentes (`rag_validated_query`)

```
ingest ──► retrieve ──► consensus ──► respond
              │ 503 persistente    │ rechazo o comité caído
              ▼                    ▼
       retrieve_lexical       escalate_human      (rutas alternativas)
```

| Paso | Tarea | Reintentos | Alternativa | Compensación |
|---|---|---|---|---|
| `ingest` | parseo/ingesta de documentos | 3 | — | `unstage` de los documentos |
| `retrieve` | ContextRAG (borrador + pasajes) | 4 | `retrieve_lexical` (búsqueda léxica degradada) | — |
| `consensus` | comité MultiAgent_Consensus | 2 (solo transitorios) | `escalate_human` (revisión humana) | — |
| `escalate_human` | abre ticket de revisión | 3 | — | cierra el ticket |
| `respond` | respuesta final al cliente | 3 | — | — |

Invariante **fail-closed**: al cliente nunca llega un borrador que el comité no aprobó; si rechaza o no responde, la respuesta es «pendiente de revisión humana» sin el texto del borrador.

```bash
curl -sS -X POST http://localhost:8002/v1/workflows/rag_validated_query/runs \
  -H "Authorization: Bearer $ORCHESTRATOR_TOKEN" -H "X-Tenant-Id: acme" \
  -H "X-Request-Id: req-2026-0001" -H "Idempotency-Key: consulta-0001" \
  -d '{"input": {"question": "¿Plazo de devolución?", "documents": [{"name": "politica.pdf"}]}}'
# → {"run_id":"…","status":"PENDING","request_id":"req-2026-0001","created":true}
curl -N http://localhost:8002/v1/runs/$RUN_ID/stream -H "Authorization: Bearer $ORCHESTRATOR_TOKEN" -H "X-Tenant-Id: acme"
```

Para añadir un workflow: registrar sus tareas en un `TaskRegistry`, declarar el `WorkflowDef` (datos) y pasarlo a `WorkflowEngine`.

## Configuración

`ORCHESTRATOR_TOKEN` (≥32 car.), `ORCHESTRATOR_DB` (ruta SQLite), `CONTEXT_RAG_URL`, `CONSENSUS_URL`, `DOCUMENT_PARSER_URL`, `ESCALATION_URL`, `DELIVERY_URL`, `DOWNSTREAM_TOKEN` (opcional), `MAX_ACTIVE_RUNS_PER_TENANT` (20).

## Qué está probado

43 pruebas (`cd services/orchestrator && pytest`; también en CI, job `orchestrator`). Se comprobó además que fallan al introducir a propósito tres regresiones (compensación en orden directo, reintento de errores permanentes, marcar `CANCELLED` al apagar).

| Garantía | Prueba |
|---|---|
| Ciclos, dependencias rotas, fallbacks inválidos, tareas no registradas | `test_dag_*`, `test_engine_refuses_…` |
| Traza en eventos y en llamadas salientes | `test_happy_path_and_trace_propagation`, `test_full_run_through_http_…` |
| Backoff exponencial y `Retry-After` | `test_transient_503_…`, `test_retry_after_…` |
| 503 persistente → ruta léxica | `test_persistent_rag_503_…` |
| Rechazo del comité → revisión humana sin filtrar el borrador | `test_committee_rejection_…`, `test_committee_outage_…` |
| Compensación inversa, reintentada, sin bloquear al resto | `test_compensation_*`, `test_failed_compensation_…` |
| Cancelación en vuelo + compensación | `test_cancel_stops_in_flight_…` |
| Paralelismo de ramas independientes, timeouts | `test_independent_steps_…`, `test_step_timeout_…` |
| Reanudación tras reinicio sin repetir pasos | `test_run_survives_restart_…` (SQLite real) |
| Idempotencia, cupo por tenant (429) | `test_start_is_idempotent_…`, `test_active_run_limit_…` |
| Aislamiento entre tenants, token, ids saneados, secretos redactados, SSE | `tests/test_api.py` |
| Mapeo HTTP→error, propagación de cabeceras | `tests/test_clients.py` |

## Límites conocidos (decisiones pendientes)

- **Un proceso por run.** No hay *lease* entre réplicas: ejecutar dos instancias sobre la misma base podría conducir un run dos veces. Hoy: un solo worker (`Dockerfile`). Para escalar, replicar el patrón del motor TypeScript (heartbeat + `SELECT … FOR UPDATE` con generación) sobre PostgreSQL implementando `StateStore`.
- **`SqliteStore`** es un fichero local: válido para un nodo; para producción multinodo, `StateStore` está pensado para un `PostgresStore`.
- **Contratos de los servicios aguas abajo supuestos** (`/v1/parse`, `/v1/retrieve`, `/v1/consensus`, `/v1/escalations`, `/v1/responses`): se ajustan solo en `clients.py` cuando se conozcan los reales.
- **El `tenant_id` lo fija el gateway** que ya autenticó al usuario; este servicio solo valida el token de servicio. No debe exponerse a internet.
- **El DAG es acíclico y sin condiciones**: no hay bucles (p. ej. «regenerar y volver a validar») ni ramas `if`; la alternativa es el fallback de un solo nivel.
- Sin métricas Prometheus ni límites de memoria por tarea (solo tiempo, tamaño de salida y concurrencia).
